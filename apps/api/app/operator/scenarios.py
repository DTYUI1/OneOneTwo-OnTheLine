"""Загрузка сценариев звонков и опросных карт data/operator/ (Q29 — без генерации диалога)."""

import json
from functools import lru_cache
from typing import Any

from jsonschema import Draft202012Validator

from app.core.config import ROOT

SCENARIOS_DIR = ROOT / "data" / "operator" / "scenarios"
QUESTIONNAIRES_DIR = ROOT / "data" / "operator" / "questionnaires"
CLASSIFIER_PATH = ROOT / "data" / "classifier.json"

# Этап 3: шаги опроса (questionnaire.schema.json) и вопросы с закреплённым шагом — на них
# держатся правило «адрес первым» и критерий «Порядок опроса».
STEPS = range(1, 6)
FIXED_STEPS = {"address": 1, "confirm_address": 1, "callback": 2}
# Такие типы классификатора оператору 112 не показываются — как HIDDEN_SIGN на вебе
# (apps/web/src/operator/data.ts); сценарий не может их ждать.
HIDDEN_SIGN = "Не отображается оператору 112"


def _read_json(path: Any) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache
def _validator(name: str) -> Draft202012Validator:
    schema = _read_json(ROOT / "contracts" / "operator" / f"{name}.schema.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


@lru_cache
def load_classifier() -> dict[str, Any]:
    return _read_json(CLASSIFIER_PATH)  # type: ignore[no-any-return]


@lru_cache
def load_questionnaires() -> dict[str, dict[str, Any]]:
    """id опросной карты -> её содержимое; проверено questionnaire.schema.json."""
    validator = _validator("questionnaire")
    result: dict[str, dict[str, Any]] = {}
    for path in sorted(QUESTIONNAIRES_DIR.glob("*.json")):
        data = _read_json(path)
        validator.validate(data)
        if data["id"] != path.stem:
            raise ValueError(f"Опросная карта {path.name}: id не совпадает с именем файла")
        if data["id"] in result:
            raise ValueError(f"Повтор id опросной карты: {data['id']}")
        _check_steps(data)
        result[data["id"]] = data
    return result


def _check_steps(card: dict[str, Any]) -> None:
    """Этап 3: у каждого шага опроса есть вопрос карты, ключи не повторяются, адрес и его
    повтор — на шаге 1, номер для обратной связи — на шаге 2."""
    keys = [question["key"] for question in card["questions"]]
    if len(keys) != len(set(keys)):
        raise ValueError(f"Опросная карта {card['id']}: повтор ключа вопроса")
    steps = {question["key"]: question["step"] for question in card["questions"]}
    empty = [step for step in STEPS if step not in steps.values()]
    if empty:
        raise ValueError(f"Опросная карта {card['id']}: нет вопросов шагов {empty}")
    for key, step in FIXED_STEPS.items():
        if key in steps and steps[key] != step:
            raise ValueError(f"Опросная карта {card['id']}: вопрос {key} — не на шаге {step}")


@lru_cache
def load_scenarios() -> list[dict[str, Any]]:
    """Сценарии data/operator/scenarios/, проверенные схемой и перекрёстными ссылками."""
    validator = _validator("scenario")
    questionnaires = load_questionnaires()
    incident_codes = {
        row["code"] for row in load_classifier()["incident_types"] if row["sign1"] != HIDDEN_SIGN
    }
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for path in sorted(SCENARIOS_DIR.glob("*.json")):
        data = _read_json(path)
        validator.validate(data)
        if data["id"] != path.stem:
            raise ValueError(f"Сценарий {path.name}: id не совпадает с именем файла")
        if data["id"] in seen:
            raise ValueError(f"Повтор id сценария: {data['id']}")
        seen.add(data["id"])
        code = data["incident_type_code"]
        if code is not None and code not in incident_codes:
            raise ValueError(f"Сценарий {data['id']}: код {code} не найден в классификаторе")
        _check_other_types(data, incident_codes)
        if set(data.get("optional_tags", ())) & set(data["expected_tags"]):
            raise ValueError(f"Сценарий {data['id']}: тег и обязателен, и необязателен")
        questionnaire_id = data["questionnaire_id"]
        if questionnaire_id is None:
            if data["answers"]:
                raise ValueError(f"Сценарий {data['id']}: без карты ответы не нужны")
        else:
            if questionnaire_id not in questionnaires:
                raise ValueError(
                    f"Сценарий {data['id']}: опросная карта {questionnaire_id} не найдена"
                )
            keys = {q["key"] for q in questionnaires[questionnaire_id]["questions"]}
            unknown = set(data["answers"]) - keys
            if unknown:
                raise ValueError(f"Сценарий {data['id']}: ответы на неизвестные вопросы {unknown}")
            _check_live_call(data, keys)
        result.append(data)
    return result


def _check_other_types(data: dict[str, Any], incident_codes: set[str]) -> None:
    """Равнозначные и близкие типы: есть в классификаторе, видны оператору 112, не повторяют
    эталон и друг друга; у ошибочного звонка их нет."""
    accepted = set(data.get("accepted_incident_type_codes", ()))
    close = set(data.get("close_incident_type_codes", ()))
    if data["incident_type_code"] is None and (accepted or close):
        raise ValueError(f"Сценарий {data['id']}: у ошибочного звонка нет других типов")
    if data["incident_type_code"] in accepted | close or accepted & close:
        raise ValueError(f"Сценарий {data['id']}: другой тип повторяет эталон или другой тип")
    unknown = (accepted | close) - incident_codes
    if unknown:
        raise ValueError(f"Сценарий {data['id']}: коды {sorted(unknown)} не видны оператору 112")


def _check_live_call(data: dict[str, Any], question_keys: set[str]) -> None:
    """Этап 2: совет на ухудшение есть среди советов, ухудшение ждёт вопроса своей карты.

    Этап 3: на повтор адреса есть ответы (address_confirmation), ответа карты на него нет;
    ключи лишних вопросов не повторяются и не совпадают с вопросами карты.
    """
    if "confirm_address" in question_keys:
        if "address_confirmation" not in data:
            raise ValueError(f"Сценарий {data['id']}: нет ответов на повтор адреса")
        if "confirm_address" in data["answers"]:
            raise ValueError(
                f"Сценарий {data['id']}: на повтор адреса отвечает address_confirmation"
            )
    distractors = [item["key"] for item in data["distractors"]]
    if len(distractors) != len(set(distractors)):
        raise ValueError(f"Сценарий {data['id']}: повтор ключа лишнего вопроса")
    if set(distractors) & question_keys:
        raise ValueError(f"Сценарий {data['id']}: лишний вопрос совпадает с вопросом карты")
    advice = [item["key"] for item in data.get("advice", [])]
    if len(advice) != len(set(advice)):
        raise ValueError(f"Сценарий {data['id']}: повтор ключа совета")
    escalation = data.get("escalation")
    if escalation is None:
        return
    if escalation["after_question"] not in question_keys:
        raise ValueError(
            f"Сценарий {data['id']}: ухудшение ждёт вопроса {escalation['after_question']}, "
            "которого нет в опросной карте"
        )
    if escalation["advice"] not in advice:
        raise ValueError(f"Сценарий {data['id']}: совета {escalation['advice']} нет в advice")
    if escalation["after_s"] > escalation["latest_s"]:
        raise ValueError(f"Сценарий {data['id']}: after_s позже latest_s")


def expected_services(incident_type_code: str | None, tags: set[str]) -> set[str]:
    """Службы по routing_rules: правило действует, если его trigger — «default» или тег выбран."""
    if incident_type_code is None:
        return set()
    services: set[str] = set()
    for rule in load_classifier()["routing_rules"]:
        if rule["incident_type_code"] != incident_type_code:
            continue
        trigger = rule["condition"]["trigger"]
        if trigger == "default" or trigger in tags:
            services.add(rule["service_id"])
    return services
