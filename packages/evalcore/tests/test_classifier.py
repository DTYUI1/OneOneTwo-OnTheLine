import csv
from pathlib import Path

import pytest
from evalcore.classifier import (
    LAYOUT_046_11,
    LAYOUT_046_24,
    SERVICE_HEADERS,
    Layout,
    parse_classifier,
    parse_classifier_with_layout,
)

ROOT = Path(__file__).resolve().parents[3]
EDITIONS = {
    "046_11": ROOT / "docs/classifier_v046.csv",
    "046_24": ROOT
    / "docs/dataset/Датасет"
    / "Классификатор_происшествий_v_046_24_корректировка_МВД_+_Департамент.csv",
}


def header(layout: Layout) -> list[list[str]]:
    rows = [[""] * layout.width for _ in range(3)]
    rows[0][12] = "Сценарий реагирования" if layout.scenario_column else "Главная служба"
    for column, (service, _) in sorted(layout.service_columns.items()):
        rows[0][column] = SERVICE_HEADERS[service]
    return rows


def write(tmp_path: Path, rows: list[list[str]]) -> Path:
    path = tmp_path / "classifier.csv"
    with path.open("w", encoding="utf-8", newline="") as stream:
        csv.writer(stream).writerows(rows)
    return path


@pytest.mark.parametrize("layout", [LAYOUT_046_11, LAYOUT_046_24])
def test_multiline_csv_and_no_response(tmp_path, layout):
    rows = header(layout)
    rows[2][next(iter(layout.service_columns))] = "Служба\n101"
    row = [""] * layout.width
    row[0], row[4], row[5], row[10] = "2", "2020000", "ДТП", "ДТП с пострадавшими"
    row[layout.main_service_column] = "Police"
    columns = {service_trigger: col for col, service_trigger in layout.service_columns.items()}
    row[columns[("101", "default")]] = "нет реагирования"
    row[columns[("102", "default")]] = "карточка-112"
    types, rules, detected = parse_classifier_with_layout(write(tmp_path, [*rows, row]))
    assert detected == layout
    assert types[0].code == "2020000" and types[0].main_service_code == "Police"
    assert len(rules) == 1 and rules[0].service_id == "102"
    assert rules[0].condition["trigger"] == "default"


def test_shifted_or_unknown_header_is_rejected(tmp_path):
    rows = header(LAYOUT_046_24)
    rows[0][53], rows[0][54] = "", "Мослифт"
    with pytest.raises(ValueError, match="колонка 53"):
        parse_classifier(write(tmp_path, [*rows, [""] * 104]))
    rows = header(LAYOUT_046_24)
    rows[0][12] = "Что-то новое"
    with pytest.raises(ValueError, match="Неизвестная редакция"):
        parse_classifier(write(tmp_path, [*rows, [""] * 104]))


def test_real_editions_share_codes_and_triggers():
    parsed = {name: parse_classifier_with_layout(path) for name, path in EDITIONS.items()}
    old_types, old_rules, old_layout = parsed["046_11"]
    new_types, new_rules, new_layout = parsed["046_24"]
    assert (old_layout.version, len(old_types), len(old_rules)) == ("046_11", 1281, 3854)
    assert (new_layout.version, len(new_types), len(new_rules)) == ("046_24", 1283, 3835)
    # Все прежние коды сохранились; добавлены два типа (docs/dataset/README.md).
    added = {t.code for t in new_types} - {t.code for t in old_types}
    assert added == {"23060001", "24120200"}
    assert all(t.scenario_code == "" for t in new_types)
    # Условие одного смысла имеет одинаковое имя, хотя номер колонки сдвинулся.
    labels = {
        (rule.service_id, rule.condition["trigger"]): rule.condition["label"] for rule in old_rules
    }
    for rule in new_rules:
        assert labels[(rule.service_id, rule.condition["trigger"])] == rule.condition["label"]
