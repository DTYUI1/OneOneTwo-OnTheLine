"""Генерация на каркасе формата 2: записанные доклады и адрес, согласованный с событиями."""

import re
from copy import deepcopy
from pathlib import Path
from uuid import uuid4

import pytest
from app.worker.generators import gameplay
from app.worker.generators.validation import GenerationRejected, validate_gameplay

from . import test_scenario_phrases as phrases

SERVICES = ["101", "102", "103", "104", "GKH", "MOSLIFT"]


def response_for(spec, pick=-1):
    """Ответ «модели»: по фразе из вариантов каждого доклада, согласованный набор."""
    facts = spec["facts"]
    for shift in range(5):
        response = {
            "choices": {
                r["state"]: r["options"][(pick + shift) % len(r["options"])]
                for r in facts["reports"]
            }
        }
        try:
            gameplay.chosen_phrases(spec, response)
            return response
        except GenerationRejected:
            continue
    return gameplay.fallback_response(spec)


@pytest.mark.parametrize("service", SERVICES)
@pytest.mark.parametrize("level", [1, 2, 3, 4])
def test_every_service_and_level_builds_a_checked_voiced_file(service, level):
    for seed in range(4):
        spec = gameplay.gameplay_input(service_id=service, level=level, seed=seed)
        template = spec["template"]
        data = gameplay.build_gameplay(
            spec, response_for(spec), scenario_id=uuid4(), origin="llm", auto_admit=True
        )
        # Ловушка привязана к записи; без неё адрес может меняться вместе с эталоном.
        if any(e["kind"] == "readback_error" for e in data.get("events", [])):
            assert data["card"]["address"] == template["card"]["address"]
        assert data["reference"]["expected_address"] == data["card"]["address"]
        assert data["card"]["address"]["apartment"] == template["card"]["address"]["apartment"]
        # События — шаблона (на 3–4 уровне лишние убраны); на 4-м код может добавить молчание.
        added = [e for e in data.get("events", []) if e not in template.get("events", [])]
        assert all(e["kind"] == "silence" for e in added) and (level == 4 or not added)
        assert set(data.get("traps") or ()) <= set(template.get("traps") or ())
        if level <= 2:
            assert data.get("events") == template.get("events")
        assert data["reference"]["expected_flow"] == template["reference"]["expected_flow"]
        assert data["level"] == level and data["code"].startswith("ai-")
        # Каждый доклад — фраза банка с записью на диске.
        for item in data["plan"]:
            assert (gameplay.VOICES / item["line"]["audio"]).exists()
            assert (
                item["line"]["text"]
                in spec["facts"]["reports"][data["plan"].index(item)]["options"]
            )
        # Заявитель и телефон — новые, пол — шаблона; подписи ссылаются на карточку.
        assert data["card"]["caller_name"] != template["card"]["caller_name"]
        female = [
            n.endswith(("вна", "чна"))
            for n in (data["card"]["caller_name"], template["card"]["caller_name"])
        ]
        assert female[0] == female[1]
        assert data["card"]["phone_aon"] != template["card"]["phone_aon"]
        assert re.fullmatch(r"\+7900000\d{4}", data["card"]["phone_aon"])
        assert data["card"]["number"] != template["card"]["number"]
        assert data["card"]["description"] == template["card"]["description"]
        assert data["outcome"]["people"] and data["outcome"]["late"]
        # Правила каталога brikkerdev (test_scenario_phrases) — и для сгенерированного:
        # фразы банка на своём месте и происшествии, с записью, без повторов и споров фактов.
        phrases.test_every_line_is_a_bank_phrase(data)
        phrases.test_bank_lines_are_voiced(data)
        phrases.test_facts_agree_with_card_and_each_other(data)


def test_fallback_is_the_template_story_and_honest():
    spec = gameplay.gameplay_input(service_id="101", level=1, seed=0)
    data = gameplay.build_gameplay(
        spec,
        gameplay.fallback_response(spec),
        scenario_id=uuid4(),
        origin="template",
        auto_admit=True,
    )
    template = spec["template"]
    assert [i["line"]["text"] for i in data["plan"]] == [
        i["line"]["text"] for i in template["plan"]
    ]
    assert "не результат ИИ" in data["teacher_comment"]


