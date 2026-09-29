import json
from dataclasses import asdict
from pathlib import Path

from evalcore.classifier import parse_classifier_with_layout

ROOT = Path(__file__).resolve().parents[1]
# Основная редакция проекта — последняя полученная 046_24 (решение капитана 24.09).
SOURCE = (
    "docs/dataset/Датасет/Классификатор_происшествий_v_046_24_корректировка_МВД_+_Департамент.csv"
)


def build() -> dict:
    """Преобразовать исходный CSV в воспроизводимый артефакт, без записи в БД."""
    types, rules, layout = parse_classifier_with_layout(ROOT / SOURCE)
    services = json.loads((ROOT / "data/phonebook.json").read_text(encoding="utf-8"))
    return {
        "version": layout.version,
        "source": SOURCE,
        "incident_types": [asdict(item) for item in types],
        "routing_rules": [asdict(rule) for rule in rules],
        "services": services,
    }


if __name__ == "__main__":
    (ROOT / "data/classifier.json").write_text(
        json.dumps(build(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
