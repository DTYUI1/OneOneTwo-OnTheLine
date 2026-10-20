"""Структурная и предметная границы генерации, независимые от дисциплины модели."""

import json
import re
from functools import lru_cache
from os.path import commonprefix
from typing import Any

from jsonschema import Draft202012Validator

from app.core.config import ROOT

SERVICES = frozenset({"101", "102", "103", "104", "GKH", "MOSLIFT"})
FULL_REPORT_STATES = ["responding", "arrived", "working", "completed"]
REFUSAL_REPORT_STATES = ["responding", "arrived", "refused"]
PROMPT_VERSION = "dds-bank-v1"


class GenerationRejected(ValueError):
    """Непригодный ввод или ответ нельзя сохранять как допущенный сценарий."""


class GenerationUnavailable(RuntimeError):
    """Временный сбой сервера модели: задание можно повторить."""


@lru_cache
def response_validator() -> Draft202012Validator:
    schema = json.loads((ROOT / "contracts/scenario-generation.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def validate_facts(facts: dict[str, Any]) -> None:
    """Проверить вход до запроса модели; противоречивый тест A обходит только этот шаг."""
    if facts.get("service") not in SERVICES or type(facts.get("level")) is not int:
        raise GenerationRejected("Нужны поддерживаемая служба и уровень 1–4.")
    if not 1 <= facts["level"] <= 4:
        raise GenerationRejected("Уровень должен быть от 1 до 4.")
    if not isinstance(facts.get("address"), str) or len(facts["address"].strip()) < 8:
        raise GenerationRejected("Не указан полный адрес.")
    if type(facts.get("victims")) is not bool or not facts.get("situation"):
        raise GenerationRejected("Нужны ситуация и явный признак пострадавших.")
    outcome = facts.get("outcome")
    if outcome not in {"completed", "refused"}:
        raise GenerationRejected("Исход должен быть completed или refused, не rejected.")
    if facts.get("work_performed") is not (outcome == "completed"):
        raise GenerationRejected("Исход противоречит факту проведения работ.")
    if facts["service"] == "103" and outcome == "refused":
        raise GenerationRejected("Служба 103 не поддерживает отказ от выполнения работ.")
    reports = facts.get("reports")
    expected = FULL_REPORT_STATES if outcome == "completed" else REFUSAL_REPORT_STATES
    if (
        not isinstance(reports, list)
        or not all(isinstance(r, dict) for r in reports)
        or [r.get("state") for r in reports] != expected
    ):
        raise GenerationRejected("Доклады не соответствуют последовательности исхода.")
    if any(
        not isinstance(r.get("options"), list)
        or not 1 <= len(r["options"]) <= 5
        or not all(isinstance(text, str) and text.strip() for text in r["options"])
        or len(set(r["options"])) != len(r["options"])
        for r in reports
    ):
        raise GenerationRejected("Нет фраз банка для доклада.")


def response_schema(facts: dict[str, Any]) -> dict[str, Any]:
    """Схема ответа под этот вход: факты закреплены, выбор — текст одной из фраз доклада.

    llama.cpp строит по ней грамматику, поэтому чужую фразу или изменённый адрес
    модель выдать не может; проверка ниже повторяет это независимо от провайдера.
    """
    schema: dict[str, Any] = json.loads(json.dumps(response_validator().schema))
    # Вход собирает и проверяет код (validate_facts), отказ модели здесь — ложный:
    # она принимала отказ от работ после проверки за противоречие ситуации.
    schema["anyOf"] = schema["anyOf"][:1]
    ready = schema["anyOf"][0]["properties"]
    for key in ("service", "address", "victims", "outcome"):
        ready["facts"]["properties"][key] = {"const": facts[key]}
    if "caller_name" in facts:
        ready["caller_name"] = {"const": facts["caller_name"]}
    ready["choices"] = {
        "type": "object",
        "additionalProperties": False,
        "required": [r["state"] for r in facts["reports"]],
        "properties": {
            r["state"]: {"type": "string", "enum": list(r["options"])} for r in facts["reports"]
        },
    }
    return schema


def _words(text: str) -> set[str]:
    return set(re.findall(r"[а-яa-z]+", text.casefold().replace("ё", "е")))


def _grounded_text(source: str, text: str) -> bool:
    # Проверка необходима сверх schema: модель может скопировать facts и выдумать текст.
    anchors = {word[:5] for word in _words(source) if len(word) >= 5}
    actual = {word[:5] for word in _words(text) if len(word) >= 5}
    return bool(anchors & actual)


def _address_present(address: str, text: str) -> bool:
    """Допускается склонение («Москва» → «в Москве»), но не другая улица или дом."""
    actual = _words(text)
    words_present = all(
        expected in actual
        or any(
            len(expected) >= 5
            and len(word) >= 5
            and len(commonprefix([expected, word])) >= max(4, min(len(expected), len(word)) - 2)
            for word in actual
        )
        for expected in _words(address)
    )
    return words_present and set(re.findall(r"\d+", address)).issubset(re.findall(r"\d+", text))


def with_victims(description: str, victims: bool) -> str:
    """Признак пострадавших в описании ставит код: это факт сюжета, а не текст модели.

    Модель писала «Пострадавших есть.»; короткие фразы о пострадавших заменяются
    дословной формой карточки, длинное предложение с ситуацией не трогается.
    """
    canonical = "Есть пострадавшие." if victims else "Пострадавших нет."
    sentences = [
        sentence
        for sentence in re.split(r"(?<=[.!?])\s+", description.strip())
        if not ("пострадавш" in sentence.casefold() and len(sentence.split()) <= 4)
    ]
    text = " ".join(sentences)
    if canonical.casefold().rstrip(".") not in text.casefold():
        text = f"{text.rstrip()} {canonical}"
    return text


def validate_response(facts: dict[str, Any], response: dict[str, Any]) -> None:
    """Проверить схему, неизменность фактов, выбор фраз и терминальный исход."""
    validate_facts(facts)
    validator = Draft202012Validator(response_schema(facts))
    errors = sorted(validator.iter_errors(response), key=lambda e: e.json_path)
    if errors:
        raise GenerationRejected(f"Ответ не соответствует схеме: {errors[0].json_path}.")
    if response["status"] == "refused":
        raise GenerationRejected(f"Модель отказала: {response['reason']}")
    if response["facts"] != {
        key: facts[key] for key in ("service", "address", "victims", "outcome")
    }:
        raise GenerationRejected("Модель изменила адрес, службу, пострадавших или исход.")
    # Доклады — выбранные фразы банка: их текст не от модели, но он часть фактов сценария.
    reports = [response["choices"][r["state"]] for r in facts["reports"]]
    for field in ("description", "expected_comment"):
        # Итог дополняется facts.address при сборке эталона; повтор адреса в свободном
        # резюме не обязателен. В описании для обучаемого адрес должен присутствовать.
        if field == "description" and not _address_present(facts["address"], response[field]):
            raise GenerationRejected(f"{field}: полный адрес не сохранён.")
        # Эталон пересказывает и сообщение, и выбранные доклады (при отказе — опровержение).
        source = (
            facts["situation"]
            if field == "description"
            else " ".join([facts["situation"], *reports])
        )
        if not _grounded_text(source, response[field]):
            raise GenerationRejected(f"{field}: ситуация не сохранена.")
    content = " ".join(
        [
            response["description"],
            response["expected_comment"],
            *response["tags"],
        ]
    )
    # Невыбранные фразы — не факты сценария: на них модель опираться не может.
    known = {
        **{key: value for key, value in facts.items() if key != "reports"},
        "reports": reports,
    }
    allowed_numbers = set(re.findall(r"\d+", json.dumps(known, ensure_ascii=False)))
    if not set(re.findall(r"\d+", content)).issubset(allowed_numbers):
        raise GenerationRejected("Модель добавила неизвестное числовое обстоятельство.")
    source_text = json.dumps(known, ensure_ascii=False).casefold()
    for marker in ("госпитал", "диагноз", "травм", "погиб", "ранен", "отравлен", "без сознания"):
        # Корень начинается со слова: «устранения засора» не означает «ранения».
        pattern = r"\b" + re.escape(marker)
        if re.search(pattern, content.casefold()) and not re.search(pattern, source_text):
            raise GenerationRejected("Модель добавила неподтверждённые сведения о пострадавших.")
    service_words = {"полици": "102", "пожарн": "101", "скорую": "103", "скорой": "103"}
    for marker in (*service_words, "газопровод", "лифт"):
        if (
            marker in content.casefold()
            and marker not in source_text
            and service_words.get(marker) != facts["service"]
        ):
            raise GenerationRejected("Текст добавляет не заданную службу или объект происшествия.")
    initial = facts["situation"].casefold()
    description = response["description"].casefold()
    for marker in (
        "работы заверш",
        "восстановлен",
        "ликвидирован",
        "устранен",
        "устранён",
        "подгорела еда",
    ):
        if marker in description and marker not in initial:
            raise GenerationRejected("Исход докладов раскрыт в исходном описании карточки.")
    # Итоговая фраза банка проверена при записи банка; от модели — только эталон.
    for text in (response["expected_comment"],):
        ending = text.casefold()
        if facts["outcome"] == "refused":
            if not re.search(r"не (?:провод|потреб|выполн)|отказ", ending):
                raise GenerationRejected("Отказ от работ не обоснован эталоном.")
            if re.search(r"работы (?:заверш|выполн|проводятся)|работаем|приступили", ending):
                raise GenerationRejected("Отказ противоречит проведению или завершению работ.")
        else:
            if re.search(r"\b(?:будет|будут|предстоит|планиру\w*)\b", ending):
                raise GenerationRejected("Завершённый исход описан как будущая работа.")
            if not re.search(r"заверш|выполн|устран|ликвидир|свобод|восстановл", ending):
                raise GenerationRejected("Завершение работ не подтверждено.")
    described = with_victims(response["description"], facts["victims"]).casefold()
    negative_victims = bool(
        re.search(r"пострадавш\w* (?:нет|отсутств)|нет пострадавш|без пострадавш", described)
    )
    positive_victims = bool(re.search(r"есть пострадавш|пострадавш\w* есть", described))
    if (negative_victims and facts["victims"]) or (positive_victims and not facts["victims"]):
        raise GenerationRejected("Описание не сохраняет признак пострадавших.")


def validate_gameplay_facts(facts: dict[str, Any]) -> None:
    """Вход генерации на каркасе шаблона: доклады по порядку, у каждого варианты фраз."""
    if facts.get("kind") != "gameplay" or facts.get("service") not in SERVICES:
        raise GenerationRejected("Нужен каркас поддерживаемой службы.")
    if not isinstance(facts.get("situation"), str) or len(facts["situation"].strip()) < 20:
        raise GenerationRejected("У каркаса нет описания заявителя.")
    reports = facts.get("reports")
    if not isinstance(reports, list) or not reports:
        raise GenerationRejected("У каркаса нет докладов.")
    states = [r.get("state") for r in reports]
    if len(set(states)) != len(states) or states[-1] not in {"completed", "refused"}:
        raise GenerationRejected("Доклады каркаса не доходят до завершения.")
    for report in reports:
        options = report.get("options")
        if (
            not isinstance(options, list)
            or not 1 <= len(options) <= 5
            or len(set(options)) != len(options)
            or not all(isinstance(text, str) and text.strip() for text in options)
        ):
            raise GenerationRejected("Нет фраз банка для доклада.")


def gameplay_schema(facts: dict[str, Any]) -> dict[str, Any]:
    """Строгая схема ответа: доклады — только из вариантов, больше модель ничего не пишет."""
    if facts.get("variants"):
        branches = []
        for variant in facts["variants"]:
            branch = gameplay_schema({"reports": facts["report_sets"][variant["report_set"]]})
            branch["required"].append("variant")
            branch["properties"]["variant"] = {"type": "string", "enum": [variant["id"]]}
            branches.append(branch)
        return {"title": "ScenarioGameplayCorrectionResponse", "oneOf": branches}
    return {
        "title": "ScenarioGameplayResponse",
        "type": "object",
        "additionalProperties": False,
        "required": ["choices"],
        "properties": {
            "choices": {
                "type": "object",
                "additionalProperties": False,
                "required": [r["state"] for r in facts["reports"]],
                "properties": {
                    r["state"]: {"type": "string", "enum": list(r["options"])}
                    for r in facts["reports"]
                },
            },
        },
    }


def validate_gameplay(facts: dict[str, Any], response: dict[str, Any]) -> None:
    """Ответ — выбор фраз из вариантов; связность выбора проверяет gameplay.chosen_phrases."""
    validate_gameplay_facts(facts)
    errors = sorted(
        Draft202012Validator(gameplay_schema(facts)).iter_errors(response),
        key=lambda e: e.json_path,
    )
    if errors:
        raise GenerationRejected(f"Ответ не соответствует схеме: {errors[0].json_path}.")
