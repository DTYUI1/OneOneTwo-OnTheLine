import json
from dataclasses import dataclass, replace
from pathlib import Path

import pytest
from evalcore.criteria import (
    AddressCriterion,
    CallCriterion,
    HandlingTimeCriterion,
    ReactionTimeCriterion,
    RequiredFieldsCriterion,
    RoutingCriterion,
    StatusFlowCriterion,
    register,
    registered_criteria,
)
from evalcore.defaults import CRITERIA, REPORT_CHOICE_FACTOR
from evalcore.models import CriterionResult, EvalContext, Json
from evalcore.scoring import aggregate, configured_weights, evaluate
from evalcore.timing import calculate_timing
from evalcore.timing_contract import TimingInput, TimingResult
from pydantic import TypeAdapter


def result(
    key: str,
    score: float = 1.0,
    weight: float = 1.0,
    *,
    critical: bool = False,
) -> CriterionResult:
    return CriterionResult(key, score, weight, critical, ["факт"], "объяснение")


def settings(**weights: float) -> dict[str, Json]:
    configured = {key: 1.0 for key in CRITERIA}
    configured.update(weights)
    return {"weights": configured, "critical_cap": 0.5}


def test_aggregate_uses_weighted_average():
    evaluation = aggregate(
        [result("reaction_time", 1, 3), result("handling_time", 0, 1)],
        critical_cap=0.5,
    )

    assert evaluation.total == pytest.approx(0.75)
    assert evaluation.critical_flags == []


def test_aggregate_applies_cap_and_reports_critical_keys():
    evaluation = aggregate(
        [result("reaction_time"), result("address", critical=True)],
        critical_cap=0.5,
    )

    assert evaluation.total == 0.5
    assert evaluation.critical_flags == ["address"]


def test_critical_score_distinguishes_one_error_from_broken_card():
    one_missed_call = aggregate(
        [result("call", 0, critical=True), result("routing"), result("status_flow")],
        critical_cap=0.5,
    )
    multiple_errors = aggregate(
        [
            result("call", 0, critical=True),
            result("routing", 0, critical=True),
            result("status_flow", 0),
        ],
        critical_cap=0.5,
    )
    abandoned_work = aggregate(
        [result("call", 0, critical=True), result("routing"), result("status_flow", 0)],
        critical_cap=0.5,
    )
    assert one_missed_call.total == pytest.approx(1 / 3)
    assert abandoned_work.total == pytest.approx(1 / 6)
    assert multiple_errors.total == 0
    assert one_missed_call.total > abandoned_work.total > multiple_errors.total


def test_zero_weight_critical_criterion_cannot_cap_other_scores():
    evaluation = aggregate(
        [result("call", 0, weight=0, critical=True), result("routing", 1)],
        critical_cap=0.5,
    )

    assert evaluation.total == 1
    assert evaluation.critical_flags == []


@pytest.mark.parametrize(
    ("criteria", "message"),
    [
        ([], "хотя бы один"),
        ([result("reaction_time", 1.1)], "от 0 до 1"),
        ([result("reaction_time", weight=-1)], "неотрицательным"),
        ([result("reaction_time", weight=0)], "больше нуля"),
        ([result("reaction_time"), result("reaction_time")], "дважды"),
    ],
)
def test_aggregate_rejects_invalid_results(criteria, message):
    with pytest.raises(ValueError, match=message):
        aggregate(criteria, critical_cap=0.5)


def test_configured_weights_rejects_missing_negative_and_zero_sum():
    with pytest.raises(ValueError, match="Не заданы веса"):
        configured_weights({"weights": {}})
    with pytest.raises(ValueError, match="не может быть отрицательным"):
        configured_weights(settings(address=-1))
    with pytest.raises(ValueError, match="больше нуля"):
        configured_weights(settings(**dict.fromkeys(CRITERIA, 0)))


@dataclass
class FixedCriterion:
    key: str
    score: float = 1.0

    def evaluate(self, ctx: EvalContext) -> CriterionResult:
        weights = ctx.settings["weights"]
        assert isinstance(weights, dict)
        weight = weights[self.key]
        assert isinstance(weight, (int, float))
        return result(self.key, self.score, float(weight))


