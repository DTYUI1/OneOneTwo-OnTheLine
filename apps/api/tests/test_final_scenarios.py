"""GP-08: сценарии на финал (docs/dds_gameplay.md, раздел 8; рекомендации 16.10, п. 8).

Каждый сценарий проходится через API до закрытия карточки: эталонный путь — разбор без
ошибок, одна ветка ошибки — ожидаемая строка разбора. Бытовой сценарий ЖКХ — со звонком
заявителю по телефону ДДС: номер заявителя есть в списке преподавателя.

Диспетчер остаётся на связи с бригадой от вводной до последнего доклада: реплики идут в тот
же разговор, а «молчание» бригады (событие `no_contact`) не срабатывает — тик worker можно
сдвигать вперёд вместо ожидания пауз плана. Реплика события ждёт своего `after_s` по-настоящему:
действие раньше срабатывания событию не засчитывается.
"""

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import pytest
from app.api.database import create_database_app
from app.api.sessions.practice import step_pool
from app.core.config import ROOT
from app.core.contracts import validate_json
from app.core.models import Evaluation
from app.seed.scenarios import SCENARIOS_DIR, read_file, scenario_uuid
from evalcore.progress import step_by_number  # type: ignore[import-untyped]
from fastapi.testclient import TestClient
from sqlalchemy import select

from . import test_c03_sessions as c03
from .briefing_helpers import briefing_payload
from .test_brigade_always_reports import CASE_01
from .test_c04_completion import seed_training
from .test_lifecycle import login, run_db
from .test_practice_gating import send, worker_tick

# Сценарий → служба обучаемого и его учётная запись (data/seed/demo_users.json).
FINAL = {
    "smoke-apartment-101-1": ("101", "trainee02"),
    "traffic-blocked-102-2": ("102", "trainee01"),
    "unwell-street-103-2": ("103", "trainee04"),
    "gas-entrance-104-2": ("104", "trainee05"),
    "not-ours-pipe-104-2": ("104", "trainee05"),
}
# Бытовой сценарий ЖКХ (рекомендации 16.10, п. 8): обучаемых ЖКХ в демо нет — место
# занятия отдаётся обучаемому другой службы.
HOUSEHOLD = "animal-shaft-gkh-1"
SEATS = {**FINAL, HOUSEHOLD: ("GKH", "trainee03")}
NOT_OURS = "not-ours-pipe-104-2"
# Заявитель в телефоне ДДС ЖКХ: его включает преподаватель, номер карточки — его номер.
CALLER = {"role": "caller", "name": "Заявитель", "number": "458"}
WITH_CALLER = [
    {"role": "head", "name": "Руководитель организации", "number": "401"},
    CALLER,
]
FULL_REPORT = {
    "report_choices": ["full"],
    "report_modes": ["voice"],
    "report_parts": [["who", "address", "card", "change"]],
}
STEPS = ("who", "address", "what", "people", "decision")
SERVICES = {item["id"] for item in json.loads((ROOT / "data/phonebook.json").read_text("utf-8"))}


def scenario_file(code: str) -> dict[str, Any]:
    return json.loads((SCENARIOS_DIR / f"{code}.json").read_text(encoding="utf-8"))


def line_text(line: str | dict[str, Any]) -> str:
    return line if isinstance(line, str) else str(line["text"])


