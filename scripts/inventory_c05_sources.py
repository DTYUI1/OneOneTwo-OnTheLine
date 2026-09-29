"""Reproducible inventory of the C-05 sources actually present in this checkout."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/source_inventory.json"
TG_MANIFEST = ROOT / "data/fromtg_manifest.json"
SOURCES = (
    (
        "docs/ТЗ_ДГОЧСиПБ_финал_01092026ГСИ.docx",
        "final_specification",
        "01.09.2026",
        "customer; usage rights unverified",
    ),
    (
        "docs/Классификатор_происшествий_v_046_11_ДТУ_15_11_2024_искл_пожар_задымление.xlsx",
        "classifier_original",
        "v0.46 / 15.11.2024",
        "customer; usage rights unverified",
    ),
    (
        "docs/classifier_v046.csv",
        "classifier_conversion",
        "v0.46",
        "derived from customer classifier; usage rights unverified",
    ),
    (
        "docs/dataset/Датасет/Классификатор_происшествий_v_046_24_корректировка_МВД_+_Департамент.xlsx",
        "classifier_original",
        "046_24 / 17.12.2025",
        "customer dataset 24.09; usage rights unverified",
    ),
    (
        "docs/dataset/Датасет/Классификатор_происшествий_v_046_24_корректировка_МВД_+_Департамент.csv",
        "classifier_conversion",
        "046_24",
        "derived from customer classifier; usage rights unverified",
    ),
    (
        "data/classifier.json",
        "classifier_parsed",
        "046_24",
        "derived from customer classifier; usage rights unverified",
    ),
    (
        "docs/dataset/Датасет/Билеты- задачи по C 112 . АГС_ГСИ.pdf",
        "official_tickets",
        "32 tickets / 96 tasks",
        "customer dataset 24.09; usage rights unverified",
    ),
    (
        "docs/dataset/Датасет/Билеты- задачи по C 112 . АГС_ГСИ.txt",
        "official_tickets_ocr",
        "local OCR; verify against PDF",
        "derived from customer tickets; usage rights unverified",
    ),
    (
        "docs/dataset/Датасет/Работа с АРМ-112 для ДДС от ОКр_ГСИ.pdf",
        "dds_memo",
        "2025, 40 pages",
        "customer dataset 24.09; usage rights unverified",
    ),
    ("docs/СКРИНШОТ ДДСГСИ.docx", "dds_screenshots", None, "customer; usage rights unverified"),
    (
        "docs/СКРИНШОТ КАРТОЧКИ 112ГСИ.docx",
        "operator_screenshots",
        None,
        "customer; usage rights unverified",
    ),
    (
        "docs/customer_2026-09-18/КАРТОЧКА 112.docx",
        "operator_examples",
        "18.09.2026",
        "customer; usage rights unverified",
    ),
    (
        "docs/customer_2026-09-18/СЛУЖБЫ 112.docx",
        "service_names",
        "18.09.2026",
        "customer; usage rights unverified",
    ),
    (
        "docs/C08_customer_2026-09-21.md",
        "forwarded_correspondence",
        "22.09.2026",
        "forwarded text; original thread unavailable",
    ),
    (
        "data/tg_followup_20260924.md",
        "forwarded_correspondence_update",
        "24.09.2026",
        "user-supplied text; original Telegram thread unavailable",
    ),
    ("data/templates/traffic.json", "synthetic_template", None, "team synthetic"),
    ("data/phonebook.json", "synthetic_phonebook", None, "team synthetic"),
)
# Памятка ДДС содержит ФИО и телефоны сотрудников заказчика, пересланная переписка — имена
# участников чата; в публичную копию репозитория они не входят
# (scripts/submission/make_public_snapshot.sh), там они «withheld».
WITHHELD_PUBLIC = frozenset(
    {
        "docs/dataset/Датасет/Работа с АРМ-112 для ДДС от ОКр_ГСИ.pdf",
        "docs/C08_customer_2026-09-21.md",
        "data/tg_followup_20260924.md",
    }
)
# Билеты, памятка и 046_24 получены 24.09 (docs/dataset/README.md). Ответов к билетам
# заказчик не предоставит: эталоны готовит команда (docs/CUSTOMER_QUESTIONS_2026-09-24.md).
MISSING = (
    (
        "official_ticket_solutions",
        "Customer will not provide answers (decision 24.09); team references are marked as such.",
    ),
    ("service_phone_registry", "The datasheet gives device capabilities, not DDS contact numbers."),
    (
        "moscow_streets",
        "data/streets.csv.gz is absent; fixture addresses are not a street registry.",
    ),
)


def _file_entry(relative: str, kind: str, version: str | None, rights: str) -> dict:
    path = ROOT / relative
    if not path.is_file():
        return {
            "path": relative,
            "kind": kind,
            "status": "withheld" if relative in WITHHELD_PUBLIC else "missing",
            "version": version,
            "rights": rights,
        }
    content = path.read_bytes()
    return {
        "path": relative,
        "kind": kind,
        "status": "present",
        "version": version,
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "rights": rights,
    }


def scan_tg(source_dir: Path) -> dict:
    """Record a supplied Telegram file drop without copying its binaries into Git."""
    if not source_dir.is_dir():
        raise ValueError(f"TG source directory does not exist: {source_dir}")
    existing = {
        item["sha256"]: item["path"]
        for item in (_file_entry(*source) for source in SOURCES)
        if item["status"] == "present"
    }
    files = []
    for path in sorted(source_dir.iterdir(), key=lambda item: item.name):
        if not path.is_file():
            continue
        content = path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        name = path.name
        if "Datasheet" in name:
            kind = "phone_datasheet"
            version = "filename: 2024"
        elif name.startswith("Инструкция_по_заведению"):
            kind = "operator_112_card_instruction"
            version = "filename: 2507"
        elif name.startswith("Инструкция для участника"):
            kind = "hackathon_participant_guide"
            version = None
        elif name.startswith("Ответы на вопросы"):
            kind = "hackathon_faq"
            version = None
        elif "v_046" in name:
            kind = "classifier_original_duplicate"
            version = "v0.46 / 15.11.2024"
        elif name.startswith("ТЗ_"):
            kind = "final_specification_duplicate"
            version = "01.09.2026"
        else:
            kind = "duplicate_or_other_customer_file"
            version = None
        files.append(
            {
                "path": f"docs/fromTG/{name}",
                "kind": kind,
                "status": "observed_external",
                "version": version,
                "bytes": len(content),
                "sha256": digest,
                "same_as": existing.get(digest),
                "rights": "supplied Telegram file; usage rights unverified",
            }
        )
    return {
        "schema_version": 1,
        "scope": "Metadata from a local Telegram drop; binaries are outside this branch",
        "files": files,
    }


def inventory() -> dict:
    files = [_file_entry(*source) for source in SOURCES]
    for path in sorted((ROOT / "data/golden_scenarios").glob("*.json")):
        files.append(
            _file_entry(
                path.relative_to(ROOT).as_posix(), "synthetic_golden", None, "team synthetic"
            )
        )
    external = json.loads(TG_MANIFEST.read_text(encoding="utf-8")) if TG_MANIFEST.exists() else None
    return {
        "schema_version": 1,
        "scope": "files available in this checkout; ticket sources present, import is per scenario",
        "files": files,
        "external_observations": external,
        "missing_sources": [{"kind": kind, "reason": reason} for kind, reason in MISSING],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check", action="store_true", help="Fail if the committed inventory is stale"
    )
    parser.add_argument("--tg-dir", type=Path, help="Verify or record supplied docs/fromTG files")
    args = parser.parse_args()
    if args.tg_dir:
        observed = json.dumps(scan_tg(args.tg_dir), ensure_ascii=False, indent=2) + "\n"
        if args.check:
            if not TG_MANIFEST.exists() or TG_MANIFEST.read_text(encoding="utf-8") != observed:
                print("data/fromtg_manifest.json differs from the supplied TG files")
                return 1
        else:
            TG_MANIFEST.write_text(observed, encoding="utf-8")
    rendered = json.dumps(inventory(), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != rendered:
            print("data/source_inventory.json is stale; rerun inventory_c05_sources.py")
            return 1
        print("C-05 source inventory is current")
        return 0
    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
