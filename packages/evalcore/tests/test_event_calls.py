"""GP-04: обязательный звонок задаёт событие сценария, а не звонок своей службе.

Диспетчер ДДС работает с бригадами (docs/dds_gameplay.md, разделы 2 и 5): звонит в другую
службу, когда бригада просит или обстановка требует. Исход такого звонка — вовремя, поздно,
не позвонил — оценивает brigade_work; критерий call звонка своей службе не требует.
"""

from evalcore.brigade import BrigadeWorkCriterion
from evalcore.criteria import CallCriterion
from evalcore.defaults import BRIGADE_LATE_SCORE, CRITERIA
from evalcore.models import EvalContext

from .test_brigade_work import call, fired, iso, request_service, told

PLAN = ({"message_id": "m-works", "justifies_state": "working", "presented_at": None},)


def scenario(required: bool, service_id: str = "101") -> dict:
    return {
        "target_service_id": "101",
        "reference": {
            "expected_flow": [],
            "expected_call": {
                "required": required,
                "service_id": service_id,
                "phone_ext": service_id,
                "before_s": 180,
            },
        },
    }


def context(fired_events=(), calls=(), *, required=False, plan=PLAN) -> EvalContext:
    weights = {key: 1.0 for key in CRITERIA} | {"brigade_work": 1.0}
    return EvalContext(
        scenario(required),
        {},
        [],
        list(calls),
        {"weights": weights, "critical_cap": 0.5},
        planned_messages=plan,
        scenario_events=tuple(fired_events),
    )


def test_event_call_on_time():
    result = BrigadeWorkCriterion().evaluate(
        context([fired(request_service(), 100, said=[told(150)])], [call("103", 130)])
    )
    assert result.score == 1.0
    assert not result.critical
    assert result.evidence == [
        "Расчёт попросил скорую: позвонили в 103 через 0:30; сообщили бригаде, что служба "
        "едет, через 0:20 после звонка."
    ]


def test_event_call_late():
    result = BrigadeWorkCriterion().evaluate(
        context([fired(request_service(), 100, said=[told(180)])], [call("112", 175)])
    )
    assert result.score == BRIGADE_LATE_SCORE
    assert "позже срока" in result.evidence[0]


def test_event_call_missed():
    result = BrigadeWorkCriterion().evaluate(context([fired(request_service(), 100)]))
    assert result.score == 0.0
    assert result.evidence == ["Расчёт попросил скорую: в 103 или 112 не позвонили."]


def test_scenario_without_call_event_requires_no_call():
    ctx = context()
    call_result = CallCriterion().evaluate(ctx)
    assert call_result.score == 1.0
    assert not call_result.critical
    assert call_result.evidence == ["Обязательный звонок не предусмотрен эталоном"]
    work = BrigadeWorkCriterion().evaluate(ctx)
    assert work.weight == 0.0


def test_own_service_call_issued_before_gp04_is_not_required():
    """Сценарий с планом, выданный с required: true на свою службу, не штрафует."""
    ctx = context(required=True)
    result = CallCriterion().evaluate(ctx)
    assert result.score == 1.0
    assert not result.critical
    assert result.explanation == "Требований к звонку в этом сценарии нет."


def test_required_call_to_other_service_is_still_scored():
    ctx = EvalContext(
        scenario(True, "103"), {}, [], [], {"weights": {"call": 1.0}}, planned_messages=PLAN
    )
    result = CallCriterion().evaluate(ctx)
    assert result.score == 0.0
    assert result.critical


def test_scenario_without_plan_keeps_own_service_call():
    """Сценарии без плана докладов (golden, стартовый пакет) оцениваются как раньше."""
    result = CallCriterion().evaluate(context(required=True, plan=()))
    assert result.score == 0.0
    assert result.critical


def contact_scenario(role: str) -> dict:
    data = scenario(True)
    data["reference"]["expected_call"] = {
        **data["reference"]["expected_call"],
        "phone_ext": "401",
        "contact_role": role,
    }
    return data


def contact_call(ext: str, started: float) -> dict:
    """Звонок абоненту телефона ДДС (GP-09): сервер пишет его на свою службу (101)."""
    return {**call(ext, started, answered=started + 5), "service_id": "101"}


def contact_context(calls, settings=None) -> EvalContext:
    return EvalContext(
        contact_scenario("head"),
        {"opened_at": iso(0)},
        [],
        list(calls),
        {"weights": {"call": 1.0}, **(settings or {})},
        planned_messages=PLAN,
    )


def test_report_to_head_required_by_scenario_is_scored():
    """GP-09: доклад руководителю по телефону ДДС засчитывается, если его требует сценарий."""
    done = CallCriterion().evaluate(contact_context([contact_call("401", 60)]))
    assert done.score > 0.5
    assert not done.critical
    missed = CallCriterion().evaluate(contact_context([]))
    assert missed.score == 0.0
    assert missed.critical
    # Начальнику отдела вместо руководителя — не тот адресат.
    wrong = CallCriterion().evaluate(contact_context([contact_call("402", 60)]))
    assert wrong.score < done.score


def test_report_to_head_uses_teacher_numbers():
    """Номер руководителя — из списка преподавателя у ДДС занятия, не по умолчанию."""
    settings = {"phone_contacts": {"101": [{"role": "head", "name": "Директор", "number": "455"}]}}
    moved = CallCriterion().evaluate(contact_context([contact_call("455", 60)], settings))
    old = CallCriterion().evaluate(contact_context([contact_call("401", 60)], settings))
    assert moved.score > old.score


def test_brigade_call_is_not_report_to_contact():
    """GP-08: разговор с бригадой своей службы — не доклад абоненту телефона ДДС."""
    brigade = {**contact_call("209", 60), "brigade_id": "b-1"}
    missed = CallCriterion().evaluate(contact_context([brigade]))
    assert missed.score == 0.0
    assert missed.critical
    assert missed.evidence == ["Обязательный звонок отсутствует"]
    done = CallCriterion().evaluate(contact_context([brigade, contact_call("401", 90)]))
    assert not done.critical
    assert not any("209" in line for line in done.evidence)