@dataclass
class Shift:
    """Занятие одного обучаемого с одним сценарием; действия — как у окна телефона ДДС."""

    client: TestClient
    headers: dict[str, str]
    url: str
    data: dict[str, Any]
    card: dict[str, Any]
    service: str
    call_id: str = ""

    @property
    def card_id(self) -> str:
        return str(self.card["id"])

    def message_id(self, name: str) -> str:
        return str(uuid5(scenario_uuid(self.data), name))

    def send(self, kind: str, payload: dict[str, Any], expected: int = 200) -> Any:
        return send(self.client, self.headers, self.card_id, kind, payload, expected)

    def messages(self) -> list[dict[str, Any]]:
        body = self.client.get(f"/api/cards/{self.card_id}/training").json()
        validate_json(body, "urn:openapi#/components/schemas/CardTraining")
        return list(body["messages"])

    def status(self, state: str, comment: str, expected: int = 200) -> None:
        self.send("status_change", {"state": state, "comment": comment}, expected)

    def open(self) -> None:
        self.send("deliver", {})
        self.send("open", {})
        # «Номер наряда» — прямой номер бригады, которой позвонит `brief` (оценка его сверяет).
        target = str(uuid5(NAMESPACE_URL, f"arm112:c04:{self.service}:target:0"))
        targets = self.client.get(f"/api/services/{self.service}/call-targets").json()
        number = next(item["phone_ext"] for item in targets if item["id"] == target)
        self.send("field_change", {"field": "service_number", "value": number})

    def accept(self) -> None:
        """«Принята»: что случилось, пострадавшие, кого высылаю (эталон, раздел 3)."""
        source = self.card["source"]
        victims = "Есть пострадавшие." if source["victims"] else "Пострадавших нет."
        self.status(
            "accepted",
            f"Принята: {source['incident_class']}. {source['description']} {victims} "
            "Высылаю бригаду.",
        )

    def brief(self) -> None:
        """Звонок свободной бригаде и вводная (GP-05): доклад о выезде — в этом разговоре."""
        brigade = uuid5(NAMESPACE_URL, f"arm112:c04:{self.service}:brigade:0")
        target = uuid5(NAMESPACE_URL, f"arm112:c04:{self.service}:target:0")
        self.call_id = str(uuid4())
        self.send(
            "call_dial_target",
            {"call_id": self.call_id, "call_target_id": str(target), "brigade_id": str(brigade)},
        )
        self.send("call_answer", {"call_id": self.call_id})
        self.send("brigade_briefing", briefing_payload(self.card, self.call_id))

    def hear(self, names: list[str], ahead_s: float = 0) -> dict[str, Any]:
        """Реплика выдана в разговор (тик worker через `ahead_s`) и прозвучала.

        Как окно телефона: всё, что бригада выдала раньше, звучит по порядку выдачи — пока
        бригада ждёт, что её реплику услышат, следующую она не говорит (очередь, `turns`)."""
        wanted = {self.message_id(name) for name in names}
        item = None
        # Несколько тиков: событие, его страховочная реплика и доклад идут друг за другом.
        for _ in range(5):
            for pending in self.pending():
                self.present(pending)
            item = next(
                (m for m in self.messages() if m["delivery"]["message"]["id"] in wanted), None
            )
            if item is not None:
                break
            worker_tick(self.url, datetime.now(UTC) + timedelta(seconds=ahead_s))
        assert item is not None, f"{self.data['code']}: не прозвучало {names}"
        if item["state"] != "presented":
            self.present(item)
        return item

    def pending(self) -> list[dict[str, Any]]:
        """Выданные, но не прозвучавшие реплики — в порядке выдачи."""
        items = [m for m in self.messages() if m["state"] != "presented"]
        return sorted(items, key=lambda m: m["delivery"]["delivered_at"])

    def present(self, item: dict[str, Any]) -> None:
        delivery = item["delivery"]
        self.send(
            "message_presented",
            {
                "delivery_id": delivery["delivery_id"],
                "message_version": delivery["message"]["version"],
                "playback_id": str(uuid4()),
                "channel": "text",
                "audio_version": None,
            },
        )

    def reply(self, item: dict[str, Any], option_key: str) -> None:
        delivery = item["delivery"]
        self.send(
            "brigade_reply",
            {
                "call_id": delivery["call_id"],
                "delivery_id": delivery["delivery_id"],
                "option_key": option_key,
            },
        )

    def dial(self, phone_ext: str, expected: int = 200) -> None:
        """Звонок в службу или абоненту телефона ДДС: полный доклад голосом и отбой."""
        call_id = str(uuid4())
        self.send("call_dial", {"call_id": call_id, "phone_ext": phone_ext}, expected)
        if expected == 200:
            self.send("call_answer", {"call_id": call_id})
            self.send("call_hangup", {"call_id": call_id, **FULL_REPORT})

    def outcome(self) -> dict[str, Any] | None:
        """Исход сценария из CardTraining (отдаётся только после закрытия карточки)."""
        body = self.client.get(f"/api/cards/{self.card_id}/training").json()
        validate_json(body, "urn:openapi#/components/schemas/CardTraining")
        return body.get("outcome")

    def hang_up(self) -> None:
        self.send("call_hangup", {"call_id": self.call_id})

    def evaluation(self) -> Evaluation:
        async def load(db):
            return await db.scalar(
                select(Evaluation).where(Evaluation.card_id == UUID(self.card_id))
            )

        found = run_db(self.url, load)
        assert found is not None, f"{self.data['code']}: карточка не закрыта"
        return found


