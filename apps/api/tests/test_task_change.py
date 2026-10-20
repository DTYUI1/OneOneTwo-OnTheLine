"""TC-05: доклад с места меняет задачу — эталон карточки после доклада другой (через API).

Сценарий `traffic-fire-102-2` (data/scenarios): ДТП без пострадавших, на работах экипаж
докладывает «под капотом загорелось, нужны пожарные». Доклад несёт `task_change`
(contracts/scenario-events.md, «Доклад меняет задачу»): пока он не прозвучал, эталон прежний —
звонок не обязателен; после — обязателен звонок в 112 в течение минуты от доклада, а в
комментарии ждут пожар. Разбор называет перемену первой строкой критериев «Звонок» и
«Ключевые сведения».
"""

import math
from datetime import datetime
from typing import Any
from uuid import UUID

import pytest
from app.api.evaluations.service import evaluation_context
from evalcore.task_change import changed_reference  # type: ignore[import-untyped]

from . import test_final_scenarios as final
from .test_c04_completion import seed_training
from .test_lifecycle import run_db

CODE = "traffic-fire-102-2"
pytestmark = pytest.mark.usefixtures("seat")


@pytest.fixture
def seat(monkeypatch: pytest.MonkeyPatch) -> None:
    # Обучаемый ДДС 102 (data/seed/demo_users.json), как у сценария на финал той же службы.
    monkeypatch.setitem(final.SEATS, CODE, ("102", "trainee01"))


def reference(shift: final.Shift) -> tuple[dict[str, Any], list[str]]:
    """Эталон карточки сейчас — тот, по которому её оценили бы: из журнала, как у оценки."""

    async def load(db: Any) -> tuple[dict[str, Any], list[str]]:
        context, *_ = await evaluation_context(db, UUID(shift.card_id))
        found, changes = changed_reference(context)
        return found, [change.label for change in changes]

    return run_db(shift.url, load)


def conversation(shift: final.Shift) -> tuple[dict[str, Any], ...]:
    """Реплики собеседников по карточке — как их видит оценка (`EvalContext.lines`)."""

    async def load(db: Any) -> tuple[dict[str, Any], ...]:
        context, *_ = await evaluation_context(db, UUID(shift.card_id))
        return context.lines

    return run_db(shift.url, load)


def walk(shift: final.Shift, *, call_112: bool, guess: bool = False) -> dict[str, Any]:
    """Карточка по плану; после доклада о работах — звонок в 112 и «пожарные вызваны» экипажу
    (или ничего). Эталоны по ходу.

    `guess` — пожар записан в комментарий при «Принята», до доклада, а потом о нём ни слова
    (HQ-020: «знал по прошлому прохождению»).

    Экипаж, которого предупредили, о пожарных не спрашивает (GP-28, «служба вызвана заранее»);
    без звонка спрашивает дважды, и итог приходит позже и другим (машина выгорела)."""
    data = shift.data
    shift.open()
    if guess:
        shift.status("accepted", "Принята: ДТП. Под капотом загорится, нужны пожарные.")
    else:
        shift.accept()
    shift.brief()
    seen: dict[str, Any] = {}
    plan = data["plan"]
    for index, report in enumerate(plan):
        key = report["key"]
        if key == "works":
            seen["before"] = reference(shift)
        names = [f"message:{key}", *final.replaced_by(data, key)]
        item = shift.hear(names, 100 if key == "completion" else report["after_s"] + 1)
        if key == "works":
            seen["after"] = reference(shift)
            seen["presented_at"] = next(
                m["presented_at"]
                for m in shift.messages()
                if m["delivery"]["delivery_id"] == item["delivery"]["delivery_id"]
            )
            if call_112:
                shift.dial("112")
                shift.send(
                    "brigade_said", {"call_id": shift.call_id, "text": "Пожарные вызваны, едут"}
                )
        if index < len(plan) - 1:
            line = "Экипаж работает." if guess else final.line_text(report["line"])
            shift.status(report["justifies_state"], line)
            continue
        shift.hang_up()
        shift.status(
            "completed",
            "Работы закончили, наряд освободился."
            if guess
            else report_change(data)["expected_comment"],
        )
    return seen


