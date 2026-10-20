"""Подготовить стенд к показу этапа «диспетчер служб» (DT-13): маршрут — docs/dds_stage_show.md.

Через API стенда, от учётных записей teacher и trainee05:

1. «Показ ДДС — готовый результат»: trainee05 (АРМ 5, 104) проходит «Задымление в квартире»
   (70005131) по докладам бригады до «Работы завершены», занятие завершается. В «Моих результатах»
   trainee05 — вердикт и «Что было дальше» (DT-08), без ожидания на показе.
2. «Показ ДДС»: черновик на три места, начинает его капитан на показе:
   АРМ 1 — trainee01, 102, ДТП 10000001 (доклад службе голосом или вариантом, DT-05 и DT-11);
   АРМ 2 — trainee02, 101, карточка оператора-бота 10271704 (связка 112 → ДДС, DT-04, DT-14);
   АРМ 3 — trainee03, 101, «Задымление в квартире» 70005101 (живая бригада DT-10, вводная DT-06).

Проводник (DT-07) и разминку (DT-09) trainee04 запускает сам из АРМ — готовить нечего.

Запуск (Python 3.12+, без пакетов): python scripts/demo/dds_stage_show.py
[--base-url https://127.0.0.1:8443] [--password …] [--skip-result]. Пароль по умолчанию —
DEMO_PASSWORD из окружения или demo-local. Сертификат стенда самоподписанный — не проверяется.
Адрес — 127.0.0.1, а не localhost: стенд слушает только IPv4, а localhost сначала даёт ::1, и
urllib может ждать там тайм-аут на каждом запросе. SHOW_DEBUG=1 печатает события карточки.
"""

import argparse
import http.cookiejar
import json
import os
import ssl
import time
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from typing import Any

RESULT_TITLE = "Показ ДДС — готовый результат"
SHOW_TITLE = "Показ ДДС"
# (логин, АРМ, служба, номер карточки сценария)
RESULT_SEAT = ("trainee05", 5, "104", "70005131")
SHOW_SEATS = [
    ("trainee01", 1, "102", "10000001"),
    ("trainee02", 2, "101", "10271704"),
    ("trainee03", 3, "101", "70005101"),
]
# Статусы после «Принята»: на каждый — звонок бригаде и её доклад (как qa/e2e/practice-outcome).
STATES = ["responding", "arrived", "working", "completed"]


class Client:
    """Сессия одной учётной записи: cookie, CSRF, JSON."""

    def __init__(self, base_url: str, login: str, password: str) -> None:
        self.base = base_url.rstrip("/") + "/api"
        self.jar = http.cookiejar.CookieJar()
        tls = ssl.create_default_context()
        tls.check_hostname = False
        tls.verify_mode = ssl.CERT_NONE
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar), urllib.request.HTTPSHandler(context=tls)
        )
        self.login = login
        self.call("POST", "/auth/login", {"login": login, "password": password})

    def csrf(self) -> str:
        return next((c.value or "" for c in self.jar if c.name == "csrf"), "")

    def call(self, method: str, path: str, body: Any = None, ok: tuple[int, ...] = ()) -> Any:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if method != "GET":
            request.add_header("X-CSRF-Token", self.csrf())
        try:
            with self.opener.open(request, timeout=30) as response:
                text = response.read().decode()
        except urllib.error.HTTPError as error:
            if error.code in ok:
                return None
            detail = error.read().decode()[:300]
            raise SystemExit(f"{self.login}: {method} {path} → {error.code} {detail}") from error
        return json.loads(text) if text else None

    def event(self, card_id: str, kind: str, payload: dict[str, Any]) -> None:
        if os.environ.get("SHOW_DEBUG"):
            print(f"{time.strftime('%X')} {self.login} {kind} {json.dumps(payload)[:120]}")
        self.call(
            "POST",
            f"/cards/{card_id}/events",
            {
                "client_event_id": str(uuid.uuid4()),
                # Контракт (card-event.schema.json) требует UTC с «Z», не «+00:00».
                "client_ts": datetime.now(UTC).isoformat(timespec="milliseconds")[:-6] + "Z",
                "type": kind,
                "payload": payload,
            },
        )