def test_registry_and_evaluate_preserve_declared_order(monkeypatch):
    local_registry = {key: FixedCriterion(key) for key in reversed(CRITERIA)}
    monkeypatch.setattr("evalcore.scoring.REGISTRY", local_registry)

    evaluation = evaluate(EvalContext({}, {}, [], [], settings()))

    assert evaluation.total == 1
    assert [item.key for item in evaluation.criteria] == list(CRITERIA)


def test_evaluate_rejects_criterion_with_wrong_weight(monkeypatch):
    local_registry = {key: FixedCriterion(key) for key in CRITERIA}
    local_registry["address"] = FixedCriterion("address")
    monkeypatch.setattr("evalcore.scoring.REGISTRY", local_registry)

    ctx_settings = settings(address=2)
    wrong = FixedCriterion("address")

    def evaluate_with_wrong_weight(ctx):
        return result("address", weight=1)

    monkeypatch.setattr(wrong, "evaluate", evaluate_with_wrong_weight)
    local_registry["address"] = wrong

    with pytest.raises(ValueError, match="в settings задано 2.0"):
        evaluate(EvalContext({}, {}, [], [], ctx_settings))


def test_register_validates_key_and_duplicates(monkeypatch):
    monkeypatch.setattr("evalcore.criteria.REGISTRY", {})
    criterion = FixedCriterion("handling_time")
    register(criterion)
    assert registered_criteria() == (criterion,)
    with pytest.raises(ValueError, match="уже зарегистрирован"):
        register(criterion)
    with pytest.raises(ValueError, match="Неизвестный"):
        register(FixedCriterion("other"))


def reaction_context(open_after_s: int | None) -> EvalContext:
    events: list[dict[str, Json]] = [{"type": "deliver", "client_ts": "2026-09-19T09:00:00Z"}]
    if open_after_s is not None:
        minutes, seconds = divmod(open_after_s, 60)
        events.append(
            {
                "type": "open",
                "client_ts": f"2026-09-19T09:{minutes:02d}:{seconds:02d}Z",
            }
        )
    return EvalContext({}, {}, events, [], settings())


def load_golden_context(case: str = "case-01.json") -> tuple[dict, EvalContext]:
    fixture_path = Path(__file__).parents[3] / "data" / "golden_scenarios" / case
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    return fixture, EvalContext(
        scenario=fixture["scenario"],
        current=fixture["current"],
        events=fixture["events"],
        calls=fixture["calls"],
        settings=fixture["settings"],
    )


def timing_fixture(name: str) -> TimingResult:
    root = Path(__file__).parents[3]
    for file_name in ("timing-v2.json", "timing-v3.json"):
        path = root / "contracts" / "examples" / file_name
        cases = json.loads(path.read_text(encoding="utf-8"))
        for case in cases:
            if case["name"] == name:
                value = TypeAdapter(TimingInput).validate_python(case["input"])
                return calculate_timing(value)
    raise AssertionError(f"Не найдена временная фикстура {name}")


@pytest.mark.parametrize(
    ("elapsed_s", "expected"),
    [(10, 1.0), (30, 1.0), (45, 0.5), (60, 0.0), (90, 0.0)],
)
def test_reaction_time_uses_readme_formula(elapsed_s, expected):
    evaluated = ReactionTimeCriterion().evaluate(reaction_context(elapsed_s))

    assert evaluated.score == pytest.approx(expected)
    assert evaluated.key == "reaction_time"
    assert evaluated.weight == 1
    assert not evaluated.critical
    assert f"Реакция {elapsed_s} с" in evaluated.evidence[0]


def test_reaction_time_without_open_is_not_confirmed():
    evaluated = ReactionTimeCriterion().evaluate(reaction_context(None))

    assert evaluated.score == 0
    assert evaluated.evidence == ["Отсутствуют события: открытие"]


def test_reaction_time_rejects_non_positive_normative():
    ctx = reaction_context(10)
    ctx.settings["reaction_normative_s"] = 0

    with pytest.raises(ValueError, match="должен быть больше нуля"):
        ReactionTimeCriterion().evaluate(ctx)