def open_shift(
    database_config, url: str, request, code: str, contacts: list[dict] | None = None
) -> Shift:
    """Преподаватель выдаёт сценарий обучаемому и начинает занятие; карточка на АРМ."""
    data = scenario_file(code)
    service, trainee = SEATS[code]
    with TestClient(create_database_app(database_config)) as teacher:
        headers = login(teacher)
        users = {u["login"]: u for u in teacher.get("/api/users").json()}
        settings = teacher.get("/api/settings").json()
        if contacts is not None:
            settings["phone_contacts"] = {service: contacts}
        created = teacher.post(
            "/api/sessions",
            headers=headers,
            json={
                "title": f"Сценарий на финал {code}",
                "participants": [
                    {
                        "user_id": users[trainee]["id"],
                        "workstation_number": 17,
                        "dds_service_id": service,
                        "level": data["level"],
                    }
                ],
                "settings_snapshot": settings,
            },
        )
        assert created.status_code == 201, created.text
        session_id = created.json()["id"]

        def finish() -> None:
            # Идущее занятие обучаемого мешает соседним тестам: завершаем всегда.
            with TestClient(create_database_app(database_config)) as client:
                client.post(
                    f"/api/sessions/{session_id}/finish",
                    json={"contract_version": 2, "request_id": str(uuid4())},
                    headers=login(client),
                )

        request.addfinalizer(finish)
        batch = teacher.post(
            f"/api/sessions/{session_id}/assignments/batch",
            headers=headers,
            json={
                "request_id": str(uuid4()),
                "items": [
                    {
                        "participant_id": users[trainee]["id"],
                        "scenario_id": str(scenario_uuid(data)),
                        "scenario_version": data["version"],
                        "order": 1,
                        "delay_from_start_s": 0,
                        "delivery_mode": "profile",
                    }
                ],
            },
        )
        assert batch.status_code == 201, batch.text
        started = teacher.post(f"/api/sessions/{session_id}/start", headers=headers)
        assert started.status_code == 200, started.text
    assert c03.tick(url) >= 1
    client = TestClient(create_database_app(database_config))
    client.__enter__()
    request.addfinalizer(lambda: client.__exit__(None, None, None))
    trainee_headers = login(client, trainee)
    card = next(c for c in client.get("/api/cards").json() if c["session_id"] == session_id)
    assert card["source"]["number"] == data["card"]["number"]
    return Shift(client, trainee_headers, url, data, card, service)


def replaced_by(data: dict[str, Any], report: str) -> list[str]:
    """Имена реплик, которыми ветки событий могут подменить доклад плана, и реплика повтора
    адреса, которую говорит доклад о выезде (`scenario_events.carried_events`)."""
    names = [
        f"event:{event['key']}"
        for event in data.get("events", [])
        if event["kind"] == "readback_error" and event["trigger"].get("report") == report
    ]
    for event in data.get("events", []):
        for branch, body in event["branches"].items():
            if any(effect.get("replace") == report for effect in body["effects"]):
                names.append(f"event:{event['key']}:{branch}-replace")
    return names


def answer_event(shift: Shift, event: dict[str, Any], choose: str | None) -> None:
    """Реакция на событие бригады: вариант ответа (верный или `choose`), звонок в службу
    или — `choose == "skip"` — ничего: пропуск."""
    # Повтор адреса говорит сам доклад о выезде: событие сработало, как только он прозвучал.
    if event["kind"] != "readback_error":
        time.sleep(event["trigger"]["after_s"] + 0.2)
    item = shift.hear([f"event:{event['key']}"])
    if choose == "skip":
        return
    expect = event["expect"][0]
    if expect["action"] in ("reply", "correct_readback"):
        key = choose or expect["option_key"]
        shift.reply(item, key)
        branch = "met" if key == expect["option_key"] else "wrong"
    else:
        assert expect["action"] == "call_service", event["key"]
        shift.dial(expect["phone_exts"][0])
        # HQ-055: о вызванной службе бригаде сообщает диспетчер, вернувшись к ней с удержания;
        # «Понял, ждём» отвечает окно телефона — с сервера ответа ветки нет.
        shift.send("brigade_said", {"call_id": shift.call_id, "text": "Отправил, едут."})
        return
    # Ответ на неверный повтор адреса решается на сроке: бригада молчит до него.
    if event["branches"].get(branch, {}).get("line") is not None:
        shift.hear([f"event:{event['key']}:{branch}"])


Action = Callable[[Shift], None]


