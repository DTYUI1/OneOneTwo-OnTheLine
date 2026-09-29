"""Разбор исходного CSV классификатора без БД.

Карта колонок — docs/README.md (046_11) и docs/dataset/README.md (046_24).

Поддерживаются две редакции: основная 046_24 (решение капитана 24.09) и прежняя 046_11,
по которой собраны исторические данные. Редакция определяется по шапке, а не по имени файла.
"""

import csv
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class IncidentType:
    code: str
    group_no: str
    group_name: str
    name: str
    sign1: str
    sign2: str
    sign3: str
    scenario_code: str
    main_service_code: str


@dataclass(frozen=True)
class RoutingRule:
    incident_type_code: str
    service_id: str
    condition: dict[str, str | int]
    payload: str


@dataclass(frozen=True)
class Layout:
    """Позиции колонок редакции. `trigger` — стабильное имя условия для потребителей:
    номер колонки меняется между редакциями, смысл условия — нет."""

    version: str
    width: int
    scenario_column: int | None
    main_service_column: int
    service_columns: dict[int, tuple[str, str]]


# Условия сохраняются буквально: интерпретация признаков — генератор/оценщик, не парсер.
LAYOUT_046_11 = Layout(
    version="046_11",
    width=90,
    scenario_column=12,
    main_service_column=13,
    service_columns={
        14: ("101", "default"),
        15: ("101", "no_access"),
        21: ("102", "default"),
        22: ("102", "offense"),
        23: ("102", "victims"),
        24: ("103", "default"),
        25: ("103", "victims"),
        26: ("103", "victims_off_site"),
        27: ("104", "default"),
        28: ("104", "gasification"),
        54: ("MOSLIFT", "default"),
        56: ("GKH", "default"),
    },
)
# В 046_24 нет столбца «Сценарий реагирования»: колонки после него сдвинулись на одну.
LAYOUT_046_24 = Layout(
    version="046_24",
    width=104,
    scenario_column=None,
    main_service_column=12,
    service_columns={
        13: ("101", "default"),
        14: ("101", "no_access"),
        20: ("102", "default"),
        21: ("102", "offense"),
        22: ("102", "victims"),
        23: ("103", "default"),
        24: ("103", "victims"),
        25: ("103", "victims_off_site"),
        26: ("104", "default"),
        27: ("104", "gasification"),
        53: ("MOSLIFT", "default"),
        55: ("GKH", "default"),
    },
)
# Ожидаемые заголовки групп служб: защищают от молчаливого сдвига колонок в новой редакции.
SERVICE_HEADERS = {
    "101": "Классификатор МЧС",
    "102": "Классификатор МВД",
    "103": "Классификатор СМП",
    "104": "Классификатор МОСГАЗ",
    "MOSLIFT": "Мослифт",
    "GKH": "Деп. ЖКХ",
}


def detect_layout(header: list[list[str]]) -> Layout:
    """Выбрать раскладку по шапке; неизвестная структура — ошибка, а не догадка."""
    if len(header) < 3:
        raise ValueError("Ожидались 3 строки шапки классификатора")
    marker = header[0][12].strip() if len(header[0]) > 12 else ""
    if marker.startswith("Сценарий реагирования"):
        layout = LAYOUT_046_11
    elif marker.startswith("Главная служба"):
        layout = LAYOUT_046_24
    else:
        raise ValueError("Неизвестная редакция классификатора: нет столбца главной службы")
    if any(len(row) != layout.width for row in header):
        raise ValueError(f"Классификатор {layout.version}: ожидалось {layout.width} колонок")
    groups: dict[int, str] = {}
    current = ""
    for index, value in enumerate(header[0]):
        current = value.strip() or current
        groups[index] = current
    for column, (service, _) in layout.service_columns.items():
        if not groups[column].startswith(SERVICE_HEADERS[service]):
            raise ValueError(
                f"Классификатор {layout.version}: колонка {column} не относится к службе {service}"
            )
    return layout


def parse_classifier(path: Path) -> tuple[list[IncidentType], list[RoutingRule]]:
    """Вернуть типы и правила 6 MVP-служб; пустые/«нет реагирования» не маршрутизируют.

    Читаем CSV-записи, не физические строки: заголовки содержат переносы внутри кавычек.
    """
    types, rules, _ = parse_classifier_with_layout(path)
    return types, rules


def parse_classifier_with_layout(
    path: Path,
) -> tuple[list[IncidentType], list[RoutingRule], Layout]:
    """То же, что parse_classifier, плюс определённая редакция для записи в артефакт."""
    with path.open(encoding="utf-8-sig", newline="") as stream:
        rows = list(csv.reader(stream))
    if len(rows) < 4:
        raise ValueError("Ожидались 3 строки шапки и данные классификатора")
    layout = detect_layout(rows[:3])
    types: list[IncidentType] = []
    rules: list[RoutingRule] = []
    group_name = ""
    seen: set[str] = set()
    for row in rows[3:]:
        if len(row) < layout.width:
            row += [""] * (layout.width - len(row))
        code = row[4].strip()
        if not code:
            continue
        if row[5].strip():
            group_name = row[5].strip()
        if len(code) <= 2 or not row[10].strip():
            continue
        if code in seen:
            raise ValueError(f"Повтор кода типа: {code}")
        seen.add(code)
        scenario = row[layout.scenario_column].strip() if layout.scenario_column else ""
        types.append(
            IncidentType(
                code,
                row[0].strip(),
                group_name,
                row[10].strip(),
                row[6].strip(),
                row[7].strip(),
                row[8].strip(),
                scenario,
                row[layout.main_service_column].strip(),
            )
        )
        for column, (service, trigger) in layout.service_columns.items():
            payload = row[column].strip()
            if payload and payload.casefold() != "нет реагирования":
                condition: dict[str, str | int] = {
                    "kind": "classifier_column",
                    "column": column,
                    "trigger": trigger,
                    "label": rows[2][column].strip()
                    or rows[1][column].strip()
                    or rows[0][column].strip(),
                }
                rules.append(RoutingRule(code, service, condition, payload))
    return types, rules, layout
