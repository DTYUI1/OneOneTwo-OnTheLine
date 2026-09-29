"""Pure, deterministic construction of a draft scenario from supplied source data.

The classifier is injected by the caller. This module never reads files or guesses
whether a classifier condition with no constructor flag is true.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any
from uuid import UUID, uuid5

_NAMESPACE = UUID("5ec79b8e-885f-4f39-9eb1-b987377e5e21")
_MAIN_SERVICE = {
    "MCHS": "101",
    "Police": "102",
    "AMBULANCE": "103",
    "MOSGAZ": "104",
    "GKH": "GKH",
    "MOSLIFT": "MOSLIFT",
}
_COMPLICATIONS = frozenset(
    {"wrong_address", "duplicate", "no_phone", "no_contact", "emergency", "parallel"}
)
_ADDRESS_FIELDS = ("city", "okrug", "district", "street", "house", "building", "apartment")


class ScenarioBuildError(ValueError):
    """An input cannot yield a sound reference; `path` maps to HTTP 422 later."""

    def __init__(self, path: str, code: str, message: str) -> None:
        super().__init__(message)
        self.path = path
        self.code = code
        self.message = message


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def _require(condition: bool, path: str, code: str, message: str) -> None:
    if not condition:
        raise ScenarioBuildError(path, code, message)


class ScenarioGenerator:
    """Callable ScenarioBuilder with an immutable classifier snapshot supplied at setup."""

    def __init__(self, classifier: Mapping[str, Any]) -> None:
        _require(
            isinstance(classifier, Mapping), "classifier", "missing_source", "Нужен классификатор."
        )
        self._classifier = json.loads(_canonical(classifier))
        self._digest = hashlib.sha256(_canonical(self._classifier)).hexdigest()
        self._types = {item["code"]: item for item in self._classifier.get("incident_types", [])}
        self._services = {item["id"]: item for item in self._classifier.get("services", [])}
        self._rules: dict[str, list[dict[str, Any]]] = {}
        for rule in self._classifier.get("routing_rules", []):
            self._rules.setdefault(rule["incident_type_code"], []).append(rule)
        _require(
            bool(self._types and self._services),
            "classifier",
            "invalid_source",
            "Классификатор пуст.",
        )

    def __call__(self, constructor: dict[str, Any]) -> dict[str, Any]:
        _require(
            isinstance(constructor, dict),
            "constructor",
            "invalid",
            "Ожидается объект конструктора.",
        )
        required = {
            "incident_type_code",
            "target_service_id",
            "address",
            "victims",
            "complications",
            "level",
            "weight",
            "seed",
        }
        _require(
            set(constructor) == required,
            "constructor",
            "invalid",
            "Поля конструктора не соответствуют контракту.",
        )
        code = constructor["incident_type_code"]
        target = constructor["target_service_id"]
        _require(
            isinstance(code, str) and code in self._types,
            "incident_type_code",
            "unknown_type",
            "Неизвестный тип происшествия.",
        )
        _require(
            isinstance(target, str)
            and target in self._services
            and self._services[target].get("is_active") is True,
            "target_service_id",
            "unknown_service",
            "Неизвестная или неактивная служба.",
        )
        _require(
            type(constructor["victims"]) is bool,
            "victims",
            "invalid",
            "Признак пострадавших должен быть boolean.",
        )
        for field, low, high in (("level", 1, 4), ("weight", 1, 10)):
            value = constructor[field]
            _require(
                type(value) is int and low <= value <= high,
                field,
                "out_of_range",
                f"{field}: допустимо {low}…{high}.",
            )
        _require(
            type(constructor["seed"]) is int, "seed", "invalid", "seed должен быть целым числом."
        )
        complications = constructor["complications"]
        _require(
            isinstance(complications, list)
            and all(isinstance(x, str) and x in _COMPLICATIONS for x in complications)
            and len(complications) == len(set(complications)),
            "complications",
            "invalid",
            "Неизвестное или повторное осложнение.",
        )
        address = constructor["address"]
        _require(
            isinstance(address, dict) and set(address) == set(_ADDRESS_FIELDS),
            "address",
            "invalid",
            "Адрес не соответствует контракту.",
        )
        _require(
            all(isinstance(address[key], str) for key in _ADDRESS_FIELDS)
            and all(address[key].strip() for key in ("city", "street", "house")),
            "address",
            "invalid",
            "Нужны город, улица и дом.",
        )

        incident = self._types[code]
        services = self._route(code, incident, constructor["victims"])
        _require(
            target in services,
            "target_service_id",
            "unroutable",
            "Служба не следует из типа и заданных признаков.",
        )
        # Canonical input and source content keep IDs stable across processes and JSON key order.
        key = hashlib.sha256(
            _canonical({"constructor": constructor, "classifier_sha256": self._digest})
        ).hexdigest()
        scenario_id = str(uuid5(_NAMESPACE, key))
        number = str(10_000_000 + int(key[:12], 16) % 90_000_000)
        true_address = dict(address)
        shown_address = dict(address)
        if "wrong_address" in complications:
            # The visible clarification lets the trainee detect the discrepancy.
            shown_address["street"] = address["street"] + "?"
        place = f"{address['city']}, {address['street']}, дом {address['house']}"
        description = f"Учебное сообщение: {incident['name']}. Адрес: {place}."
        if "wrong_address" in complications:
            description += " Заявитель уточнил улицу; в поле адреса есть неточность."
        if "duplicate" in complications:
            description += " Заявитель сообщает о повторном обращении."
        if "no_contact" in complications:
            description += " Связь с заявителем прервалась."
        if "parallel" in complications:
            description += " Одновременно поступило ещё одно обращение."
        if "emergency" in complications:
            description += " Есть признак чрезвычайной ситуации."
        tags = list(
            dict.fromkeys(
                filter(None, (incident.get("sign1"), incident.get("sign2"), incident.get("sign3")))
            )
        )
        if constructor["victims"]:
            tags.append("Пострадавшие")
        tags = list(dict.fromkeys(tags))
        phone = "" if "no_phone" in complications else "+79000000000"
        scenario = {
            "id": scenario_id,
            "version": 1,
            "level": constructor["level"],
            "weight": constructor["weight"],
            "incident_type_code": code,
            "target_service_id": target,
            "card": {
                "number": number,
                "incident_type_code": code,
                "caller_name": "Не установлен"
                if "no_contact" in complications
                else "Учебный заявитель",
                "phone_aon": phone,
                "phone_provided": "",
                "phone_scene": "",
                "address": shown_address,
                "description": description,
                "tags": tags,
                "victims": constructor["victims"],
                "ambulance_refused": False,
                "blocked_people": False,
                "emergency": "emergency" in complications,
                "incident_class": incident["name"],
                "service_ids": services,
            },
            "reference": {
                "expected_flow": ["received", "accepted", "responding", "completed"],
                "required_fields": ["service_number", "comment"],
                "expected_service_ids": services,
                "expected_address": true_address,
                "expected_call": {
                    "required": True,
                    "service_id": target,
                    "phone_ext": self._services[target]["phone_ext"],
                    "before_s": 180,
                },
                "expected_comment": (
                    f"В службу {target} передана информация: {incident['name']}. Адрес: {place}."
                ),
            },
            "complications": list(complications),
            "origin": "template",
            "status": "draft",
            "teacher_comment": "Синтетический сценарий; требуется проверка преподавателя.",
        }
        suggested = min(
            10,
            max(1, 2 * constructor["level"] - 1 + int(constructor["victims"]) + len(complications)),
        )
        validation_errors = []
        if "wrong_address" in complications:
            validation_errors.append(
                {
                    "path": "complications",
                    "code": "dds_address_policy_unresolved",
                    "message": (
                        "Проверка исходного адреса диспетчером ДДС не подтверждена: "
                        "ответ заказчика от 23.09 относит контроль карточки к оператору 112."
                    ),
                }
            )
        return {
            "scenario": scenario,
            "suggested_weight": suggested,
            "validation_errors": validation_errors,
            "provenance": {
                "author_kind": "system",
                "author_id": None,
                "source_kind": "template",
                "source_id": f"classifier:{self._classifier.get('version', 'unknown')}:{code}",
                "source_version": str(self._classifier.get("version", "unknown")),
                "sha256": self._digest,
                "synthetic": True,
            },
            "training_plan": None,
        }

    def _route(self, code: str, incident: Mapping[str, Any], victims: bool) -> list[str]:
        main = _MAIN_SERVICE.get(str(incident.get("main_service_code", "")))
        _require(
            main in self._services and self._services[main].get("is_active") is True,
            "incident_type_code",
            "unroutable",
            "Для типа не определена активная основная служба.",
        )
        selected = {main}
        for rule in self._rules.get(code, []):
            service = rule["service_id"]
            trigger = rule.get("condition", {}).get("trigger")
            # Условие по стабильному trigger, а не номеру колонки: он разный в 046_11 и 046_24.
            # Остальные условия требуют признаков, которых нет в ScenarioConstructor.
            if (
                service in ("MOSLIFT", "GKH")
                or (service == "103" and trigger == "default" and not victims)
                or (service in ("102", "103") and trigger == "victims" and victims)
            ):
                if service in self._services and self._services[service].get("is_active") is True:
                    selected.add(service)
        return [service for service in self._services if service in selected]


def build(constructor: dict[str, Any], *, classifier: Mapping[str, Any]) -> dict[str, Any]:
    """Build a ScenarioPreview; caller loads the classifier outside the pure core."""
    return ScenarioGenerator(classifier)(constructor)