def play(
    shift: Shift,
    *,
    final: str | None = None,
    choices: dict[str, str] | None = None,
    ahead: dict[str, float] | None = None,
    after_event: dict[str, Action] | None = None,
) -> None:
    """Карточка по плану: вводная, доклады, события, статусы по докладам до закрытия.

    `final` — другой завершающий статус, `choices` — другой ответ на событие (или "skip"),
    `ahead` — на сколько секунд вперёд ждать доклада (ветка события его задержала).
    """
    shift.open()
    shift.accept()
    shift.brief()
    events = shift.data.get("events", [])
    plan = shift.data["plan"]
    for index, report in enumerate(plan):
        wait = (ahead or {}).get(report["key"], report["after_s"] + 1)
        shift.hear([f"message:{report['key']}", *replaced_by(shift.data, report["key"])], wait)
        for event in events:
            if event["trigger"].get("report") != report["key"]:
                continue
            answer_event(shift, event, (choices or {}).get(event["key"]))
            if after_event and event["key"] in after_event:
                after_event[event["key"]](shift)
        state = report["justifies_state"]
        if index < len(plan) - 1:
            shift.status(state, line_text(report["line"]))
            continue
        shift.hang_up()
        shift.status(final or state, shift.data["reference"]["expected_comment"])


def reject(shift: Shift) -> None:
    """Не наша карточка: «Не принята» с причиной и перенаправление (эталон, раздел 5)."""
    shift.open()
    comment = shift.data["reference"]["expected_comment"]
    shift.status("rejected", comment)
    shift.send("redirect", {"service_id": "GKH", "comment": comment})


def call_caller(shift: Shift) -> None:
    """Бригада не может попасть в квартиру: звонок хозяйке по номеру из карточки."""
    shift.dial(CALLER["number"])


def clean(evaluation: Evaluation) -> dict[str, float]:
    """Баллы правил, которые не равны 1, и критические ошибки — пусто, если разбор чистый."""
    worse = {key: float(value) for key, value in evaluation.rules_scores.items() if value < 1}
    return {**worse, **{f"critical:{key}": 0.0 for key in evaluation.critical_flags}}


def explanation(evaluation: Evaluation, key: str) -> list[str]:
    raw = evaluation.explanation.get(key)
    assert isinstance(raw, dict), key
    return [str(raw.get("explanation")), *[str(line) for line in raw.get("evidence", [])]]


def test_final_files_follow_schema_and_section_8():
    """Пять сценариев раздела 8 и бытовой ЖКХ: по схеме, с полным планом, ветками и частями."""
    for code in [*FINAL, HOUSEHOLD]:
        data = read_file(SCENARIOS_DIR / f"{code}.json", SERVICES)
        assert set(data["input_parts"]) == set(STEPS), code
        flow = data["reference"]["expected_flow"]
        if code == NOT_OURS:
            assert flow == ["received", "rejected", "redirected"]
            assert data["reference"]["expected_service_ids"] == ["GKH"]
            # Бригада нужна только на случай ошибки: принятая карточка — «не наш профиль».
            assert [item["justifies_state"] for item in data["plan"]][-1] == "refused"
            continue
        # Ветки раздела 7: хотя бы одно событие сценария меняет мир по исходу.
        assert any(event["branches"] for event in data["events"]), code
        assert data["plan"][-1]["justifies_state"] == flow[-1], code
    assert scenario_file("traffic-blocked-102-2")["reference"]["expected_flow"][-1] == "refused"
    assert scenario_file("unwell-street-103-2")["reference"]["expected_flow"][-1] == "completed"
    (evacuation,) = scenario_file("gas-entrance-104-2")["events"]
    assert evacuation["expect"][0]["phone_exts"][0] == "112"
    call = scenario_file(HOUSEHOLD)["reference"]["expected_call"]
    assert (call["required"], call["contact_role"]) == (True, "caller")


def test_only_scenarios_with_brigade_plan_are_offered(database_config, database_url):
    """Сценарии без плана бригады в тренировку и подбор ДДС не идут; набор на финал — идёт.

    Бытовой сценарий со звонком заявителю в случайную выдачу ступеней не попадает: его
    выбирают сами — в занятии у преподавателя или в каталоге тренировок
    (`test_practice_catalog`), где заявителя в телефон добавляет сама тренировка."""
    seed_training(database_url)
    ids = {code: scenario_uuid(scenario_file(code)) for code in SEATS}
    with TestClient(create_database_app(database_config)) as client:
        login(client)
        playable = set(client.get("/api/scenarios/playable").json()["scenario_ids"])
    assert str(CASE_01) not in playable
    assert {str(item) for item in ids.values()} <= playable

    async def pool(db, service: str, step: int) -> set[UUID]:
        return {item.id for item in await step_pool(db, step_by_number(step), service)}

    for code, (service, _) in FINAL.items():
        step = 2 if scenario_file(code)["level"] == 1 else 3
        assert ids[code] in run_db(database_url, lambda db, s=service, n=step: pool(db, s, n))
    assert ids[HOUSEHOLD] not in run_db(database_url, lambda db: pool(db, "GKH", 2))


