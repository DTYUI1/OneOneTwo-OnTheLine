"""Поколения учебных сценариев: бригада докладывает о каждом статусе эталона (28.09)."""

from uuid import NAMESPACE_URL, uuid5

from app.api.training.status_evidence import justified_state
from app.seed.training import AUDIO_GENERATIONS, AudioGeneration, uncovered_states


def test_every_distributed_generation_reports_each_expected_state():
    # Статус хода работ ставится по факту доклада (памятка ДДС, стр. 22): если эталон ждёт
    # статус, о котором бригада не докладывает, обучаемый закрывает карточку вслепую.
    for generation in AUDIO_GENERATIONS:
        if generation.retired:
            continue
        assert generation.expected_flow is not None, generation.key
        assert uncovered_states(generation) == [], generation.key


def test_generation_without_completion_report_is_caught():
    legacy = next(item for item in AUDIO_GENERATIONS if item.key == "audio-demo")
    assert legacy.retired
    assert "completion" not in legacy.stages
    # Тот же набор докладов с эталоном основы — «Работы завершены» ничем не обоснован.
    check = AudioGeneration(
        key="check",
        stages=legacy.stages,
        card_number_prefix="0",
        expected_flow=["received", "accepted", "responding", "completed"],
    )
    assert uncovered_states(check) == ["completed"]


def test_issued_text_demo_reports_keep_their_stage_meaning():
    scenario_id = uuid5(NAMESPACE_URL, "arm112:c04:text-demo")
    for index, state in ((0, "arrived"), (1, "completed")):
        planned = {"message": {"id": str(uuid5(scenario_id, f"message:{index}"))}}
        assert justified_state(planned, scenario_id) == state