@pytest.mark.parametrize(
    "fixture_path",
    sorted((Path(__file__).parents[3] / "data" / "golden_scenarios").glob("case-*.json")),
)
def test_reaction_time_matches_golden_scenarios(fixture_path):
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    ctx = EvalContext(
        scenario=fixture["scenario"],
        current=fixture["current"],
        events=fixture["events"],
        calls=fixture["calls"],
        settings=fixture["settings"],
    )

    evaluated = ReactionTimeCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(fixture["expected"]["criteria"]["reaction_time"])


@pytest.mark.parametrize(
    "fixture_path",
    sorted((Path(__file__).parents[3] / "data" / "golden_scenarios").glob("case-*.json")),
)
def test_complete_evaluation_matches_golden_scenarios(fixture_path):
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    ctx = EvalContext(
        fixture["scenario"],
        fixture["current"],
        fixture["events"],
        fixture["calls"],
        fixture["settings"],
    )

    evaluation = evaluate(ctx)

    assert evaluation.total == pytest.approx(fixture["expected"]["total"])
    assert {item.key: item.score for item in evaluation.criteria} == pytest.approx(
        fixture["expected"]["criteria"]
    )
    assert evaluation.critical_flags == fixture["expected"].get("critical_flags", [])


def test_handling_time_applies_linear_penalty():
    _, ctx = load_golden_context()
    ctx.events[-1]["client_ts"] = "2026-09-19T09:04:40Z"

    evaluated = HandlingTimeCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(0.5)


def test_v3_time_criteria_use_primary_status_and_active_handling():
    _, ctx = load_golden_context()
    timing = timing_fixture("v3_waiting_60")

    evaluation = evaluate(ctx, timing=timing)
    scores = {item.key: item for item in evaluation.criteria}

    assert timing.reaction_s == 40
    assert timing.handling_s == 170
    assert timing.active_handling_s == 110
    assert scores["reaction_time"].score == pytest.approx(2 - 40 / 30)
    assert scores["handling_time"].score == 1
    assert "Активная обработка 110 с" in scores["handling_time"].evidence[2]
    assert "I-TIME v3" in scores["reaction_time"].evidence[0]


def test_legacy_evaluate_without_timing_preserves_old_semantics():
    _, ctx = load_golden_context()

    evaluation = evaluate(ctx)
    scores = {item.key: item.score for item in evaluation.criteria}

    assert scores["reaction_time"] == 1
    assert scores["handling_time"] == 1


def test_v3_unknown_waiting_does_not_use_full_handling_as_active():
    _, ctx = load_golden_context()
    timing = timing_fixture("v3_waiting_unknown")

    result = HandlingTimeCriterion().evaluate_timing(ctx, timing)

    assert timing.handling_s == 170
    assert timing.active_handling_s is None
    assert result.score == 0
    assert "Активная обработка не определена" in result.evidence
    assert "неизвестны интервалы ожидания" in result.evidence[-1]


def test_v2_time_criterion_keeps_full_handling_semantics():
    _, ctx = load_golden_context()
    timing = replace(timing_fixture("waiting_separate"), handling_normative_s=100)

    result = HandlingTimeCriterion().evaluate_timing(ctx, timing)

    assert timing.handling_s == 170
    assert timing.active_handling_s == 140
    assert result.score == pytest.approx(0.3)
    assert "Обработка 170 с" in result.evidence[2]


@pytest.mark.parametrize(
    ("fixture_name", "reaction_score", "handling_score"),
    [
        ("v3_exact_limits", 1.0, 1.0),
        ("v3_over_limits", 1 - 0.001 / 30, 1 - 0.001 / 180),
        ("snapshot_10_100", 0.0, 0.3),
    ],
)
def test_timing_criteria_respect_snapshot_normatives_and_exact_boundary(
    fixture_name, reaction_score, handling_score
):
    _, ctx = load_golden_context()
    timing = timing_fixture(fixture_name)

    reaction = ReactionTimeCriterion().evaluate_timing(ctx, timing)
    handling = HandlingTimeCriterion().evaluate_timing(ctx, timing)

    assert reaction.score == pytest.approx(reaction_score)
    assert handling.score == pytest.approx(handling_score)


def test_missing_v3_reaction_is_explained_without_false_zero_duration():
    _, ctx = load_golden_context()
    timing = timing_fixture("v3_missing_direct")

    result = ReactionTimeCriterion().evaluate_timing(ctx, timing)

    assert timing.reaction_s is None
    assert result.score == 0
    assert "Время реакции не определено" in result.evidence
    assert "нет направления карточки" in result.evidence[-1]