def wait(what: str, check: Any, timeout: float = 60) -> Any:
    """Опрашивать `check()` раз в секунду, пока не вернёт истину."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(1)
    raise SystemExit(f"Не дождался: {what} ({timeout:.0f} с).")


def scenario(scenarios: list[dict[str, Any]], number: str) -> dict[str, Any]:
    found = [s for s in scenarios if s["card"]["number"] == number and s["status"] == "approved"]
    if not found:
        raise SystemExit(f"На стенде нет утверждённого сценария карточки {number}.")
    return max(found, key=lambda s: s["version"])


def create_lesson(
    teacher: Client,
    title: str,
    seats: list[tuple[str, int, str, str]],
    users: dict[str, str],
    scenarios: list[dict[str, Any]],
) -> str:
    settings = teacher.call("GET", "/settings")
    lesson = teacher.call(
        "POST",
        "/sessions",
        {
            "title": title,
            "participants": [
                {
                    "user_id": users[login],
                    "workstation_number": place,
                    "dds_service_id": service,
                    "level": 1,
                }
                for login, place, service, _ in seats
            ],
            "settings_snapshot": settings,
        },
    )
    items = []
    for login, _, _, number in seats:
        chosen = scenario(scenarios, number)
        items.append(
            {
                "participant_id": users[login],
                "scenario_id": chosen["id"],
                "scenario_version": chosen["version"],
                "order": 1,
                "delay_from_start_s": 0,
                "delivery_mode": "profile",
            }
        )
    teacher.call(
        "POST",
        f"/sessions/{lesson['id']}/assignments/batch",
        {"request_id": str(uuid.uuid4()), "items": items},
    )
    return str(lesson["id"])


def play_to_completion(trainee: Client, lesson_id: str, service: str) -> dict[str, Any]:
    """Карточка занятия по докладам бригады до «Работы завершены» (без событий живой бригады)."""

    def own_card() -> dict[str, Any] | None:
        cards = trainee.call("GET", "/cards")
        return next((c for c in cards if c["session_id"] == lesson_id), None)

    card = wait("карточка у обучаемого", own_card, 30)
    card_id = card["id"]
    trainee.event(card_id, "deliver", {})
    trainee.event(card_id, "open", {})
    comment = [card["source"]["description"], "Направлена бригада."]
    trainee.event(card_id, "status_change", {"state": "accepted", "comment": " ".join(comment)})
    brigades = trainee.call("GET", f"/services/{service}/brigades")
    brigade = sorted(brigades, key=lambda b: b["name"])[0]
    targets = trainee.call("GET", f"/services/{service}/call-targets")
    target = next(t for t in targets if t["brigade_id"] == brigade["id"])
    # «Номер наряда» — прямой номер направленной бригады: оценка сверяет его (HQ-062).
    trainee.event(
        card_id, "field_change", {"field": "service_number", "value": target["phone_ext"]}
    )
    trainee.event(card_id, "brigades_select", {"brigade_ids": [brigade["id"]]})
    presented: set[str] = set()
    for index, state in enumerate(STATES):
        call_id = str(uuid.uuid4())
        trainee.event(
            card_id,
            "call_dial_target",
            {"call_id": call_id, "call_target_id": target["id"], "brigade_id": brigade["id"]},
        )
        trainee.event(card_id, "call_answer", {"call_id": call_id})
        if index == 0:
            # GP-05: в первом разговоре — вводная, без неё бригада не выезжает.
            source = card["source"]
            house = f", дом {source['address']['house']}" if source["address"]["house"] else ""
            incident = source.get("incident_class") or source["description"]
            trainee.event(
                card_id,
                "brigade_briefing",
                {
                    "call_id": call_id,
                    "mode": "parts",
                    "text": f"{source['address']['street']}{house}. {incident}",
                },
            )
        wait(
            f"доклад бригады перед «{state}»",
            lambda count=index: len(trainee.call("GET", f"/cards/{card_id}/training")["messages"])
            > count,
        )
        trainee.event(card_id, "call_hangup", {"call_id": call_id})
        for item in trainee.call("GET", f"/cards/{card_id}/training")["messages"]:
            delivery = item["delivery"]
            if delivery["delivery_id"] in presented:
                continue
            presented.add(delivery["delivery_id"])
            comment.append(delivery["message"]["text"])
            audio = delivery["message"]["audio"]
            trainee.event(
                card_id,
                "message_presented",
                {
                    "delivery_id": delivery["delivery_id"],
                    "playback_id": str(uuid.uuid4()),
                    "message_version": delivery["message"]["version"],
                    "audio_version": audio["version"] if audio else None,
                    "channel": "audio" if audio else "text",
                },
            )
        trainee.event(card_id, "status_change", {"state": state, "comment": " ".join(comment)})
    return card


def busy(teacher: Client, logins: set[str], users: dict[str, str]) -> list[str]:
    """Идущие занятия и черновики показа с этими обучаемыми — показ на них не соберётся."""
    ids = {users[login] for login in logins}
    found = []
    for lesson in teacher.call("GET", "/sessions"):
        people = {p["user_id"] for p in lesson.get("participants", [])}
        if lesson["status"] == "running" and people & ids:
            found.append(f"«{lesson['title']}» (идёт)")
        elif lesson["status"] == "draft" and lesson["title"] == SHOW_TITLE:
            found.append(f"«{lesson['title']}» (черновик)")
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base-url", default="https://127.0.0.1:8443")
    parser.add_argument("--password", default=os.environ.get("DEMO_PASSWORD", "demo-local"))
    parser.add_argument(
        "--skip-result", action="store_true", help="не готовить закрытую карточку trainee05"
    )
    args = parser.parse_args()

    teacher = Client(args.base_url, "teacher", args.password)
    users = {u["login"]: u["id"] for u in teacher.call("GET", "/users")}
    scenarios = teacher.call("GET", "/scenarios")
    logins = {seat[0] for seat in SHOW_SEATS}
    if not args.skip_result:
        logins.add(RESULT_SEAT[0])
    if conflicts := busy(teacher, logins, users):
        raise SystemExit(
            "Сначала завершите в кабинете преподавателя: " + ", ".join(conflicts) + ". "
            "У обучаемого может идти только одно занятие, черновик «Показ ДДС» нужен один."
        )

    if not args.skip_result:
        login, _, service, number = RESULT_SEAT
        lesson_id = create_lesson(teacher, RESULT_TITLE, [RESULT_SEAT], users, scenarios)
        teacher.call("POST", f"/sessions/{lesson_id}/start")
        card = play_to_completion(Client(args.base_url, login, args.password), lesson_id, service)
        teacher.call(
            "POST",
            f"/sessions/{lesson_id}/finish",
            {"contract_version": 2, "request_id": str(uuid.uuid4())},
        )
        trainee = Client(args.base_url, login, args.password)
        wait(
            "оценка готового результата",
            lambda: any(e["card_id"] == card["id"] for e in trainee.call("GET", "/evaluations")),
            120,
        )
        print(f"Готово: {login} — закрытая карточка {number} с оценкой («{RESULT_TITLE}»).")

    create_lesson(teacher, SHOW_TITLE, SHOW_SEATS, users, scenarios)
    seats = "; ".join(f"АРМ {p} — {login}, {s}, {n}" for login, p, s, n in SHOW_SEATS)
    print(
        f"Готово: черновик «{SHOW_TITLE}» ({seats}). "
        "Начать — на показе, первый шаг маршрута (docs/dds_stage_show.md)."
    )


if __name__ == "__main__":
    main()
