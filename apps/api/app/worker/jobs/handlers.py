"""Обработчики внутреннего контракта contracts/jobs.md."""

import asyncio
import json
import random
from collections import defaultdict
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from evalcore.models import EvalContext  # type: ignore[import-untyped]
from evalcore.scoring import evaluate  # type: ignore[import-untyped]
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
from app.core.spelling import for_scenario
from app.worker.generators import build_scenario
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
        return await handler(db, payload)

    async def handle_generate(self, db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        pack_id = UUID(str(required(payload, "pack_id")))
        count = int(required(payload, "count"))
        level = int(required(payload, "level"))
        service_id = str(required(payload, "service_id"))
        seed = int(required(payload, "seed"))
        if not 1 <= count <= 100 or not 1 <= level <= 4:
            raise JobPayloadError("Недопустимые параметры генерации.")
        existing_items = list(
            (
                await db.scalars(
                    select(ScenarioPackItem)
                    .where(ScenarioPackItem.pack_id == pack_id)
                    .order_by(ScenarioPackItem.order)
                )
            ).all()
        )
        if existing_items:
            return {"scenario_ids": [str(item.scenario_id) for item in existing_items]}
        sources = list(
            (
                await db.scalars(
                    select(Scenario)
                    .where(
                        Scenario.target_service_id == service_id,
                        Scenario.status == "approved",
                    )
                    .order_by(Scenario.id)
                )
            ).all()
        )
        if not sources:
            raise JobPayloadError("Нет утверждённых шаблонов для выбранной службы.")
        pack = await db.get(ScenarioPack, pack_id)
        author_id = pack.created_by if pack is not None else None
        if pack is None:
            pack = ScenarioPack(
                id=pack_id,
                title=f"Сгенерированный пакет (seed {seed})",
                status="draft",
                origin="template" if self.llm.name == "off" else "llm",
                created_by=author_id,
            )
            db.add(pack)
        rng = random.Random(seed)
        scenario_ids: list[str] = []
        for order in range(1, count + 1):
            source = sources[rng.randrange(len(sources))]
            template: dict[str, Any] = {
                "level": level,
                "weight": max(1, min(10, source.weight + level - source.level)),
                "incident_type_code": source.incident_type_code,
                "target_service_id": service_id,
                "card": source.card,
                "reference": source.reference,
                "complications": source.complications,
            }
            built = await build_scenario(
                level=level,
                service_id=service_id,
                seed=seed + order - 1,
                template=template,
            )
            # MVP-STUB до T-026: копия утверждённого шаблона остаётся явно отличимой
            # по teacher_comment и не выдаётся за результат конструктора evalcore.
            value = built or template
            card = dict(value["card"])
            facts = {
                "incident_type_code": card.get("incident_type_code"),
                "incident_class": card.get("incident_class"),
                "address": card.get("address"),
                "victims": card.get("victims"),
                "ambulance_refused": card.get("ambulance_refused"),
                "blocked_people": card.get("blocked_people"),
                "emergency": card.get("emergency"),
                "complications": value["complications"],
            }
            narrative = await self.llm.complete_json(
                json.dumps(facts, ensure_ascii=False, sort_keys=True)
            )
            if narrative is not None:
                if isinstance(narrative.get("description"), str):
                    card["description"] = narrative["description"]
                if isinstance(narrative.get("tags"), list):
                    card["tags"] = [str(item) for item in narrative["tags"]]
                elif isinstance(narrative.get("fixture"), str):
                    card["tags"] = [*card.get("tags", []), f"mock-{narrative['fixture']}"]
            generated = Scenario(
                id=uuid4(),
                version=1,
                level=int(value["level"]),
                weight=int(value["weight"]),
                incident_type_code=str(value["incident_type_code"]),
                target_service_id=str(value["target_service_id"]),
                card=card,
                reference=value["reference"],
                complications=value["complications"],
                origin="template" if self.llm.name == "off" else "llm",
                status="draft",
                author_id=author_id,
                teacher_comment=(
                    "Создано evalcore.scenario; требуется проверка преподавателя."
                    if built is not None
                    else "MVP-STUB: копия шаблона до T-026; требуется проверка преподавателя."
                ),
            )
            db.add(generated)
            await db.flush()
            db.add(ScenarioPackItem(pack_id=pack_id, scenario_id=generated.id, order=order))
            scenario_ids.append(str(generated.id))
        return {"scenario_ids": scenario_ids}

    async def handle_evaluate(self, db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        from app.api.evaluations.service import planned_messages

        card_id = UUID(str(required(payload, "card_id")))
        evaluation_id = UUID(str(required(payload, "evaluation_id")))
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
            evaluation.rules_scores = {item.key: item.score for item in result.criteria}
            evaluation.total = result.total
            evaluation.critical_flags = result.critical_flags
            evaluation.explanation = pack_explanations(result.criteria)
            evaluation.model_info = {
                **evaluation.model_info,
                "rules": "evalcore",
                "embeddings": self.embeddings.name,
            }
            # Генератор нарратива не проверяет ответ обучаемого: ИИ-слой — отдельный судья.
            cap = float(lesson.settings_snapshot.get("critical_cap", 0.5))
            judged = await apply_judge(db, self.judge, evaluation, card, scenario, cap)
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
            for key, value in row.rules_scores.items():
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