def test_status_flow_penalizes_missing_state():
    _, ctx = load_golden_context()
    ctx.events[:] = [
        event
        for event in ctx.events
        if not (
            event.get("type") == "status_change"
            and isinstance(event.get("payload"), dict)
            and event["payload"].get("state") == "responding"
        )
    ]

    evaluated = StatusFlowCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(0.75)
    assert not evaluated.critical


def test_wrong_routing_is_critical():
    _, ctx = load_golden_context()
    accepted = next(
        event
        for event in ctx.events
        if event.get("type") == "status_change" and event["payload"].get("state") == "accepted"
    )
    accepted["payload"]["state"] = "rejected"

    evaluated = RoutingCriterion().evaluate(ctx)

    assert evaluated.score == 0
    assert evaluated.critical


@pytest.mark.parametrize("service,score", [("101", 1), ("102", 0), (None, 0)])
def test_redirect_after_rejection_checks_final_recipient(service, score):
    _, ctx = load_golden_context()
    ctx.scenario["reference"]["expected_flow"] = ["received", "rejected", "redirected"]
    ctx.scenario["reference"]["expected_service_ids"] = ["101"]
    ctx.events[:] = [
        {
            "type": "status_change",
            "client_ts": "2026-09-19T09:00:20Z",
            "payload": {"state": "rejected"},
        }
    ]
    if service:
        ctx.events.append(
            {
                "type": "redirect",
                "client_ts": "2026-09-19T09:00:30Z",
                "payload": {"service_id": service},
            }
        )
    evaluated = RoutingCriterion().evaluate(ctx)
    assert evaluated.score == score
    assert evaluated.critical is (score == 0)
    assert "101" in evaluated.evidence[-1]
    if service:
        assert service in evaluated.evidence[-1]


def test_rejection_without_expected_redirect_remains_valid():
    _, ctx = load_golden_context()
    ctx.scenario["reference"]["expected_flow"] = ["received", "rejected"]
    ctx.events[:] = [
        {
            "type": "status_change",
            "client_ts": "2026-09-19T09:00:20Z",
            "payload": {"state": "rejected"},
        }
    ]
    assert RoutingCriterion().evaluate(ctx).score == 1


def test_corrected_rejection_then_acceptance_is_not_critical_routing_error():
    _, ctx = load_golden_context()
    ctx.events.insert(
        2,
        {
            "type": "status_change",
            "client_ts": "2026-09-19T09:00:12Z",
            "payload": {"state": "rejected"},
        },
    )

    result = RoutingCriterion().evaluate(ctx)

    assert result.score == 1
    assert not result.critical
    assert "Не принята → Принята" in result.evidence[0]


def test_unrelated_extra_routing_decision_remains_critical():
    _, ctx = load_golden_context()
    ctx.events.append(
        {
            "type": "status_change",
            "client_ts": "2026-09-19T09:02:00Z",
            "payload": {"state": "rejected"},
        }
    )

    result = RoutingCriterion().evaluate(ctx)

    assert result.score == 0
    assert result.critical


def test_required_fields_scores_filled_fraction():
    _, ctx = load_golden_context()
    ctx.current["comment"] = "   "

    evaluated = RequiredFieldsCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(0.5)
    assert not evaluated.critical


def test_required_fields_names_empty_field():
    _, ctx = load_golden_context()
    ctx.current["service_number"] = " "

    evaluated = RequiredFieldsCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(0.5)
    assert evaluated.evidence[0] == "Не заполнен номер наряда"
    assert evaluated.explanation == "Не заполнен номер наряда."


@pytest.mark.parametrize("value", ["201", "№ 201", "бригада 2 0 1", "201, 203", "203"])
def test_required_fields_accepts_brigade_number_by_digits(value: str):
    _, ctx = load_golden_context()
    ctx = replace(ctx, brigade_numbers=("201", "203"))
    ctx.current["service_number"] = value

    assert RequiredFieldsCriterion().evaluate(ctx).score == 1


