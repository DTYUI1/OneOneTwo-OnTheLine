"""Сценарии C-05 по билетам заказчика: факты билета + эталон, размеченный командой.

Источник заданий — `docs/dataset/Датасет/Билеты- задачи по C 112 . АГС_ГСИ.pdf`.
Ситуация и адрес каждой задачи перенесены вручную со скана страницы (OCR только для поиска).
Готовых ответов заказчик не предоставляет (решение 24.09): эталон — учебная разметка команды
по памятке ДДС и классификатору 046_24, до проверки преподавателем сценарий остаётся `draft`.

Телефоны заявителей заменены учебными `+7900000…` (CONTRIBUTING §8); ФИО из билетов вымышлены.
Пишет `data/ticket_scenarios/*.json`, `data/ticket_scenarios/manifest.json` и пакет
`data/packs/tickets-01.json`; `--check` сверяет сохранённые файлы.
"""

import argparse
import json
from dataclasses import dataclass, field
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data/ticket_scenarios"
PACK = ROOT / "data/packs/tickets-01.json"
SOURCE = "docs/dataset/Датасет/Билеты- задачи по C 112 . АГС_ГСИ.pdf"
PHONES = {"101": "101", "102": "102", "103": "103", "104": "104", "GKH": "105", "MOSLIFT": "106"}
ACCEPTED_FLOW = ["received", "accepted", "responding", "completed"]


@dataclass(frozen=True)
class Task:
    """Одна задача билета. `situation`/`address_source` — дословно со скана."""

    ticket: int
    task: int
    situation: str
    address_source: str
    target: str
    incident_type_code: str
    service_ids: list[str]
    address: dict[str, str]
    description: str
    caller: str
    victims: bool
    level: int
    weight: int
    comment: str
    flow: list[str] = field(default_factory=lambda: list(ACCEPTED_FLOW))
    call_required: bool = True
    rationale: str = ""


def address(street: str, house: str = "", building: str = "", apartment: str = "", **extra):
    return {
        "city": extra.get("city", "Москва"),
        "okrug": extra.get("okrug", ""),
        "district": extra.get("district", ""),
        "street": street,
        "house": house,
        "building": building,
        "apartment": apartment,
    }