def report_change(data: dict[str, Any]) -> dict[str, Any]:
    return next(report["task_change"] for report in data["plan"] if "task_change" in report)


def test_reference_after_report_differs_and_call_in_time_is_clean(
    database_config, database_url, request
):
    seed_training(database_url)
    shift = final.open_shift(database_config, database_url, request, CODE)
    change = report_change(shift.data)
    seen = walk(shift, call_112=True)

    before, none = seen["before"]
    assert none == []
    assert before == shift.data["reference"]
    assert before["expected_call"]["required"] is False

    after, labels = seen["after"]
    assert labels == [change["label"]]
    assert after["expected_call"]["required"] is True
    assert (after["expected_call"]["service_id"], after["expected_call"]["phone_ext"]) == (
        "112",
        "112",
    )
    assert after["expected_comment"] == change["expected_comment"]
    assert after["comment_keywords"] == change["comment_keywords"]
    # Срок звонка — от выдачи карточки до доклада плюс минута (within_s).
    delivered = datetime.fromisoformat(
        next(
            e
            for e in shift.client.get(f"/api/cards/{shift.card_id}/events").json()
            if e["type"] == "deliver"
        )["client_ts"].replace("Z", "+00:00")
    )
    presented = datetime.fromisoformat(seen["presented_at"].replace("Z", "+00:00"))
    assert after["expected_call"]["before_s"] == math.ceil(
        (presented - delivered).total_seconds() + 60
    )

    # HQ-020: доклады плана — `planned` и прозвучали; реплика события, которое не сработало
    # (экипаж предупредили — о пожарных не спрашивает), — не `planned` и не прозвучала.
    lines = {line["text"]: line for line in conversation(shift)}
    for report in shift.data["plan"]:
        heard = lines[final.line_text(report["line"])]
        assert heard["planned"] is True and heard["presented_at"] is not None, heard
    asked = next(e for e in shift.data["events"] if e["key"] == "firefighters-again")
    assert lines[final.line_text(asked["line"])] == {
        "text": final.line_text(asked["line"]),
        "presented_at": None,
        "planned": False,
    }

    evaluation = shift.evaluation()
    assert final.clean(evaluation) == {}, evaluation.explanation
    line = f"Задача изменилась после доклада бригады: {change['label'].rstrip('.')}."
    for key in ("call", "comment_keywords"):
        assert evaluation.explanation[key]["evidence"][0] == line, key


def test_no_call_after_changed_task_is_named_in_review(database_config, database_url, request):
    seed_training(database_url)
    shift = final.open_shift(database_config, database_url, request, CODE)
    change = report_change(shift.data)
    walk(shift, call_112=False)

    evaluation = shift.evaluation()
    # В 112 не звонили: лучший звонок — вводная своей бригаде, адресат неверный.
    assert evaluation.rules_scores["call"] < 1
    assert "call" in evaluation.critical_flags
    lines = final.explanation(evaluation, "call")
    assert lines[1] == f"Задача изменилась после доклада бригады: {change['label'].rstrip('.')}."
    assert any(line.startswith("Адресат 102/") and line.endswith("неверно") for line in lines)


def test_fire_written_before_the_report_is_not_counted(database_config, database_url, request):
    """HQ-020: пожар в комментарии до доклада «под капотом загорелось» угадан — не засчитан."""
    seed_training(database_url)
    shift = final.open_shift(database_config, database_url, request, CODE)
    walk(shift, call_112=True, guess=True)

    evaluation = shift.evaluation()
    assert evaluation.rules_scores["comment_keywords"] < 1
    lines = final.explanation(evaluation, "comment_keywords")
    assert any(
        "пожар" in line
        and line.endswith("записано до того, как прозвучало в разговоре, — не засчитано")
        for line in lines
    ), lines