def test_required_fields_rejects_number_of_other_brigade():
    _, ctx = load_golden_context()
    ctx = replace(ctx, brigade_numbers=("201",))
    ctx.current["service_number"] = "1"

    evaluated = RequiredFieldsCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(0.5)
    assert evaluated.evidence == [
        "Номер наряда 1 не совпадает с номером бригады: 201",
        "Заполнено 1 из 2 обязательных полей",
    ]


def test_required_fields_without_brigades_checks_only_filled():
    _, ctx = load_golden_context()
    ctx.current["service_number"] = "1"

    assert RequiredFieldsCriterion().evaluate(ctx).score == 1


def write_comment(ctx: EvalContext, comment: str) -> None:
    """Один и тот же комментарий во всех статусах: адрес ищется во всех комментариях."""
    ctx.current["comment"] = comment
    for event in ctx.events:
        payload = event.get("payload")
        if isinstance(payload, dict) and "comment" in payload:
            payload["comment"] = comment


def test_wrong_street_is_critical_and_caps_total():
    _, ctx = load_golden_context()
    # Опечатка в улице карточки (ревью DT-14): другая улица целиком — не искажение адреса.
    write_comment(ctx, "Москва, Дубининская улица, дом 1. Направлен экипаж.")

    address = AddressCriterion().evaluate(ctx)
    evaluation = evaluate(ctx)

    assert address.score == pytest.approx(2 / 3)
    assert address.critical
    assert evaluation.total == pytest.approx(10 / 21)
    assert evaluation.critical_flags == ["address"]


def test_manual_address_accepts_common_abbreviations_and_case():
    _, ctx = load_golden_context()
    ctx.scenario["reference"]["expected_address"]["building"] = "2"
    ctx.scenario["reference"]["expected_address"]["apartment"] = "3"
    ctx.current["address"] = {
        "city": "г. МОСКВА",
        "street": "ул. Дубнинская",
        "house": "д. 1",
        "building": "корп. 2",
        "apartment": "кв. 3",
    }

    result = AddressCriterion().evaluate(ctx)

    assert result.score == 1
    assert not result.critical
    assert result.evidence[0] == "Проверен ручной адрес из полей ручного ввода"


def test_manual_address_does_not_accept_another_similar_street():
    _, ctx = load_golden_context()
    ctx.current["address"] = {
        "city": "Москва",
        "street": "Дубининская улица",
        "house": "1",
        "building": "",
        "apartment": "",
    }

    result = AddressCriterion().evaluate(ctx)

    assert result.score == pytest.approx(2 / 3)
    assert result.critical
    assert result.evidence[-1] == "Не совпали: улица"


def test_manual_address_penalizes_unexpected_building():
    _, ctx = load_golden_context()
    ctx.current["address"] = {
        "city": "Москва",
        "street": "Дубнинская улица",
        "house": "1",
        "building": "корп. 2",
        "apartment": "",
    }

    result = AddressCriterion().evaluate(ctx)

    assert result.score == pytest.approx(3 / 4)
    assert not result.critical
    assert result.evidence[-1] == "Не совпали: корпус"


def test_late_call_gets_partial_noncritical_score():
    _, ctx = load_golden_context()
    ctx.calls[0]["started_at"] = "2026-09-19T09:03:20Z"

    evaluated = CallCriterion().evaluate(ctx)

    expected_time_score = 2 - 200 / 180
    assert evaluated.score == pytest.approx((1 + 1 + expected_time_score) / 3)
    assert not evaluated.critical


def test_call_to_wrong_addressee_is_critical():
    _, ctx = load_golden_context()
    ctx.calls[0]["service_id"] = "101"
    ctx.calls[0]["phone_ext"] = "101"

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(2 / 3)
    assert evaluated.critical


def test_direct_call_to_brigade_of_expected_service_is_correct():
    _, ctx = load_golden_context()
    ctx.calls[0]["phone_ext"] = "203"
    ctx.calls[0]["brigade_id"] = "00000000-0000-4000-8000-000000000203"

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(1)
    assert not evaluated.critical
    assert "(бригада службы): верно" in evaluated.evidence[1]


def test_brigade_of_other_service_is_still_wrong_addressee():
    _, ctx = load_golden_context()
    ctx.calls[0]["service_id"] = "101"
    ctx.calls[0]["phone_ext"] = "201"
    ctx.calls[0]["brigade_id"] = "00000000-0000-4000-8000-000000000201"

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.critical