TASKS = [
    Task(
        ticket=2,
        task=1,
        situation=(
            "Задымление мусоропровода в жилом доме, в доме 17 этажей, заявитель находится "
            "на 7-м этаже. Открытого пламени не видит, пострадавших людей нет, "
            "Ким Олег Юрьевич, 916-126-34-71"
        ),
        address_source="Москва, ул. Берзарина, дом 21, корп. 1, под. 3, домофон 68",
        target="101",
        incident_type_code="1050602",
        service_ids=["101", "102"],
        address=address("улица Берзарина", "21", "1"),
        description=(
            "Задымление мусоропровода в жилом доме, 17 этажей. Заявитель на 7-м этаже, "
            "открытого пламени не видит, пострадавших нет. Подъезд 3, домофон 68."
        ),
        caller="Ким Олег Юрьевич",
        victims=False,
        level=1,
        weight=2,
        comment=(
            "Принята. Задымление мусоропровода, открытого огня и пострадавших нет. "
            "Москва, улица Берзарина, д. 21, корп. 1, подъезд 3. Направлено подразделение."
        ),
        rationale="Классификатор 046_24: 1050602 — 101, 102; 103 только при пострадавших.",
    ),
    Task(
        ticket=4,
        task=1,
        situation=(
            "Горит балкон и два окна рядом на 13-м этаже, открытое пламя, пострадавших не "
            "видят, наблюдают с улицы, Сидорова Анна Викторовна, 916-126-34-71 "
            "(этажность - 14, дом газифицирован)"
        ),
        address_source=(
            "Москва, ул. Грина, № дома неизвестен, в данном доме находится библиотека № 193 "
            "(ул. Грина, дом.11)"
        ),
        target="101",
        incident_type_code="1050201",
        service_ids=["101", "102", "104", "MOSLIFT"],
        address=address("улица Грина", "11"),
        description=(
            "Горит балкон и два окна рядом на 13-м этаже, открытое пламя. Пострадавших не "
            "видят, наблюдают с улицы. Дом 14 этажей, газифицирован. Номер дома заявитель "
            "не знает: в доме библиотека № 193, по ориентиру уточнён дом 11."
        ),
        caller="Сидорова Анна Викторовна",
        victims=False,
        level=2,
        weight=4,
        comment=(
            "Принята. Пожар балкона и двух окон на 13-м этаже, открытое пламя, пострадавших "
            "не видят; дом газифицирован. Москва, улица Грина, д. 11 (библиотека № 193). "
            "Направлено подразделение."
        ),
        rationale=(
            "Классификатор 046_24: 1050201 — 101, 102, МОСЛИФТ; 104 при газификации. "
            "Уточнённый по ориентиру адрес отражается в комментарии (памятка, стр. 26)."
        ),
    ),
    Task(
        ticket=1,
        task=2,
        situation=(
            "Дерутся 10-15 человек, 5 пострадавших с различными травмами, дерутся палками и "
            "железными прутами, Иванов Петр Иванович, 916-123-98-78"
        ),
        address_source=(
            "Москва, рядом с посольством Азербайджана на тротуаре "
            "(Леонтьевский переулок, дом 16, стр.1)"
        ),
        target="102",
        incident_type_code="15060202",
        service_ids=["102", "103"],
        # «стр. 1» — строение, а не корпус: в поле building его не переносим.
        address=address("Леонтьевский переулок", "16"),
        description=(
            "Дерутся 10–15 человек палками и железными прутами, 5 пострадавших с различными "
            "травмами. На тротуаре рядом с посольством Азербайджана, строение 1."
        ),
        caller="Иванов Петр Иванович",
        victims=True,
        level=3,
        weight=6,
        comment=(
            "Принята. Массовая драка 10–15 человек с палками и прутами, 5 пострадавших. "
            "Москва, Леонтьевский переулок, д. 16, стр. 1, у посольства Азербайджана. "
            "Направлен наряд, скорая помощь оповещена по карточке."
        ),
        rationale="Классификатор 046_24: 15060202 — 102; 103 при пострадавших.",
    ),
    Task(
        ticket=3,
        task=2,
        situation="Громко играет музыка во дворе, Соколов Иван Петрович, 916 896 3254",
        address_source="Бульвар Маршала Рокоссовского дом 25, двор",
        target="102",
        incident_type_code="15100100",
        service_ids=["102"],
        address=address("бульвар Маршала Рокоссовского", "25"),
        description="Громко играет музыка во дворе дома.",
        caller="Соколов Иван Петрович",
        victims=False,
        level=1,
        weight=1,
        comment=(
            "Принята. Громкая музыка во дворе. Москва, бульвар Маршала Рокоссовского, "
            "д. 25, двор. Направлен наряд."
        ),
        rationale="Классификатор 046_24: 15100100 «Нарушение тишины» — 102.",
    ),
    Task(
        ticket=31,
        task=3,
        situation=(
            "Свист от газовой трубы в квартире, на кухне. 03 не треб. Трунов Олег Егорович, "
            "916-320-12-83"
        ),
        address_source="Москва, ул. Вавилова, дом 81 корп. 1, кв.5, под.1, эт.2, код5В",
        target="104",
        incident_type_code="13020100",
        service_ids=["101", "104"],
        address=address("улица Вавилова", "81", "1", "5"),
        description=(
            "Свист от газовой трубы в квартире, на кухне. Скорая не требуется. "
            "Подъезд 1, этаж 2, код 5В."
        ),
        caller="Трунов Олег Егорович",
        victims=False,
        level=2,
        weight=4,
        comment=(
            "Принята. Свист от газовой трубы на кухне, пострадавших нет. Москва, улица "
            "Вавилова, д. 81, корп. 1, кв. 5, подъезд 1, этаж 2. Направлена аварийная бригада."
        ),
        rationale="Классификатор 046_24: 13020100 — 101, 104; 103 только при пострадавших.",
    ),
    Task(
        ticket=30,
        task=3,
        situation=(
            "В частном доме запах газа от трубы на вводе в дом, слышит шум в трубе. Газ "
            "магистральный. 03 не требуется, Соколова Вера Ивановна, 916-320-12-83"
        ),
        address_source="НМ, с/п Вороновское, пос. ЛМС, мкр. Солнечный, дом 20",
        target="104",
        incident_type_code="13020300",
        service_ids=["101", "104"],
        address=address("поселение Вороновское, посёлок ЛМС, микрорайон Солнечный", "20"),
        description=(
            "В частном доме запах газа от трубы на вводе в дом, слышен шум в трубе. Газ "
            "магистральный. Скорая не требуется. Новая Москва."
        ),
        caller="Соколова Вера Ивановна",
        victims=False,
        level=3,
        weight=5,
        comment=(
            "Принята. Запах газа и шум в трубе на вводе в частный дом, газ магистральный. "
            "Москва, поселение Вороновское, посёлок ЛМС, микрорайон Солнечный, д. 20. "
            "Направлена аварийная бригада."
        ),
        rationale="Классификатор 046_24: 13020300 — 101, 104; 103 только при пострадавших.",
    ),
    Task(
        ticket=31,
        task=2,
        situation=(
            "Наезд на пешехода, мужчина в сознании, травма головы, с места скрылась ваз 2110 "
            "красная ? 128 ?? 177, в сторону области, Иванова Елена Сергеевна, 916 896 3254"
        ),
        address_source="Москва, Рублевское шоссе, напротив ТЦ «Европарк»",
        target="102",
        incident_type_code="2020100",
        service_ids=["102", "103"],
        address=address("Рублёвское шоссе"),
        description=(
            "Наезд на пешехода: мужчина в сознании, травма головы. С места скрылся ВАЗ-2110 "
            "красного цвета, номер известен частично (? 128 ?? 177), уехал в сторону области. "
            "Напротив ТЦ «Европарк»."
        ),
        caller="Иванова Елена Сергеевна",
        victims=True,
        level=3,
        weight=6,
        comment=(
            "Принята. Наезд на пешехода, пострадавший в сознании, травма головы; ВАЗ-2110 "
            "красный, номер частично ? 128 ?? 177, скрылся в сторону области. Москва, "
            "Рублёвское шоссе, напротив ТЦ «Европарк». Направлен наряд."
        ),
        rationale="Классификатор 046_24: 2020100 — 102, 103.",
    ),
    Task(
        ticket=32,
        task=2,
        situation=(
            "ДТП, 3 пострадавших в троллейбусе, не блокированы, троллейбус маршрут 27, "
            "бортовой номер 11 458, + ваз2115, течет бензин, Иванова Елена Сергеевна, "
            "916 896 3254"
        ),
        address_source=(
            "Москва, Волгоградский проспект в сторону области, остановка «Завод Спецэлектрод»"
        ),
        target="103",
        incident_type_code="2020500",
        service_ids=["101", "102", "103"],
        address=address("Волгоградский проспект"),
        description=(
            "ДТП: троллейбус маршрута 27 (бортовой номер 11 458) и ВАЗ-2115. В троллейбусе "
            "3 пострадавших, не блокированы. Течёт бензин. В сторону области, остановка "
            "«Завод Спецэлектрод»."
        ),
        caller="Иванова Елена Сергеевна",
        victims=True,
        level=4,
        weight=8,
        comment=(
            "Принята. ДТП троллейбуса № 27 (борт 11 458) и ВАЗ-2115, 3 пострадавших, не "
            "блокированы, течёт бензин. Москва, Волгоградский проспект, остановка «Завод "
            "Спецэлектрод», в сторону области. Направлены бригады скорой помощи."
        ),
        rationale="Классификатор 046_24: 2020500 — 101, 102, 103.",
    ),
    Task(
        ticket=5,
        task=2,
        situation=(
            "Женщина выпила случайно не те лекарственные препараты, потеряла сознание. "
            "Иванова Ирина Петровна, д/р 10.03.1975, вызывает супруг, 916 897 5623"
        ),
        address_source="Москва, Коломенская набережная дом 18, кв. 142, под. 3, эт. 4, код 142",
        target="103",
        incident_type_code="22340000",
        service_ids=["103"],
        address=address("Коломенская набережная", "18", "", "142"),
        description=(
            "Женщина случайно выпила не те лекарственные препараты, потеряла сознание. "
            "Пациент — Иванова Ирина Петровна, д/р 10.03.1975, вызывает супруг. "
            "Подъезд 3, этаж 4, код 142."
        ),
        caller="супруг пациентки",
        victims=True,
        level=2,
        weight=4,
        comment=(
            "Принята. Отравление лекарственными препаратами, пациентка без сознания, "
            "Иванова И. П., 10.03.1975 г. р. Москва, Коломенская набережная, д. 18, кв. 142, "
            "подъезд 3, этаж 4. Направлена бригада."
        ),
        rationale="Классификатор 046_24: 22340000 «Отравление» — 103.",
    ),
    Task(
        ticket=4,
        task=2,
        situation=(
            "Плохо женщине на автомобильной парковке. Потеря сознания. На вид 40 лет, "
            "Иванова Ирина Петровна, 916 897 5623"
        ),
        address_source=(
            "Московская область, Балашиха, Мирской проезд д 16, со стороны мусорной площадки"
        ),
        target="103",
        incident_type_code="22020000",
        service_ids=["103"],
        address=address("Мирской проезд", "16", city="Московская область, Балашиха"),
        description=(
            "Плохо женщине на автомобильной парковке, потеря сознания, на вид 40 лет. "
            "Со стороны мусорной площадки."
        ),
        caller="Иванова Ирина Петровна",
        victims=True,
        level=2,
        weight=5,
        comment=(
            "Не принята: адрес Московская область, Балашиха, Мирской проезд, д. 16 — вне зоны "
            "ответственности ДДС города Москвы. Информацию для передачи в службу Московской "
            "области вернуть в ЦОВ 112."
        ),
        flow=["received", "rejected"],
        call_required=False,
        rationale=(
            "Отказ по зоне ответственности с причиной в комментарии: памятка ДДС, стр. 21, 26, 30. "
            "Автоматическое перенаправление не требуется (docs/dataset/README.md)."
        ),
    ),
]


