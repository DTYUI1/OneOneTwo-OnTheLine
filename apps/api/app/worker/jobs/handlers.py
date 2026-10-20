"""Обработчики внутреннего контракта contracts/jobs.md."""

import asyncio
from collections import defaultdict
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5

from evalcore.models import EvalContext  # type: ignore[import-untyped]
from evalcore.scoring import SCORING_VERSION, evaluate  # type: ignore[import-untyped]
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.notifications import notify
from app.core.evaluation_details import call_context, pack_explanations
from app.core.models import (
    Assignment,
    Call,
    Card,
    CardEvent,
    Evaluation,
    RoutingRule,
    Scenario,
    ScenarioPack,
    ScenarioPackItem,
    Session,
    Street,
)
from app.core.report_completion import REPORT_COMPLETION_VERSION, apply_report_completion
from app.core.scored_criteria import applied_scores
from app.core.spelling import for_scenario
from app.worker.generators.storage import generate_one
from app.worker.judging import apply_judge
from app.worker.providers.interfaces import (
    EmbeddingsProvider,
    LLMProvider,
    STTProvider,
    TTSProvider,
)
from app.worker.providers.judge import CommentJudge, NullJudge


class JobPayloadError(ValueError):
    pass


def required(payload: dict[str, Any], name: str) -> Any:
    if name not in payload:
        raise JobPayloadError(f"В payload отсутствует поле {name}.")
    return payload[name]


async def transcode_audio(source: Path, output_dir: Path, call_id: UUID) -> tuple[Path, Path]:
    """Создать нормализованный PCM WAV для STT и MP3 для прослушивания."""
    if not source.is_file():
        raise JobPayloadError("Запись звонка отсутствует.")
    output_dir.mkdir(parents=True, exist_ok=True)
    # Суффикс .pcm.wav: исходная запись может сама быть WAV в том же каталоге, и
    # ffmpeg отказывается писать вывод поверх своего же входа (одинаковое имя).
    wav = output_dir / f"{call_id}.pcm.wav"
    mp3 = output_dir / f"{call_id}.mp3"
    for command in (
        (
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(source),
            "-ac",
            "1",
            "-ar",
            "16000",
            str(wav),
        ),
        (
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(wav),
            "-codec:a",
            "libmp3lame",
            "-q:a",
            "4",
            str(mp3),
        ),
    ):
        try:
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("ffmpeg не установлен в worker.") from exc
        _, stderr = await process.communicate()
        if process.returncode:
            raise RuntimeError("Не удалось преобразовать аудиозапись.") from RuntimeError(
                stderr.decode("utf-8", errors="replace")[:200]
            )
    return wav, mp3