def test_refused_brigade_call_is_not_the_required_call():
    _, ctx = load_golden_context()
    ctx.calls[0]["phone_ext"] = "203"
    ctx.calls[0]["brigade_id"] = "00000000-0000-4000-8000-000000000203"
    ctx.calls[0]["refusal"] = "not_assigned"

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.critical
    assert "(бригада не направлена на происшествие): неверно" in evaluated.evidence[1]
    assert "не направленным на происшествие: 1" in evaluated.evidence[-1]


def test_refused_brigade_call_next_to_correct_call_costs_nothing():
    _, ctx = load_golden_context()
    correct = CallCriterion().evaluate(ctx)
    refused = {
        **ctx.calls[0],
        "id": "refused-call",
        "phone_ext": "203",
        "brigade_id": "00000000-0000-4000-8000-000000000203",
        "refusal": "busy",
    }
    ctx.calls.insert(0, refused)

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(correct.score)
    assert evaluated.critical == correct.critical
    assert evaluated.evidence[:-1] == correct.evidence
    assert "не направленным на происшествие: 1" in evaluated.evidence[-1]


def test_inbound_brigade_call_does_not_replace_required_call():
    _, ctx = load_golden_context()
    ctx.calls[0]["direction"] = "inbound"
    ctx.calls[0]["brigade_id"] = "00000000-0000-4000-8000-000000000203"

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == 0
    assert evaluated.critical


def test_unanswered_required_call_is_critical():
    _, ctx = load_golden_context()
    ctx.calls[0]["answered_at"] = None

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(2 / 3)
    assert evaluated.critical


def test_status_flow_names_missing_state_and_refusal():
    """Разбор называет, чего не хватает, и подсказывает отказ, если работ не было."""
    _, ctx = load_golden_context()
    ctx.events[:] = [
        event
        for event in ctx.events
        if not (
            event.get("type") == "status_change"
            and isinstance(event.get("payload"), dict)
            and event["payload"].get("state") == "responding"
        )
    ]
    missing = StatusFlowCriterion().evaluate(ctx)
    assert "Не хватает: Начало реагирования." in missing.explanation

    _, ctx = load_golden_context()
    reference = ctx.scenario["reference"]
    flow = [state for state in reference["expected_flow"] if state != "completed"]
    reference["expected_flow"] = [*flow, "refused"]
    closed = StatusFlowCriterion().evaluate(ctx)
    assert "Не хватает: Отказ от выполнения работ." in closed.explanation
    assert "Лишние: Работы завершены." in closed.explanation
    assert "закрывают «Отказ от выполнения работ»" in closed.explanation


def test_status_flow_reminds_ambulance_has_no_refusal():
    """GP-08: скорая «Отказ от выполнения работ» не ставит (памятка ДДС, стр. 23)."""
    _, ctx = load_golden_context()
    ctx.scenario["target_service_id"] = "103"
    for event in ctx.events:
        payload = event.get("payload")
        if event.get("type") == "status_change" and isinstance(payload, dict):
            if payload.get("state") == "completed":
                payload["state"] = "refused"
    result = StatusFlowCriterion().evaluate(ctx)
    assert result.score < 1
    assert "Лишние: Отказ от выполнения работ." in result.explanation
    assert (
        "Служба 103 не ставит «Не принята» и «Отказ от выполнения работ»: по памятке ДДС "
        "(стр. 23) вместо них — «Работы завершены: завершение работ без бригады»"
    ) in result.explanation
    # Другой службе отказ не запрещён — о скорой разбор не говорит.
    ctx.scenario["target_service_id"] = "102"
    assert "Служба 103" not in StatusFlowCriterion().evaluate(ctx).explanation


def _hangup_with_report(
    ctx: EvalContext,
    choices: list[str],
    modes: list[str] | None = None,
    voice_failures: int | None = None,
    parts: list[list[str]] | None = None,
    loudness: list[str | None] | None = None,
) -> None:
    """Отбой звонка службе с докладом: виды по порядку и как сказан каждый (DT-05)."""
    call = ctx.calls[0]
    payload: dict[str, Json] = {"call_id": call["id"], "report_choices": list(choices)}
    if modes is not None:
        payload["report_modes"] = list(modes)
    if voice_failures is not None:
        payload["voice_failures"] = voice_failures
    if parts is not None:
        payload["report_parts"] = [list(item) for item in parts]
    if loudness is not None:
        payload["report_loudness"] = list(loudness)
    ctx.events.append(
        {
            "client_event_id": "00000000-0000-4000-8000-00000000f001",
            "client_ts": call["ended_at"] or call["started_at"],
            "type": "call_hangup",
            "payload": payload,
        }
    )


