"""Сверка стенда с эталоном (GP-12): сценарии раздела 8 трижды — голосом, по частям, с ошибками.

Эталон — docs/dds_gameplay.md, разделы 3–8 и 10. Скрипт ведёт себя как окно телефона ДДС
и говорит со стендом только через HTTP API (как браузер): преподаватель выдаёт сценарий и
начинает занятие, обучаемый принимает карточку, звонит бригаде с вводной, отвечает на её
входящие вызовы, ставит статусы по докладам и закрывает карточку; затем читает разбор.

Каждый разговор с бригадой — отдельный звонок: после доклада и ответа на вопрос диспетчер
молчит, через 6 с тишины разговор кончается (раздел 4), следующий доклад бригада приносит
входящим вызовом. Ожидание доклада — время от последнего действия диспетчера или реплики
бригады до следующей реплики бригады (начала её вызова); порог — 40 с (раздел 1, п. 5).

Пути:
- voice — вводная, ответы и доклад службе «голосом»: распознанный текст (распознавание на
  стенде без STT выключено — его заменяет текст фразы, `voice-report` принимает `text`);
  отдельно проверяется, что WAV доходит до распознавания (`--wav`).
- parts — вводная и доклады по частям, ответы вариантами.
- errors — ошибки раздела 7: «Принята» позже 30 с, статус без доклада и ветка ошибки
  сценария (data/scenarios/README.md, «Набор на финал»); разбор должен назвать каждую.
  Отказ в статусе без доклада — запись `status_denied` в журнале карточки и строка
  «Последовательности статусов» (GP-26) без снижения её балла.

Запуск на поднятом стенде (API в режиме database):

    uv run --package arm112-scripts python qa/smoke/dds_walk.py \
        --api http://127.0.0.1:8000/api --password demo-local --out walk.json

Итог — строка на прогон и JSON с репликами, ожиданиями и разбором; код выхода 1, если хоть
один прогон не сошёлся с эталоном.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import queue
import sys
import threading
import time
import wave
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import httpx

ROOT = Path(__file__).resolve().parents[2]
SCENARIOS = ROOT / "data" / "scenarios"
MAX_WAIT_S = 40.0
# Строка разбора об отказе в статусе без доклада (GP-26, contracts/evalcore.md).
DENIED_LINE = "Не принят сервером: «Прибытие» — не было доклада бригады о прибытии"
SILENCE_S = 6.0
POLL_S = 0.4
RUN_TIMEOUT_S = 420.0

# Сценарий → служба места занятия (бытовой ЖКХ — место другой службы с телефоном заявителя).
SEATS = {
    "smoke-apartment-101-1": "101",
    "traffic-blocked-102-2": "102",
    "unwell-street-103-2": "103",
    "gas-entrance-104-2": "104",
    "not-ours-pipe-104-2": "104",
    "animal-shaft-gkh-1": "GKH",
}
NOT_OURS = "not-ours-pipe-104-2"
HOUSEHOLD = "animal-shaft-gkh-1"
CALLER = {"role": "caller", "name": "Заявитель", "number": "458"}
WITH_CALLER = [{"role": "head", "name": "Руководитель организации", "number": "401"}, CALLER]
TRAINEES = ["trainee01", "trainee02", "trainee03", "trainee04", "trainee05"]
PATHS = ("voice", "parts", "errors")
# Название занятия обхода в списке преподавателя — по-русски (русский интерфейс, russian-ui).
PATH_TITLES = {"voice": "голосом", "parts": "по частям", "errors": "ошибки"}
LATE_ACCEPT_S = 33.0
STATE_LABELS = {
    "accepted": "Принята",
    "rejected": "Не принята",
    "responding": "Начало реагирования",
    "arrived": "Прибытие",
    "working": "Проведение работ",
    "completed": "Работы завершены",
    "refused": "Отказ от выполнения работ",
}

# Ветка ошибки сценария (data/scenarios/README.md): ответы на события, другой завершающий
# статус, звонок заявителю вне списка; `expect` — критерии разбора, которые обязаны упасть.
BRANCH: dict[str, dict[str, Any]] = {
    "smoke-apartment-101-1": {
        "choices": {"readback": "ok"},
        "expect": {"brigade_work"},
        "what": "не поправили повтор адреса",
    },
    "traffic-blocked-102-2": {
        "final": "completed",
        "expect": {"status_flow"},
        "what": "«Работы завершены» вместо «Отказ от выполнения работ»",
    },
    "unwell-street-103-2": {
        "final": "refused",
        "wrong_house": "84",
        "expect": {"status_flow", "address"},
        "what": "неверный дом во вводной и «Отказ от выполнения работ» у скорой",
    },
    "gas-entrance-104-2": {
        "choices": {"evacuation": "skip"},
        "expect": {"brigade_work"},
        "what": "не сообщили в 112 о вызове пожарных",
    },
    NOT_OURS: {
        "accept_not_ours": True,
        "expect": {"routing", "status_flow"},
        "what": "не нашу карточку приняли",
    },
    HOUSEHOLD: {
        "caller_missing": True,
        "expect": {"call"},
        "what": "звонок заявителю, которого нет в телефоне ДДС",
    },
}


def now() -> datetime:
    return datetime.now(UTC)


def parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def scenario_uuid(data: dict[str, Any]) -> UUID:
    if data.get("id"):
        return UUID(data["id"])
    return uuid5(NAMESPACE_URL, f"arm112:scenario:{data['code']}:{data['version']}")


def text_of(line: str | dict[str, Any] | None) -> str:
    if line is None:
        return ""
    return line if isinstance(line, str) else str(line.get("text", ""))


def tiny_wav() -> bytes:
    """Полсекунды тона 440 Гц, 16 кГц моно: фраза, которая доходит до распознавания."""
    stream = io.BytesIO()
    with wave.open(stream, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        frames = bytearray()
        for i in range(8000):
            sample = int(6000 * math.sin(2 * math.pi * 440 * i / 16000))
            frames += sample.to_bytes(2, "little", signed=True)
        out.writeframes(bytes(frames))
    return stream.getvalue()


class Api:
    """Клиент одной учётной записи: cookie сессии и CSRF, как у браузера."""

    # Корневой сертификат стенда (Docker-стенд — свой УЦ, deploy/certs); None — системные.
    ca: str | None = None

    def __init__(self, base: str, login: str, password: str) -> None:
        self.client = httpx.Client(base_url=base, timeout=30, verify=Api.ca or True)
        response = self.client.post("/auth/login", json={"login": login, "password": password})
        response.raise_for_status()
        self.me = response.json()

    @property
    def headers(self) -> dict[str, str]:
        return {"X-CSRF-Token": self.client.cookies.get("csrf") or ""}

    def get(self, path: str, **kwargs: Any) -> Any:
        response = self.client.get(path, **kwargs)
        response.raise_for_status()
        return response.json()

    def post(self, path: str, **kwargs: Any) -> httpx.Response:
        return self.client.post(path, headers=self.headers, **kwargs)


@dataclass
class Run:
    code: str
    path: str
    trainee: str
    data: dict[str, Any]
    log: list[str] = field(default_factory=list)
    actions: list[tuple[datetime, str]] = field(default_factory=list)
    lines: list[tuple[datetime, str, str]] = field(default_factory=list)
    api_errors: list[str] = field(default_factory=list)
    refusals: list[str] = field(default_factory=list)
    made: list[str] = field(default_factory=list)
    expect: set[str] = field(default_factory=set)
    closed: bool = False
    criteria: dict[str, float] = field(default_factory=dict)
    critical: list[str] = field(default_factory=list)
    explanations: dict[str, str] = field(default_factory=dict)
    flow_evidence: list[str] = field(default_factory=list)
    waits: list[dict[str, Any]] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)
    card_id: str = ""
    evaluation_status: str = ""
    session_id: str = ""
    wav: str = ""

    def note(self, text: str) -> None:
        self.log.append(f"{now():%H:%M:%S} {text}")


class Walk:
    """Один прогон: занятие, карточка до закрытия, разбор."""

    def __init__(self, run: Run, api: str, password: str, wav: bool) -> None:
        self.run = run
        self.data = run.data
        self.base = api
        self.password = password
        self.check_wav = wav
        self.service = SEATS[run.code]
        self.scenario_id = scenario_uuid(self.data)
        self.call: str | None = None
        self.call_kind = ""
        self.last_activity = 0.0
        self.handled: set[str] = set()
        self.pending_calls: list[str] = []
        # Служба вызвана по просьбе бригады — бригаде перезванивают с вестью (HQ-055).
        self.service_asked = False
        self.pending_reply = False
        self.final_set = False
        self.statuses: list[str] = []
        self.branch = BRANCH[run.code] if run.path == "errors" else {}
        self.reports = self._reports()
        self.events = self._events()
        self.carried = self._carried()

    # --- данные сценария -------------------------------------------------------------
    def mid(self, name: str) -> str:
        return str(uuid5(self.scenario_id, name))

    def _reports(self) -> dict[str, dict[str, Any]]:
        """id реплики → доклад плана (и подмены докладов ветками событий)."""
        found: dict[str, dict[str, Any]] = {}
        for index, report in enumerate(self.data["plan"]):
            item = {**report, "last": index == len(self.data["plan"]) - 1}
            found[self.mid(f"message:{report['key']}")] = item
            for event in self.data.get("events", []):
                for branch, body in event["branches"].items():
                    if any(e.get("replace") == report["key"] for e in body["effects"]):
                        found[self.mid(f"event:{event['key']}:{branch}-replace")] = item
        return found

    def _events(self) -> dict[str, dict[str, Any]]:
        return {self.mid(f"event:{e['key']}"): e for e in self.data.get("events", [])}

    def _carried(self) -> dict[str, dict[str, Any]]:
        """id реплики ловушки повтора → доклад о выезде, который её говорит."""
        found: dict[str, dict[str, Any]] = {}
        for event in self.data.get("events", []):
            key = event["trigger"].get("report")
            report = self.reports.get(self.mid(f"message:{key}")) if key else None
            if (
                event["kind"] == "readback_error"
                and report is not None
                and report["justifies_state"] == "responding"
            ):
                found[self.mid(f"event:{event['key']}")] = report
        return found

    # --- действия ----------------------------------------------------------------------
    def act(self, label: str) -> None:
        self.run.actions.append((now(), label))
        self.last_activity = time.monotonic()

    def send(self, kind: str, payload: dict[str, Any], allow: tuple[int, ...] = ()) -> int:
        body = {
            "client_event_id": str(uuid4()),
            "client_ts": now().isoformat().replace("+00:00", "Z"),
            "type": kind,
            "payload": payload,
        }
        response = self.trainee.post(f"/cards/{self.run.card_id}/events", json=body)
        if response.status_code != 200 and response.status_code not in allow:
            self.run.api_errors.append(f"{kind}: {response.status_code} {response.text[:200]}")
        self.run.note(f"→ {kind} {response.status_code}")
        return response.status_code

    def status(self, state: str, comment: str, allow: tuple[int, ...] = ()) -> int:
        code = self.send("status_change", {"state": state, "comment": comment}, allow)
        if code == 200:
            self.statuses.append(state)
        self.act(f"статус «{STATE_LABELS[state]}»")
        return code

    def training(self) -> dict[str, Any]:
        return dict(self.trainee.get(f"/cards/{self.run.card_id}/training"))

    # --- занятие -----------------------------------------------------------------------
    def open_session(self) -> None:
        teacher = Api(self.base, "teacher", self.password)
        users = {u["login"]: u for u in teacher.get("/users")}
        settings = teacher.get("/settings")
        if self.run.code == HOUSEHOLD and not self.branch.get("caller_missing"):
            settings["phone_contacts"] = {self.service: WITH_CALLER}
        created = teacher.post(
            "/sessions",
            json={
                "title": (
                    f"Обход ГП-12: {self.data['title']} ({self.service}), "
                    f"{PATH_TITLES[self.run.path]}"
                ),
                "participants": [
                    {
                        "user_id": users[self.run.trainee]["id"],
                        "workstation_number": 17,
                        "dds_service_id": self.service,
                        "level": self.data["level"],
                    }
                ],
                "settings_snapshot": settings,
            },
        )
        created.raise_for_status()
        self.run.session_id = created.json()["id"]
        batch = teacher.post(
            f"/sessions/{self.run.session_id}/assignments/batch",
            json={
                "request_id": str(uuid4()),
                "items": [
                    {
                        "participant_id": users[self.run.trainee]["id"],
                        "scenario_id": str(self.scenario_id),
                        "scenario_version": self.data["version"],
                        "order": 1,
                        "delay_from_start_s": 0,
                        "delivery_mode": "profile",
                    }
                ],
            },
        )
        batch.raise_for_status()
        teacher.post(f"/sessions/{self.run.session_id}/start").raise_for_status()
        self.teacher = teacher
        self.trainee_id = users[self.run.trainee]["id"]

    def finish_session(self) -> None:
        if self.run.session_id:
            response = self.teacher.post(
                f"/sessions/{self.run.session_id}/finish",
                json={"contract_version": 2, "request_id": str(uuid4())},
            )
            # Незавершённое занятие обхода остаётся в списке преподавателя (russian-ui).
            if response.status_code != 200:
                self.run.problems.append(
                    f"занятие не завершено: {response.status_code} {response.text[:200]}"
                )

    def wait_card(self) -> dict[str, Any]:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            for card in self.trainee.get("/cards"):
                if card["session_id"] == self.run.session_id:
                    return dict(card)
            time.sleep(POLL_S)
        raise RuntimeError("карточка не пришла за 30 с")

    # --- разговор ----------------------------------------------------------------------
    def briefing_text(self) -> str:
        address = self.card["source"]["address"]
        house = f", дом {address['house']}" if address.get("house") else ""
        if self.branch.get("wrong_house"):
            house = f", дом {self.branch['wrong_house']}"
            self.run.made.append(f"во вводной неверный дом {self.branch['wrong_house']}")
        incident = self.card["source"].get("incident_class") or self.card["source"]["description"]
        return f"{address['street']}{house}. {incident}"

    def brief(self) -> None:
        training = self.training()
        brigade = training["available_brigade_ids"][0]
        targets = self.trainee.get(f"/services/{self.service}/call-targets")
        target = next(t for t in targets if t["brigade_id"] == brigade)
        self.crew = (brigade, target["id"])
        # «Номер наряда» — прямой номер направленной бригады: оценка сверяет его (HQ-062).
        self.send("field_change", {"field": "service_number", "value": target["phone_ext"]})
        self.call = str(uuid4())
        self.call_kind = "brigade"
        self.send(
            "call_dial_target",
            {"call_id": self.call, "call_target_id": target["id"], "brigade_id": brigade},
        )
        self.send("call_answer", {"call_id": self.call})
        text = self.briefing_text()
        mode = "voice" if self.run.path == "voice" else "parts"
        if mode == "voice" and self.check_wav:
            self.wav_check()
        check = self.trainee.post(f"/calls/{self.call}/briefing-check", json={"text": text})
        wrong = self.branch.get("wrong_house") and check.json().get("address") == "wrong"
        if wrong:
            self.run.note(f"проверка вводной: бригада поняла {check.json().get('heard_address')}")
        elif check.status_code != 200 or not check.json().get("complete"):
            self.run.problems.append(f"проверка вводной: {check.status_code} {check.text[:200]}")
        self.send("brigade_briefing", {"call_id": self.call, "mode": mode, "text": text})
        self.act("вводная бригаде")

    def hang_up(self) -> None:
        if self.call:
            self.send("call_hangup", {"call_id": self.call})
            self.act("отбой")
        self.call = None
        self.call_kind = ""

    def answer(self, item: dict[str, Any]) -> None:
        if self.call:
            self.hang_up()
        self.call = str(item["call_id"])
        self.call_kind = "incoming"
        self.send("call_answer", {"call_id": self.call})
        self.act("ответ на вызов бригады" + (" (тревога)" if item.get("priority") else ""))

    def silent_too_long(self) -> bool:
        """Бригада молчит дольше `no_contact.silent_s` в своём статусе — пора её спросить."""
        if not self.statuses or self.final_report is not None:
            return False
        for event in self.data.get("events", []):
            trigger = event["trigger"]
            if trigger["on"] != "no_contact" or trigger["state"] != self.statuses[-1]:
                continue
            if event["key"] in self.done:
                continue
            if time.monotonic() - self.last_activity >= trigger["silent_s"] + 1:
                self.done.add(event["key"])
                return True
        return False

    def ask_brigade(self) -> None:
        """«Доложите обстановку» (раздел 4): звонок бригаде, которая долго молчит."""
        brigade, target = self.crew
        self.call = str(uuid4())
        self.call_kind = "brigade"
        self.send(
            "call_dial_target",
            {"call_id": self.call, "call_target_id": target, "brigade_id": brigade},
        )
        self.send("call_answer", {"call_id": self.call})
        self.send("brigade_said", {"call_id": self.call, "text": "Доложите обстановку."})
        self.act("звонок бригаде: «Доложите обстановку»")

    def tell_brigade(self) -> None:
        """Перезвонить бригаде: «Вызвал, едут» — о службе, которую она просила (HQ-055)."""
        brigade, target = self.crew
        self.call = str(uuid4())
        self.call_kind = "brigade"
        self.send(
            "call_dial_target",
            {"call_id": self.call, "call_target_id": target, "brigade_id": brigade},
        )
        self.send("call_answer", {"call_id": self.call})
        self.send("brigade_said", {"call_id": self.call, "text": "Вызвал, едут."})
        self.act("звонок бригаде: «Вызвал, едут»")

    def service_report(self, phone_ext: str) -> str:
        source = self.card["source"]
        address = source["address"]
        return (
            f"Диспетчер службы {self.service} Иванов. {address['street']}, "
            f"{address.get('house', '')}, {source.get('incident_class') or ''}. "
            f"Работаем по карточке {source['number']}. "
            f"Бригада на месте просит помощи службы {phone_ext}."
        )

    def dial(self, phone_ext: str) -> None:
        if self.call:
            self.hang_up()
        call_id = str(uuid4())
        expect_refusal = phone_ext == CALLER["number"] and self.branch.get("caller_missing")
        code = self.send(
            "call_dial",
            {"call_id": call_id, "phone_ext": phone_ext},
            (422,) if expect_refusal else (),
        )
        self.act(f"звонок {phone_ext}")
        if code != 200:
            if expect_refusal:
                self.run.made.append(f"звонок {phone_ext} — номера нет в телефоне ДДС ({code})")
            return
        self.send("call_answer", {"call_id": call_id})
        if self.run.path == "voice":
            report = self.trainee.post(
                f"/calls/{call_id}/voice-report", data={"text": self.service_report(phone_ext)}
            )
            body = report.json() if report.status_code == 200 else {}
            if report.status_code != 200 or not body.get("choice"):
                self.run.problems.append(f"voice-report {report.status_code}: {report.text[:200]}")
            payload = {
                "call_id": call_id,
                "report_choices": [body.get("choice") or "full"],
                "report_modes": ["voice"],
                "report_parts": [body.get("parts") or []],
            }
        else:
            payload = {
                "call_id": call_id,
                "report_choices": ["full"],
                "report_modes": ["option"],
                "report_parts": [["who", "address", "card", "change"]],
            }
        self.send("call_hangup", payload)
        self.act(f"доклад {phone_ext} и отбой")

    def present(self, item: dict[str, Any]) -> None:
        delivery = item["delivery"]
        self.send(
            "message_presented",
            {
                "delivery_id": delivery["delivery_id"],
                "message_version": delivery["message"]["version"],
                "playback_id": str(uuid4()),
                "channel": "text",
                "audio_version": None,
            },
        )

    def reply(self, item: dict[str, Any], key: str) -> None:
        delivery = item["delivery"]
        label = next(
            (o["label"] for o in delivery.get("reply_options") or [] if o["key"] == key), key
        )
        payload: dict[str, Any] = {
            "call_id": delivery["call_id"],
            "delivery_id": delivery["delivery_id"],
            "option_key": key,
        }
        if self.run.path == "voice":
            payload.update({"mode": "voice", "text": label})
        else:
            payload["mode"] = "option"
        self.send("brigade_reply", payload)
        self.act(f"ответ бригаде «{label}»")

    # --- реакция на реплику ------------------------------------------------------------
    def on_line(self, item: dict[str, Any], ring: dict[str, datetime]) -> None:
        delivery = item["delivery"]
        message_id = str(delivery["message"]["id"])
        heard_at = ring.get(str(delivery["call_id"])) or parse_ts(delivery["delivered_at"]) or now()
        text = text_of(delivery["message"])
        self.run.lines.append((heard_at, message_id, text))
        self.run.note(f"← {text[:70]}")
        if item["state"] != "presented":
            self.present(item)
        self.last_activity = time.monotonic()
        report = self.reports.get(message_id)
        if report is not None:
            # Доклад прежнего звонка (не дослушан) подтверждают в идущем разговоре.
            self.send(
                "report_confirmed",
                {
                    "call_id": self.call or delivery["call_id"],
                    "delivery_id": delivery["delivery_id"],
                    "text": "Принял",
                },
            )
            self.on_report(report)
            return
        event = self.events.get(message_id)
        if event is None:
            return
        choice = (self.branch.get("choices") or {}).get(event["key"])
        expect = event["expect"]
        if choice == "skip":
            self.run.made.append(f"событие «{event['key']}» пропущено")
            if message_id in self.carried:
                self.on_report(self.carried[message_id])
            return
        for step in expect:
            if step["action"] in ("reply", "correct_readback"):
                key = choice or step["option_key"]
                if key != step["option_key"]:
                    self.run.made.append(f"событие «{event['key']}»: ответ «{key}»")
                self.reply(item, key)
            elif step["action"] == "call_service":
                self.pending_calls.append(step["phone_exts"][0])
                # Весть о службе ждут у любого события бригады с `call_service`: просьба
                # (`request_service`) и тревога (contracts/scenario-events.md, HQ-055).
                self.service_asked = True
        if self.run.code == HOUSEHOLD and event["key"] == "door":
            self.pending_calls.append(CALLER["number"])
        # Повтор адреса с ошибкой говорит сам доклад о выезде (проверка 17.10,
        # `scenario_events.carried_events`): ответ на повтор — и он же доклад этапа.
        carried = self.carried.get(message_id)
        if carried is not None:
            self.on_report(carried)

    def on_report(self, report: dict[str, Any]) -> None:
        state = report["justifies_state"]
        if report["last"]:
            self.final_report = report
            return
        if self.run.path == "errors" and state == "responding" and "early" not in self.done:
            # Статус без доклада (раздел 7): «Прибытие» сразу после выезда — сервер не даёт.
            self.done.add("early")
            code = self.status("arrived", "Прибыли.", allow=(409, 422))
            if code in (409, 422):
                self.run.refusals.append(f"«Прибытие» без доклада → {code}")
                self.run.made.append("статус «Прибытие» без доклада (сервер отказал)")
                journal = self.trainee.get(f"/cards/{self.run.card_id}/events")
                denied = [e["payload"]["state"] for e in journal if e["type"] == "status_denied"]
                if denied != ["arrived"]:
                    self.run.problems.append(f"отказ не записан в журнал карточки: {denied}")
            else:
                self.run.problems.append(f"статус без доклада принят ({code})")
        self.status(state, text_of(report["line"]))

    def close(self) -> None:
        report = self.final_report
        final = self.branch.get("final") or report["justifies_state"]
        if final != report["justifies_state"]:
            self.run.made.append(f"завершающий статус «{STATE_LABELS[final]}»")
        comment = self.data["reference"]["expected_comment"]
        if self.status(final, comment) == 200:
            self.final_set = True

    # --- прогон ------------------------------------------------------------------------
    def go(self) -> None:
        self.done: set[str] = set()
        self.final_report: dict[str, Any] | None = None
        self.trainee = Api(self.base, self.run.trainee, self.password)
        self.open_session()
        try:
            self.card = self.wait_card()
            self.run.card_id = str(self.card["id"])
            self.send("deliver", {})
            self.act("карточка получена")
            self.send("open", {})
            if self.run.code == NOT_OURS and not self.branch.get("accept_not_ours"):
                comment = self.data["reference"]["expected_comment"]
                self.status("rejected", comment)
                self.send("redirect", {"service_id": "GKH", "comment": comment})
                self.act("перенаправление в ЖКХ")
                self.final_set = True
            else:
                if self.run.path == "errors" and self.run.code != NOT_OURS:
                    time.sleep(LATE_ACCEPT_S)
                    self.run.made.append(f"«Принята» через {LATE_ACCEPT_S:.0f} с (норматив 30 с)")
                if self.run.code == NOT_OURS:
                    self.run.made.append("не наша карточка принята")
                self.accept()
                self.brief()
                self.loop()
            self.evaluate()
        finally:
            self.finish_session()

    def accept(self) -> None:
        source = self.card["source"]
        victims = "Есть пострадавшие." if source["victims"] else "Пострадавших нет."
        self.status(
            "accepted",
            f"Принята: {source['incident_class']}. {source['description']} {victims} "
            "Высылаю бригаду.",
        )

    def loop(self) -> None:
        deadline = time.monotonic() + RUN_TIMEOUT_S
        inject_sent = False
        inject_tries = 0
        while time.monotonic() < deadline and not self.final_set:
            training = self.training()
            ring = {
                str(c["call_id"]): parse_ts(c["started_at"])
                for c in training.get("callbacks") or []
                if c.get("started_at")
            }
            fresh = [
                m
                for m in training["messages"]
                if m["delivery"]["delivery_id"] not in self.handled
                and self.call is not None
                # Доклад, выданный в разговор, который кончился раньше, чем его услышали,
                # звучит в следующем разговоре с бригадой (worker unheard_reports).
                and (str(m["delivery"]["call_id"]) == self.call or m["state"] != "presented")
            ]
            for item in sorted(fresh, key=lambda m: m["delivery"]["delivered_at"] or ""):
                self.handled.add(item["delivery"]["delivery_id"])
                self.on_line(item, {k: v for k, v in ring.items() if v})
            if (
                self.run.code == "smoke-apartment-101-1"
                and self.run.path == "parts"
                and not inject_sent
                and "arrived" in self.statuses
                and self.call is None
                and time.monotonic() - self.last_activity > 2
            ):
                inject_tries += 1
                response = self.teacher.post(
                    f"/sessions/{self.run.session_id}/injects",
                    json={"kind": "alarm", "targets": [self.trainee_id]},
                )
                results = response.json().get("results") if response.status_code == 201 else None
                fired = bool(results) and results[0]["status"] == "fired"
                self.run.note(f"вводная «Тревога» {response.status_code} {results}")
                # Тревога не перебивает разговор: преподаватель подаёт её снова через 10 с.
                if fired:
                    inject_sent = True
                    self.run.made.append("вводная преподавателя «Тревога» (ответить и вызвать 103)")
                elif inject_tries >= 6:
                    inject_sent = True
                    self.run.problems.append(f"тревога не сработала: {response.text[:300]}")
                else:
                    self.last_activity = time.monotonic() + 8
            if self.pending_calls and not fresh:
                for ext in self.pending_calls:
                    self.dial(ext)
                # Служба по просьбе бригады: бригаде сообщают, что она едет (HQ-055);
                # звонок заявителю (бытовой ЖКХ) — не просьба бригады, вести нет.
                if self.service_asked:
                    self.tell_brigade()
                    self.service_asked = False
                self.pending_calls = []
                continue
            if self.final_report is not None and not fresh:
                self.hang_up()
                self.close()
                break
            incoming = training.get("incoming") or []
            if incoming and (self.call is None or self.call_kind != "incoming"):
                alarm = [i for i in incoming if i.get("priority") == "alarm"]
                self.answer((alarm or incoming)[0])
                continue
            if self.call and not fresh and time.monotonic() - self.last_activity > SILENCE_S:
                self.hang_up()
            if self.call is None and self.silent_too_long():
                self.ask_brigade()
                continue
            time.sleep(POLL_S)
        if not self.final_set:
            self.run.problems.append("карточка не закрыта за отведённое время")

    def evaluate(self) -> None:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            evaluation = next(
                (e for e in self.trainee.get("/evaluations") if e["card_id"] == self.run.card_id),
                None,
            )
            if evaluation and evaluation.get("criteria"):
                self.run.evaluation_status = str(evaluation.get("status"))
                self.run.closed = True
                for item in evaluation["criteria"]:
                    key = item.get("key") or item.get("criterion")
                    self.run.criteria[key] = float(item.get("score", 0))
                    self.run.explanations[key] = str(item.get("explanation", ""))[:300]
                    if key == "status_flow":
                        self.run.flow_evidence = [str(line) for line in item.get("evidence", [])]
                    if item.get("critical"):
                        self.run.critical.append(key)
                return
            time.sleep(1)
        self.run.problems.append("разбор не появился за 60 с")

    def wav_check(self) -> None:
        """WAV вводной доходит до распознавания (voice-reply без delivery_id): со STT —
        распознанный текст, без STT стенд отвечает 503 с причиной."""
        files = {"audio": ("phrase.wav", tiny_wav(), "audio/wav")}
        response = self.trainee.post(f"/calls/{self.call}/voice-reply", files=files)
        self.run.wav = f"{response.status_code} {response.text[:160]}"
        self.run.note(f"WAV вводной → {self.run.wav}")


def measure(run: Run) -> None:
    """Ожидание каждой реплики бригады: от последнего действия или реплики до неё."""
    marks = [(t, "action", label) for t, label in run.actions]
    for t, _, text in run.lines:
        marks.append((t, "line", text))
    marks.sort(key=lambda item: item[0])
    previous: datetime | None = None
    for t, kind, label in marks:
        if kind == "line" and previous is not None:
            gap = (t - previous).total_seconds()
            run.waits.append({"wait_s": round(gap, 1), "line": label[:80]})
        previous = t if previous is None else max(previous, t)


def verdict(run: Run) -> None:
    worse = {key for key, score in run.criteria.items() if score < 1}
    if run.path == "errors":
        expected = set(run.expect)
        missing = expected - worse
        if missing:
            run.problems.append(f"разбор не назвал ошибку: {sorted(missing)}")
        extra = worse - expected
        if extra:
            run.problems.append(f"разбор снял баллы сверх ошибок: {sorted(extra)}")
        if run.refusals and run.closed and DENIED_LINE not in run.flow_evidence:
            run.problems.append(f"разбор не назвал статус без доклада: {run.flow_evidence}")
    elif run.path == "parts":
        # Доклад службе вариантом оценивается ниже голоса (report_choice_factor, решение #78).
        lower = {k for k in worse if k == "call" and "вариантом ответа" in run.explanations[k]}
        if worse - lower or run.critical:
            run.problems.append(f"путь по частям не чистый: {sorted(worse)} {run.critical}")
    elif worse or run.critical:
        run.problems.append(f"эталонный путь не чистый: {sorted(worse)} {run.critical}")
    long = [w for w in run.waits if w["wait_s"] > MAX_WAIT_S]
    if long:
        run.problems.append(f"ожидание дольше {MAX_WAIT_S:.0f} с: {long}")
    if run.api_errors:
        run.problems.append(f"ошибки API: {run.api_errors}")


def worker(jobs: queue.Queue[Run], args: argparse.Namespace, results: list[Run]) -> None:
    while True:
        try:
            run = jobs.get_nowait()
        except queue.Empty:
            return
        walk = Walk(run, args.api, args.password, args.wav)
        if run.path == "errors":
            run.expect = set(BRANCH[run.code]["expect"])
            if run.code != NOT_OURS:
                run.expect.add("reaction_time")
        try:
            walk.go()
        except Exception as error:  # noqa: BLE001 — прогон пишет причину и идёт дальше
            run.problems.append(f"сбой прогона: {error!r}")
        measure(run)
        verdict(run)
        results.append(run)
        status = "ok" if not run.problems else "FAIL"
        print(
            f"{status:4} {run.code:24} {run.path:6} закрыта={run.closed} "
            f"макс. ожидание={max((w['wait_s'] for w in run.waits), default=0):.1f} с "
            f"баллы<1={sorted(k for k, v in run.criteria.items() if v < 1)}",
            flush=True,
        )
        for problem in run.problems:
            print(f"     {problem}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--api", default="http://127.0.0.1:8000/api")
    parser.add_argument("--password", default="demo-local")
    parser.add_argument("--only", nargs="*", default=[], help="код[:путь] — только эти прогоны")
    parser.add_argument("--workers", type=int, default=len(TRAINEES))
    parser.add_argument(
        "--wav",
        action="store_true",
        help="проверить, что WAV вводной доходит до распознавания (voice-reply)",
    )
    parser.add_argument("--out", type=Path)
    parser.add_argument("--ca", help="корневой сертификат стенда для https (Docker-стенд)")
    args = parser.parse_args()
    Api.ca = args.ca
    wanted = []
    for code in SEATS:
        for path in PATHS:
            if args.only and code not in args.only and f"{code}:{path}" not in args.only:
                continue
            wanted.append((code, path))
    trainees = TRAINEES[: max(1, min(args.workers, len(TRAINEES)))]
    per_trainee: list[list[tuple[str, str]]] = [[] for _ in trainees]
    for index, item in enumerate(wanted):
        per_trainee[index % len(trainees)].append(item)
    results: list[Run] = []
    threads = []
    for trainee, items in zip(trainees, per_trainee, strict=True):
        own: queue.Queue[Run] = queue.Queue()
        for code, path in items:
            data = json.loads((SCENARIOS / f"{code}.json").read_text(encoding="utf-8"))
            own.put(Run(code, path, trainee, data))
        thread = threading.Thread(target=worker, args=(own, args, results))
        thread.start()
        threads.append(thread)
    for thread in threads:
        thread.join()
    if args.out:
        args.out.write_text(
            json.dumps(
                [
                    {
                        "code": r.code,
                        "path": r.path,
                        "trainee": r.trainee,
                        "card_id": r.card_id,
                        "closed": r.closed,
                        "evaluation_status": r.evaluation_status,
                        "wav": r.wav,
                        "made": r.made,
                        "refusals": r.refusals,
                        "criteria": r.criteria,
                        "critical": r.critical,
                        "explanations": r.explanations,
                        "flow_evidence": r.flow_evidence,
                        "waits": r.waits,
                        "problems": r.problems,
                        "log": r.log,
                    }
                    for r in sorted(results, key=lambda r: (r.code, PATHS.index(r.path)))
                ],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    return 0 if all(not r.problems for r in results) else 1


if __name__ == "__main__":
    sys.exit(main())
