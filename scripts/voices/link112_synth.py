"""Озвучка докладов и реплик бригад связки «112 → ДДС» (DT-10, 11.10).

Устарело (проверка 17.10, HQ-036): seed связки (app.seed.link112) эту озвучку не берёт —
голос реплик связки из банка (data/voices/bank-v*, книги scripts/voices/bank/link112/),
записи нет — реплика текстом. Оставлено для истории записей data/voices/link112.

Запускается в контейнере — см. link112_generate.sh. Тексты — сюжеты
data/link112/plots/*.json и записи оператора data/link112/records/*.json; голос бригады —
голос её службы, как в тренировке (practice_synth.py). Раскладка совпадает с
apps/api/app/seed/link112.py: link112/<сюжет>/<служба>/<этап>.ogg, реплики событий —
event-*.ogg, как в practice. Доклад о прибытии по ошибочному адресу зависит от записи
(в нём адрес из карточки оператора) — arrival-<запись>.ogg на каждую запись сюжета, у
которой улица или дом расходятся с правдой сценария оператора (data/operator/scenarios):
только такая запись уводит бригаду (`sends_to_wrong_place`, apps/api/app/operator/faults.py).
Готовый файл с тем же текстом не пересобирается.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from practice_synth import live_lines, synthesize


def _same(left: str, right: str) -> bool:
    def norm(value: str) -> str:
        return " ".join(value.casefold().replace("ё", "е").split())

    return norm(left) == norm(right)


def wrong_place(record: dict, truth_address: dict) -> bool:
    """Улица или дом записи не те, что в сюжете: бригада по карточке приедет не туда."""
    address = record["card"]["address"]
    return not all(
        _same(address.get(field, ""), truth_address.get(field, "")) for field in ("street", "house")
    )


def plot_reports(plot: dict, records: list[dict]) -> list[tuple[str, str, str]]:
    """(служба, путь относительно data/voices, текст) всех реплик сюжета связки."""
    result = []
    for service, variant in plot["services"].items():
        base = f"link112/{plot['operator_scenario_id']}/{service}"
        result.append((service, f"{base}/departure.ogg", variant["departure"]))
        for stage in ("arrival", "works", "completion"):
            result.append((service, f"{base}/{stage}-1.ogg", variant["full"][stage]))
        if "complication" in variant:
            for stage in ("arrival", "outcome"):
                result.append((service, f"{base}/{stage}-2.ogg", variant["complication"][stage]))
        if "wrong_address" in variant:
            for record in records:
                text = variant["wrong_address"]["arrival"].format(**record["card"]["address"])
                result.append((service, f"{base}/arrival-{record['id']}.ogg", text))
        result += [(service, path, text) for path, text in live_lines(base, variant)]
    return result


def main() -> int:
    cache, link_dir, out, scenarios = (Path(value) for value in sys.argv[1:5])
    records = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((link_dir / "records").glob("*.json"))
    ]
    todo = []
    for path in sorted((link_dir / "plots").glob("*.json")):
        plot = json.loads(path.read_text(encoding="utf-8"))
        truth = json.loads((scenarios / path.name).read_text(encoding="utf-8"))["address"]
        own = [
            item
            for item in records
            if item["operator_scenario_id"] == path.stem and wrong_place(item, truth)
        ]
        todo += plot_reports(plot, own)
    return synthesize(
        cache,
        out,
        out / "link112" / "manifest.json",
        todo,
        "Доклады и реплики бригад связки 112 → ДДС: тексты — data/link112, озвучка — Piper, "
        "голос службы (scripts/voices/link112_generate.sh). Пути относительно data/voices.",
    )


if __name__ == "__main__":
    raise SystemExit(main())
