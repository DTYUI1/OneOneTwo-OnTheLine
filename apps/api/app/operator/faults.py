"""Ошибки оператора 112, которые дошли до служб (связка 112 → ДДС, contracts/link-112-dds.md).

Не критерий оценки, а сведения для разбора и для построителя сценариев ДДС: что в карточке
не так, как в сюжете, и что из этого следует для службы. Сравнение — то же, что в оценке
оператора (`evaluation.py`), поэтому разбор и балл оператора не расходятся. Решение 08.10:
ошибки считаются здесь, в модуле оператора, без `contract:` к evalcore.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from app.operator.evaluation import (
    CRITICAL_ADDRESS_FIELDS,
    _address_mismatches,
    _type_accepted,
)

FaultKind = Literal["address", "incident_type", "service_missing", "service_extra"]
# wrong_place — бригада по карточке приедет не туда; imprecise — место найдёт, неточность
# видна только в разборе; not_delivered — служба карточку не получила; extra_dispatch —
# лишний выезд; wrong_type — в карточке другой тип происшествия.
FaultEffect = Literal["wrong_place", "imprecise", "wrong_type", "not_delivered", "extra_dispatch"]


@dataclass(frozen=True)
class Fault:
    kind: FaultKind
    effect: FaultEffect
    field: str | None = None
    card: str | None = None
    truth: str | None = None
    service_id: str | None = None

    def as_json(self) -> dict[str, str]:
        """Форма `faults[]` из contracts/examples/link-112-dds-handoff.json: без пустых полей."""
        return {key: value for key, value in vars(self).items() if value is not None}


def operator_faults(
    scenario: Mapping[str, Any],
    *,
    incident_type_code: str | None,
    services: list[str],
    address: Mapping[str, str],
) -> list[Fault]:
    """Расхождения карточки 112 со сценарием оператора — в порядке адрес, тип, службы.

    Адрес: поле считается неверным так же, как в критерии «Адрес» оператора; улица и дом —
    `wrong_place`, остальное — `imprecise`. Тип — если он не равнозначен эталону. Службы —
    по `expected_services` сценария: не выбранная — `not_delivered`, лишняя — `extra_dispatch`.
    """
    scenario = dict(scenario)
    faults: list[Fault] = []
    for field in _address_mismatches(scenario, address):
        faults.append(
            Fault(
                kind="address",
                effect="wrong_place" if field in CRITICAL_ADDRESS_FIELDS else "imprecise",
                field=field,
                card=address.get(field, ""),
                truth=scenario["address"][field],
            )
        )
    if not _type_accepted(scenario, incident_type_code):
        faults.append(
            Fault(
                kind="incident_type",
                effect="wrong_type",
                card=incident_type_code or "",
                truth=scenario["incident_type_code"] or "",
            )
        )
    expected = list(scenario["expected_services"])
    faults += [
        Fault(kind="service_missing", effect="not_delivered", service_id=service_id)
        for service_id in expected
        if service_id not in services
    ]
    faults += [
        Fault(kind="service_extra", effect="extra_dispatch", service_id=service_id)
        for service_id in services
        if service_id not in expected
    ]
    return faults


def sends_to_wrong_place(faults: list[Fault]) -> bool:
    return any(fault.effect == "wrong_place" for fault in faults)