def test_full_voice_report_keeps_call_score_and_is_noted():
    _, ctx = load_golden_context()
    correct = CallCriterion().evaluate(ctx)
    _hangup_with_report(ctx, ["full"], ["voice"])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(correct.score)
    assert evaluated.evidence[-2] == "Доклад службе 102: полный, голосом"


def test_hangup_before_report_is_recorded_as_missing_report():
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, [], [])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(2 / 3)
    assert evaluated.critical
    assert "трубка положена до доклада" in evaluated.evidence[-1]
    assert evaluated.explanation == "Звонок прерван до доклада."


def test_voice_loudness_is_noted_without_changing_score():
    _, ctx = load_golden_context()
    correct = CallCriterion().evaluate(ctx)
    _hangup_with_report(ctx, ["no_who", "full"], ["voice", "voice"], loudness=["quiet", "ok"])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(correct.score)
    assert "громкость голоса: слишком тихо (1 из 2)" in evaluated.evidence[-2]


def test_loudness_in_norm_and_options_without_measure():
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["full"], ["voice"], loudness=["ok"])
    assert CallCriterion().evaluate(ctx).evidence[-2].endswith("громкость голоса в норме")
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["full"], ["option"], loudness=[None])
    assert "громкост" not in CallCriterion().evaluate(ctx).evidence[-2]


def test_full_report_by_choice_scores_lower_than_voice():
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["full"], ["option"])

    evaluated = CallCriterion().evaluate(ctx)

    # Доля доклада вариантом по умолчанию — 0,5: (0,5 + адресат 1 + время 1) / 3.
    assert evaluated.score == pytest.approx((REPORT_CHOICE_FACTOR + 2) / 3)
    assert not evaluated.critical
    assert evaluated.evidence[-2] == "Доклад службе 102: полный, ответ вариантом"
    assert "вариантом ответа" in evaluated.explanation


def test_report_without_modes_counts_as_choice():
    """Отбой части 1 (до голосового ввода): виды без report_modes — это варианты ответа."""
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["full"])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx((REPORT_CHOICE_FACTOR + 2) / 3)
    assert evaluated.evidence[-2] == "Доклад службе 102: полный, ответ вариантом"


def test_teacher_sets_choice_factor():
    _, ctx = load_golden_context()
    correct = CallCriterion().evaluate(ctx)
    _hangup_with_report(ctx, ["full"], ["option"])

    same = replace(ctx, settings={**ctx.settings, "report_choice_factor": 1})
    none = replace(ctx, settings={**ctx.settings, "report_choice_factor": 0})
    quarter = replace(ctx, settings={**ctx.settings, "report_choice_factor": 0.25})

    assert CallCriterion().evaluate(same).score == pytest.approx(correct.score)
    assert CallCriterion().evaluate(none).score == pytest.approx(2 / 3)
    assert CallCriterion().evaluate(quarter).score == pytest.approx(2.25 / 3)
    with pytest.raises(ValueError, match="report_choice_factor"):
        CallCriterion().evaluate(replace(ctx, settings={**ctx.settings, "report_choice_factor": 2}))


def test_full_report_after_clarification_is_a_remark_not_a_penalty():
    _, ctx = load_golden_context()
    correct = CallCriterion().evaluate(ctx)
    _hangup_with_report(ctx, ["no_address", "full"], ["voice", "voice"])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(correct.score)
    assert evaluated.evidence[-2] == (
        "Доклад службе 102: полный, голосом, после уточнения; сначала — без адреса и повода"
    )


def test_voice_failures_and_offered_choices_are_noted():
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["full"], ["option"], voice_failures=2)

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.evidence[-2] == (
        "Доклад службе 102: полный, ответ вариантом; голос не распознан: 2, "
        "предложены варианты ответа"
    )