@pytest.mark.parametrize("defect", ["foreign_phrase", "missing_report", "extra_text"])
def test_model_can_only_pick_offered_phrases(defect):
    spec = gameplay.gameplay_input(service_id="101", level=1, seed=3)
    response = deepcopy(response_for(spec))
    if defect == "foreign_phrase":
        response["choices"]["arrived"] = "Прибыли, всё сгорело, трое погибших."
    elif defect == "missing_report":
        response["choices"].pop("arrived")
    else:
        response["description"] = "Пожар потушен, работы завершены."
    with pytest.raises(GenerationRejected):
        validate_gameplay(spec["facts"], response)


def test_story_options_stay_on_the_same_situation():
    # Котёнок в вентшахте: варианты прибытия и работ — про котёнка, не про собаку в приямке.
    spec = gameplay.gameplay_input(service_id="GKH", level=1, seed=4)
    for report in spec["facts"]["reports"]:
        if report["state"] in {"arrived", "working"}:
            assert not any("Собака" in text for text in report["options"])


def test_templates_cover_all_services_and_skip_not_ours():
    codes = {t["code"] for t in gameplay.templates()}
    assert {t["service_id"] for t in gameplay.templates()} == set(SERVICES)
    assert not any(code.startswith("not-ours") for code in codes)
    assert Path(gameplay.PROMPT).exists()


def test_levels_3_and_4_follow_catalog_rule_and_keep_recommended_weight():
    # Правило уровней (HQ-009, 18.10): 3 — ловушка повтора адреса и вопрос бригады или
    # просьба о службе; 4 — плюс тревога или молчание бригады.
    # У ЖКХ ловушку и вопрос даёт каркас pipe-flat-gkh-2.
    for service in SERVICES:
        for seed in range(4):
            for level in (3, 4):
                spec = gameplay.gameplay_input(service_id=service, level=level, seed=seed, weight=9)
                data = gameplay.build_gameplay(
                    spec, response_for(spec), scenario_id=uuid4(), origin="llm", auto_admit=True
                )
                assert data["weight"] == 9 and data["level"] == level
                kinds = [e["kind"] for e in data["events"]]
                hard = [k for k in kinds if k in ("silence", "alarm")]
                assert len(hard) == (level == 4), (service, level, kinds)
                asks = [k for k in kinds if k in ("clarify", "request_service")]
                assert kinds.count("readback_error") == 1 and len(asks) == 1, kinds
                assert data["traps"] == [
                    e["key"] for e in data["events"] if e["kind"] == "readback_error"
                ]


def test_new_caller_reaches_reply_labels_and_repeats_by_seed():
    # Подписи вариантов с {caller_phone}/{caller_name} (card_fields) после загрузки называют
    # нового заявителя: бригада спрашивает телефон — на кнопке номер этой карточки.
    from app.seed.card_fields import fill

    templates = [t for t in gameplay.templates() if "{caller_" in str(t.get("events"))]
    assert templates
    for template in templates:
        spec = next(
            spec
            for seed in range(40)
            if (
                spec := gameplay.gameplay_input(
                    service_id=template["service_id"],
                    level=template["level"],
                    seed=seed,
                    vary=False,
                )
            )["template"]["code"]
            == template["code"]
        )
        data = gameplay.build_gameplay(
            spec, response_for(spec), scenario_id=uuid4(), origin="llm", auto_admit=True
        )
        labels = [
            fill(option["label"], data["card"])
            for event in data.get("events", [])
            for option in event.get("reply_options", [])
            if "{caller_" in option["label"]
        ]
        assert labels, template["code"]
        for label in labels:
            assert template["card"]["caller_name"].split()[0] not in label
            assert (
                data["card"]["phone_aon"][-4:-2] in label
                or data["card"]["caller_name"].split()[0] in label
            )
            assert "{" not in label
    # Тот же сид — тот же заявитель: пакет воспроизводится.
    one = gameplay.new_caller(templates[0], 5)
    assert one == gameplay.new_caller(templates[0], 5)
