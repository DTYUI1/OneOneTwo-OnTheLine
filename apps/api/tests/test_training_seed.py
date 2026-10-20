"""Поколения учебных сценариев: бригада докладывает о каждом статусе эталона (28.09)."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import NAMESPACE_URL, uuid5

from app.api.training.status_evidence import justified_state
from app.seed.training import AUDIO_GENERATIONS, AudioGeneration, seed_catalog, uncovered_states


def test_catalog_names_match_brigade_numbers_and_keep_seed_ids():
    services = [
        SimpleNamespace(id=service, category=category, phone_ext=service, voice_profile="voice")
        for service, category in (("101", "fire"), ("102", "police"), ("112", "system112"))
    ]
    db = AsyncMock()
    db.scalars.return_value = services
    asyncio.run(seed_catalog(db))
    records = [call.args[0].compile().params for call in db.execute.call_args_list]
    brigades = {row["id"]: row for row in records if "phone_ext" not in row}
    targets = [row for row in records if row.get("brigade_id") is not None]
    assert [row["phone_ext"] for row in targets] == [
        "201",
        "202",
        "301",
        "302",
        "203",
        "204",
        "303",
        "304",
    ]
    for target in targets:
        ext = target["phone_ext"]
        assert target["name"] == f"Старший бригады {ext}"
        assert brigades[target["brigade_id"]]["name"] == f"Бригада {ext}"
    for service in ("101", "102"):
        for ordinal in range(4):
            brigade = uuid5(NAMESPACE_URL, f"arm112:c04:{service}:brigade:{ordinal}")
            target = uuid5(NAMESPACE_URL, f"arm112:c04:{service}:target:{ordinal}")
            assert brigades[brigade]["service_id"] == service
            assert any(row["id"] == target and row["brigade_id"] == brigade for row in targets)
    assert all(row["service_id"] != "112" for row in brigades.values())


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


def test_training_names_use_russian_service_name():
    """Имя учебной записи не показывает идентификатор службы латиницей (интерфейс русский).

    Цифровая ДДС остаётся номером, как в АРМ-112; у остальных — название справочника.
    Те же имена видны в телефоне ДДС, поэтому проверяются здесь, у источника.
    """
    from app.core.models import Service
    from app.seed.training import service_tag

    assert service_tag(Service(id="101", name="Служба 101")) == "101"
    assert service_tag(Service(id="GKH", name="ЖКХ")) == "ЖКХ"
    assert service_tag(Service(id="MOSLIFT", name="Мослифт")) == "Мослифт"