def scenario_id(task: Task) -> str:
    return str(uuid5(NAMESPACE_URL, f"arm112:ticket:{task.ticket}-{task.task}"))


def build_scenario(task: Task, incident_names: dict[str, str], index: int) -> dict:
    number = f"7{task.ticket:02d}{task.task}{index:04d}"
    return {
        "id": scenario_id(task),
        "version": 1,
        "level": task.level,
        "weight": task.weight,
        "incident_type_code": task.incident_type_code,
        "target_service_id": task.target,
        "card": {
            "number": number,
            "incident_type_code": task.incident_type_code,
            "caller_name": task.caller,
            "phone_aon": f"+7900000{task.ticket:02d}{task.task:02d}",
            "phone_provided": "",
            "phone_scene": "",
            "address": task.address,
            "description": task.description,
            "tags": [],
            "victims": task.victims,
            "ambulance_refused": False,
            "blocked_people": False,
            "emergency": False,
            "incident_class": incident_names[task.incident_type_code],
            "service_ids": task.service_ids,
        },
        "reference": {
            "expected_flow": task.flow,
            "required_fields": ["service_number", "comment"],
            "expected_service_ids": [task.target],
            "expected_address": task.address,
            "expected_call": {
                "required": task.call_required,
                "service_id": task.target,
                "phone_ext": PHONES[task.target],
                "before_s": 180,
            },
            "expected_comment": task.comment,
        },
        "complications": [],
        "origin": "imported",
        "status": "draft",
        "teacher_comment": (
            f"Билет {task.ticket}, задача {task.task} (стр. {task.ticket} PDF заказчика). "
            "Эталон — учебная разметка команды по памятке ДДС и классификатору 046_24; "
            "преподавателем не проверен. Телефон заявителя заменён учебным."
        ),
    }