@pytest.mark.parametrize("code", [*FINAL, HOUSEHOLD])
def test_reference_path_closes_card_with_clean_review(code, database_config, database_url, request):
    seed_training(database_url)
    contacts = WITH_CALLER if code == HOUSEHOLD else None
    shift = open_shift(database_config, database_url, request, code, contacts)
    if code == NOT_OURS:
        reject(shift)
    else:
        play(shift, after_event={"door": call_caller} if code == HOUSEHOLD else None)
    evaluation = shift.evaluation()
    assert clean(evaluation) == {}, json.dumps(evaluation.explanation, ensure_ascii=False)
    # GP-27: после закрытия разбор получает исход самого сценария.
    assert shift.outcome() == shift.data["outcome"], code
    if code == HOUSEHOLD:
        assert any("Адресат GKH/458" in line for line in explanation(evaluation, "call"))


def test_outcome_is_hidden_until_the_card_is_closed(database_config, database_url, request):
    """Пока карточка идёт, исход сервер не отдаёт: иначе обучаемый узнал бы концовку заранее."""
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, "smoke-apartment-101-1")
    assert shift.outcome() is None
    shift.open()
    shift.accept()
    assert shift.outcome() is None
    play_closed = shift.client.get(f"/api/cards/{shift.card_id}/training").json()
    assert "outcome" not in play_closed


def readback_left(shift: Shift) -> None:
    play(shift, choices={"readback": "ok"}, ahead={"arrival": 100})


# Ветка ошибки раздела 7 → критерий разбора и строка в нём.
BRANCHES: dict[str, tuple[Callable[[Shift], None], str, str]] = {
    "smoke-apartment-101-1": (
        readback_left,
        "brigade_work",
        "Расчёт повторил адрес с ошибкой: ответили вариантом «Понял», не поправили — расчёт "
        "приехал не туда.",
    ),
    "traffic-blocked-102-2": (
        lambda shift: play(shift, final="completed"),
        "status_flow",
        "Бригада доложила, что работы на месте не проводились: по памятке ДДС (стр. 22) такую "
        "карточку закрывают «Отказ от выполнения работ» с причиной в комментарии.",
    ),
    "unwell-street-103-2": (
        lambda shift: play(shift, final="refused"),
        "status_flow",
        "Служба 103 не ставит «Не принята» и «Отказ от выполнения работ»: по памятке ДДС "
        "(стр. 23) вместо них — «Работы завершены: завершение работ без бригады» с причиной "
        "в комментарии.",
    ),
    "gas-entrance-104-2": (
        lambda shift: play(shift, choices={"evacuation": "skip"}, ahead={"completion": 100}),
        "brigade_work",
        "Обстановка изменилась: нужна пожарная охрана — сообщить в 112: в 112 или 101 "
        "не позвонили.",
    ),
    NOT_OURS: (
        play,
        "routing",
        "Ожидались решения: Не принята → Перенаправлена; получены: Принята",
    ),
    HOUSEHOLD: (
        lambda shift: play(
            shift, after_event={"door": lambda s: s.dial(CALLER["number"], expected=422)}
        ),
        "call",
        "Обязательный звонок отсутствует",
    ),
}


@pytest.mark.parametrize("code", list(BRANCHES))
def test_error_branch_gives_expected_review_line(code, database_config, database_url, request):
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, code)
    action, criterion, line = BRANCHES[code]
    action(shift)
    evaluation = shift.evaluation()
    lines = explanation(evaluation, criterion)
    assert any(line in item for item in lines), lines
    assert evaluation.rules_scores[criterion] < 1


def test_status_the_brigade_never_reports_is_refused(database_config, database_url, request):
    """Статус без доклада сервер не принимает (эталон, раздел 7) — и тот, о котором бригада
    в сценарии не докладывает вовсе: у «не нашей» карточки нет доклада о прибытии (GP-12)."""
    seed_training(database_url)
    shift = open_shift(database_config, database_url, request, NOT_OURS)
    shift.open()
    shift.accept()
    shift.brief()
    shift.hear(["message:departure"])
    shift.status("responding", "Бригада выехала.")
    training = shift.client.get(f"/api/cards/{shift.card_id}/training").json()
    assert "arrived" in training["missing_report_states"]
    refused = shift.send("status_change", {"state": "arrived", "comment": "Прибыли."}, 409)
    detail = refused.json()
    assert detail["code"] == "report_required", detail
    assert "не докладывала" in detail["message"], detail