class JobHandlers:
    def __init__(
        self,
        *,
        llm: LLMProvider,
        embeddings: EmbeddingsProvider,
        stt: STTProvider,
        tts: TTSProvider,
        audio_dir: Path,
        judge: CommentJudge | None = None,
    ) -> None:
        self.llm = llm
        # ИИ-судья комментария (C-06); без него слой llm не выполнен и оценка partial.
        self.judge: CommentJudge = judge or NullJudge()
        self.embeddings = embeddings
        self.stt = stt
        self.tts = tts
        self.audio_dir = audio_dir

    async def run(self, db: AsyncSession, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        handler = getattr(self, f"handle_{kind}", None)
        if handler is None:
            raise JobPayloadError("Неизвестный вид задания.")
        if kind in {"generate", "evaluate"}:
            await self.use_active_model(db)
        return await handler(db, payload)

    async def use_active_model(self, db: AsyncSession) -> None:
        """Модель и режим, выбранные администратором (HQ-016), — пресет роутера llama.cpp.

        Роутер загружает модель по имени из запроса; в оценке и метаданных генерации
        сохраняется фактическая модель. Без роутера (одна модель) имя игнорируется.
        """
        from app.api.ai_models.service import active_choice, effective, router_statuses
        from app.worker.providers.judge.local_llamacpp import LocalLlamaJudge
        from app.worker.providers.llm.local_llamacpp import LocalLlamaCpp

        choice = await active_choice(db)
        # Видеокарта не загрузила модель — работаем на процессоре, занятие не ломается.
        base_url = getattr(self.llm, "base_url", "")
        statuses = await router_statuses(base_url) if choice["mode"] == "gpu" and base_url else None
        name, _ = effective(choice, statuses)
        for provider in (self.llm, self.judge):
            if isinstance(provider, LocalLlamaCpp | LocalLlamaJudge):
                provider.model, provider.name = name, f"local:{name}"

    async def handle_generate(self, db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get("previous_scenario_id"):
            from app.api.content.correction import apply

            return await apply(db, self.llm, payload)
        pack_id = UUID(str(required(payload, "pack_id")))
        count = int(required(payload, "count"))
        level = int(required(payload, "level"))
        service_id = str(required(payload, "service_id"))
        seed = int(required(payload, "seed"))
        if not 1 <= count <= 100 or not 1 <= level <= 4:
            raise JobPayloadError("Недопустимые параметры генерации.")
        pack = await db.get(ScenarioPack, pack_id, with_for_update=True)
        if pack is None or pack.created_by is None:
            raise JobPayloadError("Нужен пакет, созданный преподавателем.")
        existing = {
            item.order: item.scenario_id
            for item in await db.scalars(
                select(ScenarioPackItem).where(ScenarioPackItem.pack_id == pack_id)
            )
        }
        auto_admit = payload.get("auto_admit") is True
        items = payload.get("items")
        if items is not None and (not isinstance(items, list) or len(items) != count):
            raise JobPayloadError("Состав генерации не соответствует объёму занятия.")
        for order in range(1, count + 1):
            if order in existing:
                continue
            parameters = (
                items[order - 1]
                if items is not None
                else {
                    "service_id": service_id,
                    "level": level,
                    "seed": seed + order - 1,
                }
            )
            scenario = await generate_one(
                db,
                self.llm,
                scenario_id=uuid5(pack_id, f"scenario:{order}"),
                author_id=pack.created_by,
                service_id=parameters["service_id"],
                level=parameters["level"],
                seed=parameters["seed"],
                auto_admit=auto_admit,
                weight=parameters.get("weight"),
                weak_spots=parameters.get("weak_spots"),
                focus=parameters.get("focus"),
                pairwise_batch=True,
                categories=payload.get("categories", []),
                session_id=UUID(payload["session_id"]) if payload.get("session_id") else None,
                participant_id=UUID(parameters["participant_id"]) if items else None,
                selected_ids=tuple(
                    sid
                    for position, sid in existing.items()
                    if not items
                    or items[position - 1]["participant_id"] == parameters["participant_id"]
                ),
            )
            db.add(ScenarioPackItem(pack_id=pack_id, scenario_id=scenario.id, order=order))
            existing[order] = scenario.id
            # Одна ограниченная порция — один новый сценарий. Worker фиксирует её
            # и возвращает пакет в очередь, чтобы оценка получила общий ИИ между ними.
            break
        await db.flush()
        scenarios = list(
            await db.scalars(select(Scenario).where(Scenario.id.in_(existing.values())))
        )
        fallback_count = sum(item.origin != "llm" for item in scenarios)
        pack.origin = "template" if fallback_count else "llm"
        complete = len(existing) == count
        pack.status = "approved" if auto_admit and complete else "draft"
        scenario_ids = [str(existing[order]) for order in sorted(existing)]
        if complete and payload.get("trainee_login"):
            from app.worker.generators.personalization import summary

            pack.title = summary(payload["trainee_login"], scenarios)
        from app.core.models import Job, JobCancellation

        stopping = await db.scalar(
            select(JobCancellation.job_id)
            .join(Job, Job.id == JobCancellation.job_id)
            .where(Job.payload["pack_id"].astext == str(pack_id))
            .limit(1)
        )
        if payload.get("session_id") and not stopping:
            from app.api.sessions.preparation import (
                finalize_preparation,
                update_preparation_progress,
            )

            if complete:
                await finalize_preparation(db, payload, scenario_ids, fallback_count)
            else:
                await update_preparation_progress(db, payload, len(existing), fallback_count)
        return {
            "scenario_ids": scenario_ids,
            "fallback_count": fallback_count,
            "complete": complete,
        }

    async def handle_evaluate(self, db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        from app.api.evaluations.service import conversation_lines, planned_messages
        from app.api.training.briefing import evaluation_briefings
        from app.api.training.brigades import card_brigade_numbers
        from app.api.training.scenario_events import evaluation_events

        card_id = UUID(str(required(payload, "card_id")))
        evaluation_id = UUID(str(required(payload, "evaluation_id")))
        # Тот же порядок, что у позднего отбоя: Card → Evaluation. UPDATE оценки
        # может проверять FK карточки; обратный порядок даёт deadlock с HTTP.
        await db.scalar(select(Card.id).where(Card.id == card_id).with_for_update())
        evaluation = await db.get(Evaluation, evaluation_id, with_for_update=True)
        if evaluation is None or evaluation.card_id != card_id:
            raise JobPayloadError("Оценка не найдена или не относится к карточке.")
        row = (
            await db.execute(
                select(Card, Assignment, Scenario, Session)
                .join(Assignment, Assignment.id == Card.assignment_id)
                .join(Scenario, Scenario.id == Assignment.scenario_id)
                .join(Session, Session.id == Assignment.session_id)
                .where(Card.id == card_id)
            )
        ).one_or_none()
        if row is None:
            raise JobPayloadError("Карточка не найдена.")
        card, assignment, scenario, lesson = row
        events = list(
            (
                await db.scalars(
                    select(CardEvent)
                    .where(CardEvent.card_id == card_id)
                    .order_by(CardEvent.server_ts, CardEvent.id)
                )
            ).all()
        )
        calls = list((await db.scalars(select(Call).where(Call.card_id == card_id))).all())
        streets = tuple((await db.scalars(select(Street.name))).all())
        routing = list((await db.scalars(select(RoutingRule))).all())
        context = EvalContext(
            scenario={
                "id": str(scenario.id),
                "version": scenario.version,
                "level": scenario.level,
                "weight": scenario.weight,
                "incident_type_code": scenario.incident_type_code,
                "target_service_id": scenario.target_service_id,
                "card": scenario.card,
                "reference": scenario.reference,
                "complications": scenario.complications,
            },
            current=card.current,
            events=[
                {
                    "client_event_id": str(item.client_event_id),
                    "client_ts": item.client_ts.isoformat(),
                    "server_ts": item.server_ts.isoformat(),
                    "clock_offset_ms": item.clock_offset_ms,
                    "type": item.type,
                    "payload": item.payload,
                }
                for item in events
            ],
            calls=[call_context(item) for item in calls],
            settings=lesson.settings_snapshot,
            streets=streets,
            text_checker=for_scenario(streets, scenario.card, scenario.reference),
            routing_rules=tuple(
                {
                    "incident_type_code": item.incident_type_code,
                    "service_id": item.service_id,
                    "condition": item.condition,
                    "payload": item.payload,
                }
                for item in routing
            ),
            planned_messages=await planned_messages(db, card, assignment, scenario),
            scenario_events=await evaluation_events(db, card),
            briefings=await evaluation_briefings(db, card.id),
            lines=await conversation_lines(db, card),
            brigade_numbers=await card_brigade_numbers(db, card.id),
        )
        # V-01: время — по той же методике занятия, что разбор попытки и API-оценка.
        from app.api.analysis.service import card_timing

        timing = await card_timing(db, card, lesson)
        try:
            result = evaluate(context, timing=timing)
        except NotImplementedError:
            # MVP-STUB evalcore T-006: уже записанная API rules-оценка остаётся источником правды.
            evaluation.model_info = {
                **evaluation.model_info,
                "embeddings": self.embeddings.name,
                "llm": self.llm.name,
            }
            evaluation.status = "partial"
        else:
            result, completion_factor = apply_report_completion(result, context, card.state)
            evaluation.rules_scores = {item.key: item.score for item in result.criteria}
            evaluation.total = result.total
            evaluation.critical_flags = result.critical_flags
            evaluation.explanation = pack_explanations(result.criteria)
            evaluation.model_info = {
                **evaluation.model_info,
                "rules": SCORING_VERSION,
                "embeddings": self.embeddings.name,
                "report_completion": REPORT_COMPLETION_VERSION,
                "report_completion_factor": str(completion_factor),
            }
            # Генератор нарратива не проверяет ответ обучаемого: ИИ-слой — отдельный судья.
            cap = float(lesson.settings_snapshot.get("critical_cap", 0.5))
            if completion_factor:
                judged = await apply_judge(
                    db,
                    self.judge,
                    evaluation,
                    card,
                    scenario,
                    cap,
                    completion_factor=completion_factor,
                )
            else:
                # Ноль за невыполненную работу окончателен и не требует запроса к модели.
                evaluation.semantic_scores = None
                evaluation.llm_scores = None
                evaluation.model_info = {
                    **evaluation.model_info,
                    "semantic": "not-applicable",
                    "llm": "rule:no-reports",
                }
                judged = True
            evaluation.status = "complete" if judged else "partial"
        await notify(
            db,
            "evaluation.complete" if evaluation.status == "complete" else "evaluation.partial",
            evaluation.id,
        )
        return {"evaluation_id": str(evaluation.id), "version": evaluation.version}

    async def handle_insights(self, db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        session_id = UUID(str(required(payload, "session_id")))
        rows = list(
            (
                await db.scalars(
                    select(Evaluation)
                    .join(Card, Card.id == Evaluation.card_id)
                    .join(Assignment, Assignment.id == Card.assignment_id)
                    .where(Assignment.session_id == session_id)
                )
            ).all()
        )
        values: dict[str, list[float]] = defaultdict(list)
        for row in rows:
            for key, value in applied_scores(row.rules_scores, row.explanation).items():
                values[key].append(float(value))
        weakest = sorted(values, key=lambda key: (sum(values[key]) / len(values[key]), key))[:3]
        explanation = (
            "Недостаточно завершённых карточек для группового анализа."
            if not weakest
            else "Слабейшие критерии определены по среднему нормированному баллу группы."
        )
        return {"weakest_criteria": weakest, "explanation": explanation}

    async def handle_transcribe(self, db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        call_id = UUID(str(required(payload, "call_id")))
        call = await db.get(Call, call_id, with_for_update=True)
        if call is None or call.audio_path is None:
            raise JobPayloadError("Запись звонка не найдена.")
        wav, mp3 = await transcode_audio(Path(call.audio_path), self.audio_dir, call.id)
        transcript = await self.stt.transcribe(wav)
        call.audio_path = str(mp3)
        call.transcript = transcript
        await notify(db, "call.state", call.id)
        return {"call_id": str(call.id), "transcript": transcript, "provider": self.stt.name}

    async def handle_tts(self, db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        relative_path, duration_ms = await self.tts.resolve(
            str(required(payload, "voice_profile")), str(required(payload, "phrase_id"))
        )
        return {"relative_path": relative_path, "duration_ms": duration_ms}