def outputs() -> dict[Path, str]:
    classifier = json.loads((ROOT / "data/classifier.json").read_text(encoding="utf-8"))
    names = {item["code"]: item["name"] for item in classifier["incident_types"]}
    files: dict[Path, str] = {}
    manifest = []
    for index, task in enumerate(TASKS, start=1):
        value = build_scenario(task, names, index)
        path = OUTPUT / f"ticket-{task.ticket:02d}-{task.task}.json"
        files[path] = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        manifest.append(
            {
                "scenario_id": value["id"],
                "file": path.relative_to(ROOT).as_posix(),
                "source": SOURCE,
                "ticket": task.ticket,
                "task": task.task,
                "page": task.ticket,
                "situation": task.situation,
                "address_source": task.address_source,
                "transcription": "manual from PDF scan; OCR used only for search",
                "classifier_version": classifier["version"],
                "reference_author": "team",
                "reference_basis": task.rationale,
                "teacher_review": "not_reviewed",
            }
        )
    files[OUTPUT / "manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    pack = {
        "id": str(uuid5(NAMESPACE_URL, "arm112:ticket-pack:01")),
        "title": "Билеты заказчика — пакет 1 (эталоны команды, на проверке)",
        "status": "draft",
        "origin": "imported",
        "scenario_ids": [scenario_id(task) for task in TASKS],
    }
    files[PACK] = json.dumps(pack, ensure_ascii=False, indent=2) + "\n"
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Сверить сохранённые файлы")
    args = parser.parse_args()
    expected = outputs()
    if args.check:
        stale = [
            path.relative_to(ROOT).as_posix()
            for path, content in expected.items()
            if not path.exists() or path.read_text(encoding="utf-8") != content
        ]
        if stale:
            print("Сценарии по билетам устарели: " + ", ".join(stale))
            return 1
        print("Сценарии по билетам актуальны")
        return 0
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for path, content in expected.items():
        path.write_text(content, encoding="utf-8")
    print(f"Записано {len(expected)} файлов")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
