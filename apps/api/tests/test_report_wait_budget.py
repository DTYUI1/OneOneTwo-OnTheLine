"""GP-12: пауза между докладами бригады — не больше 40 с (docs/dds_gameplay.md, раздел 1, п. 5).

Задержка ветки события (`delay`) и неверного адреса во вводной не отодвигает доклад дальше
`MAX_REPORT_WAIT` от начала его ожидания, а сроки событий в файлах сценариев укладываются в
этот бюджет: исход события, которого ждёт доклад или на который мир отвечает репликой,
решается не позже 40 с от реплики, с которой начался отсчёт.
"""

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from app.api.training.gating import MAX_REPORT_WAIT, ScheduledReport, delayed
from app.seed.scenario_lint import REPORT_WAIT_S, wait_problems
from app.seed.scenarios import SCENARIOS_DIR

START = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)


def report(after_s: int) -> ScheduledReport:
    return ScheduledReport(
        planned={},
        identity=(uuid4(), 1),
        brigade_id=uuid4(),
        target_id=uuid4(),
        issued=False,
        waiting_started_at=START,
        ready_at=START + timedelta(seconds=after_s),
    )


def test_delay_stops_at_report_pause_budget():
    item = report(6)
    assert item.ready_at is not None
    # Неисправленный повтор адреса: +45 с — доклад всё равно через 40 с ожидания.
    assert delayed(item, item.ready_at, timedelta(seconds=45)) == START + MAX_REPORT_WAIT
    # Короткая задержка в бюджет укладывается сама.
    assert delayed(item, item.ready_at, timedelta(seconds=20)) == START + timedelta(seconds=26)


def test_delay_never_issues_report_before_event_outcome():
    item = report(6)
    outcome = START + timedelta(seconds=55)
    assert delayed(item, outcome, timedelta(seconds=30)) == outcome


def test_report_without_wait_start_keeps_plain_delay():
    item = ScheduledReport({}, (uuid4(), 1), uuid4(), uuid4(), False, None, START)
    assert delayed(item, START, timedelta(seconds=90)) == START + timedelta(seconds=90)


@pytest.mark.parametrize("path", sorted(SCENARIOS_DIR.glob("*.json")), ids=lambda p: p.stem)
def test_event_deadlines_fit_report_pause(path):
    """Правило — линтера связности (`scenario_lint.wait_problems`): загрузчик не примет файл,
    где исход события, которого ждёт доклад, решается позже 40 с."""
    data = json.loads(path.read_text(encoding="utf-8"))
    assert wait_problems(data) == []
    assert REPORT_WAIT_S == int(MAX_REPORT_WAIT.total_seconds())


def test_late_event_deadline_is_named():
    data = json.loads((SCENARIOS_DIR / "gas-entrance-104-2.json").read_text(encoding="utf-8"))
    data["events"][0]["expect"][0]["within_s"] = 60
    [problem] = wait_problems(data)
    assert "решается через 63 с" in problem