def test_legacy_incomplete_report_costs_the_conversation_part_but_is_not_critical():
    """Вид до порядка памятки (журналы до 08.10.2026) читается как раньше."""
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["no_victims"])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(2 / 3)
    assert not evaluated.critical
    assert evaluated.evidence[0] == "Звонок отвечен: да"
    assert evaluated.evidence[-2] == (
        "Доклад службе 102: полного доклада нет — без сведений о пострадавших и силах"
    )
    assert evaluated.explanation == "Звонок выполнен с нарушениями."
    assert evaluated.evidence[-1].endswith("что изменилось ✗")


def test_report_with_extra_details_is_not_full():
    _, ctx = load_golden_context()
    correct = CallCriterion().evaluate(ctx)
    _hangup_with_report(ctx, ["extra"])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(2 / 3)
    assert evaluated.evidence[-2] == (
        "Доклад службе 102: полного доклада нет — с лишними сведениями: догадки, оценки, просьбы"
    )

    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["extra", "full"], ["option", "voice"])
    assert CallCriterion().evaluate(ctx).score == pytest.approx(correct.score)


# Звонок службе 102, не в 112: карточку памятка ДДС, с. 32, в нём не требует — её нет в строке.
ALL_SAID = "кто вы ✓, адрес и повод ✓, что изменилось ✓"


def test_full_report_lists_memo_parts():
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["full"], ["voice"])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.evidence[-1] == f"Части доклада службе 102 по памятке ДДС, с. 32: {ALL_SAID}"


@pytest.mark.parametrize(
    ("choice", "gap", "marks"),
    [
        ("no_who", "не представился", "кто вы ✗, адрес и повод ✓, что изменилось ✓"),
        (
            "no_address",
            "без адреса и повода",
            "кто вы ✓, адрес и повод ✗, что изменилось ✓",
        ),
        # Журнал до правила «карточка — только в 112»: вид читается, в строке частей её нет.
        ("no_card", "без карточки", "кто вы ✓, адрес и повод ✓, что изменилось ✓"),
        (
            "no_change",
            "без того, что изменилось",
            "кто вы ✓, адрес и повод ✓, что изменилось ✗",
        ),
    ],
)
def test_incomplete_report_names_missing_memo_part(choice, gap, marks):
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, [choice], ["option"])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(2 / 3)
    assert evaluated.evidence[-2] == f"Доклад службе 102: полного доклада нет — {gap}"
    assert evaluated.evidence[-1] == f"Части доклада службе 102 по памятке ДДС, с. 32: {marks}"


def test_voice_parts_show_every_missing_part():
    """Голосом может не хватать нескольких частей: report_parts называет все."""
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, ["no_who", "full"], ["voice", "voice"], parts=[["address"], []])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.evidence[-2] == (
        "Доклад службе 102: полный, голосом, после уточнения; сначала — не представился"
    )
    assert evaluated.evidence[-1] == (
        "Части первого доклада службе 102 по памятке ДДС, с. 32: "
        "кто вы ✗, адрес и повод ✓, что изменилось ✗"
    )


def test_hangup_before_report_is_noted():
    _, ctx = load_golden_context()
    _hangup_with_report(ctx, [])

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(2 / 3)
    assert "не сделан" in evaluated.evidence[-1]


def test_report_of_other_call_is_marked_and_repeated_gaps_are_counted():
    """Разбор 12.10: балл по звонку бригаде, а «доклад не сделан» — из звонка в 102."""
    _, ctx = load_golden_context()
    service_call = ctx.calls[0]
    brigade_call = {
        **service_call,
        "id": "00000000-0000-4000-8000-0000000000b1",
        "phone_ext": "203",
        "brigade_id": "00000000-0000-4000-8000-000000000203",
    }
    ctx.calls.insert(0, brigade_call)
    _hangup_with_report(ctx, ["no_who", "no_card", "no_change", "no_change", "no_change"])
    ctx.events[-1]["payload"]["call_id"] = service_call["id"]

    evaluated = CallCriterion().evaluate(ctx)

    assert evaluated.score == pytest.approx(1)
    assert "(бригада службы): верно" in evaluated.evidence[1]
    assert evaluated.evidence[3] == (
        "Другой звонок — Доклад службе 102: полного доклада нет — не представился; "
        "без карточки; без того, что изменилось (3 раза)"
    )
