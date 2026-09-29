"""Замеры C-09 на изолированном стенде: класс 23 АРМ, запись в БД, отчёт, 100 пользователей, ИИ.

Скрипт повторяет действия настоящих клиентов через nginx (HTTPS + WSS): вход, WebSocket,
выдача карточки, deliver/open/статусы/правки, отчёты преподавателя. Цифры — реальные
измерения этого прогона; целевые значения взяты из PRD (S10, NFR-4, NFR-8, FR-6.4, NFR-5).
Запуск — внутри образа API (`run.sh`), зависимостей на хосте не требует.
"""

import argparse
import asyncio
import json
import platform
import ssl
import statistics
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from websockets.asyncio.client import connect

STEPS = ("accepted", "responding", "completed")


def now() -> float:
    return time.perf_counter()


@dataclass
class Metrics:
    latency: dict[str, list[float]] = field(default_factory=lambda: defaultdict(list))
    errors: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    values: dict[str, Any] = field(default_factory=dict)

    def add(self, name: str, seconds: float) -> None:
        self.latency[name].append(seconds * 1000)

    def fail(self, name: str, reason: str) -> None:
        self.errors[f"{name}: {reason}"] += 1

    def summary(self) -> dict[str, dict[str, float]]:
        out = {}
        for name, items in sorted(self.latency.items()):
            ordered = sorted(items)
            out[name] = {
                "n": len(ordered),
                "p50_ms": round(statistics.median(ordered), 1),
                "p95_ms": round(ordered[max(0, int(len(ordered) * 0.95) - 1)], 1),
                "max_ms": round(ordered[-1], 1),
            }
        return out


class Client:
    def __init__(self, base: str, login: str, password: str, metrics: Metrics) -> None:
        self.base, self.login_name, self.password, self.metrics = base, login, password, metrics
        self.http = httpx.AsyncClient(base_url=base, verify=False, timeout=120)
        self.csrf = ""
        self.user: dict[str, Any] = {}
        self.ws: Any = None
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.listener: asyncio.Task[None] | None = None

    async def request(self, name: str, method: str, path: str, body: Any = None) -> Any:
        headers = {"X-CSRF-Token": self.csrf} if method != "GET" else {}
        started = now()
        try:
            response = await self.http.request(method, path, json=body, headers=headers)
        except httpx.HTTPError as exc:
            self.metrics.fail(name, type(exc).__name__)
            raise
        self.metrics.add(name, now() - started)
        if response.status_code >= 400:
            self.metrics.fail(name, str(response.status_code))
            raise RuntimeError(f"{name} {response.status_code}: {response.text[:200]}")
        if response.headers.get("content-type", "").startswith("application/json"):
            return response.json()
        return response.content

    async def login(self) -> None:
        self.user = await self.request(
            "login",
            "POST",
            "/api/auth/login",
            {"login": self.login_name, "password": self.password},
        )
        self.csrf = self.http.cookies.get("csrf") or ""

    async def connect_ws(self) -> None:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        host = self.base.split("://", 1)[1]
        started = now()
        self.ws = await connect(
            f"wss://{host}/ws",
            ssl=context,
            additional_headers={
                "Cookie": f"session={self.http.cookies.get('session')}",
                "Origin": self.base,
            },
            max_size=None,
            open_timeout=60,
        )
        self.metrics.add("ws_connect", now() - started)
        self.listener = asyncio.create_task(self._listen())

    async def _listen(self) -> None:
        try:
            async for raw in self.ws:
                message = json.loads(raw)
                message["_received"] = now()
                await self.events.put(message)
        except Exception:  # noqa: BLE001 — обрыв фиксируется ниже по отсутствию событий
            return

    async def event(self, card_id: str, kind: str, payload: dict[str, Any], name: str) -> Any:
        return await self.request(
            name,
            "POST",
            f"/api/cards/{card_id}/events",
            {
                "client_event_id": str(uuid.uuid4()),
                "client_ts": datetime.now(UTC).isoformat(),
                "type": kind,
                "payload": payload,
            },
        )

    async def close(self) -> None:
        if self.ws is not None:
            await self.ws.close()
        if self.listener is not None:
            self.listener.cancel()
        await self.http.aclose()


class LiveLag:
    """Лаг live-доски: ответ на действие обучаемого → card.updated у преподавателя."""

    def __init__(self, metrics: Metrics) -> None:
        self.metrics = metrics
        self.sent: dict[str, deque[float]] = defaultdict(deque)

    def mark(self, card_id: str) -> None:
        self.sent[card_id].append(now())

    def seen(self, message: dict[str, Any]) -> None:
        payload = message.get("payload") or {}
        card_id = payload.get("id") if isinstance(payload, dict) else None
        if message.get("type") == "card.updated" and card_id and self.sent[card_id]:
            self.metrics.add("live_board_lag", message["_received"] - self.sent[card_id].popleft())


async def watch_teacher(teacher: Client, lag: LiveLag, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            message = await asyncio.wait_for(teacher.events.get(), timeout=0.5)
        except TimeoutError:
            continue
        lag.seen(message)


async def next_card(client: Client, seen: set[str], session_id: str, timeout: float) -> str:
    deadline = now() + timeout
    while now() < deadline:
        try:
            message = await asyncio.wait_for(client.events.get(), timeout=deadline - now())
        except TimeoutError:
            break
        kind, payload = message.get("type"), message.get("payload")
        cards: list[dict[str, Any]] = []
        if kind == "card.appeared" and isinstance(payload, dict):
            cards = [payload]
        elif kind == "snapshot" and isinstance(payload, dict):
            cards = payload.get("cards") or []
        for card in cards:
            if card.get("session_id") == session_id and card["id"] not in seen:
                seen.add(card["id"])
                return str(card["id"])
    raise TimeoutError("карточка не пришла по WebSocket")


async def work_card(
    client: Client,
    card_id: str,
    comment: str,
    burst: int,
    think: float,
    lag: LiveLag,
    barrier: asyncio.Barrier | None = None,
) -> tuple[list[float], float | None]:
    async def act(kind: str, payload: dict[str, Any], name: str) -> None:
        lag.mark(card_id)
        await client.event(card_id, kind, payload, name)

    await act("deliver", {}, "deliver")
    await asyncio.sleep(think)
    await act("open", {}, "open")
    await asyncio.sleep(think)
    await act("status_change", {"state": STEPS[0], "comment": comment}, "status_change")
    # Всплеск правок без пауз и с общим стартом у всех клиентов: окно замера записи
    # не разбавляется паузами и сменами статусов.
    written: list[float] = []
    burst_start: float | None = None
    if barrier is not None:
        try:
            await asyncio.wait_for(barrier.wait(), timeout=120)
        except (TimeoutError, asyncio.BrokenBarrierError):
            pass
    if burst:
        burst_start = now()
    for index in range(burst):
        await act("field_change", {"field": "comment", "value": f"{comment} #{index}"}, "write")
        written.append(now())
    for state in STEPS[1:]:
        await asyncio.sleep(think)
        await act("status_change", {"state": state, "comment": comment}, "status_change")
    return written, burst_start


def burst_rate(starts: list[float], stamps: list[float]) -> tuple[float | None, float]:
    """События/с от общего старта всплеска до последней записи."""
    if not starts or not stamps:
        return None, 0.0
    window = max(stamps) - min(starts)
    return (round(len(stamps) / window, 1) if window > 0 else None), round(window, 2)


async def make_session(
    teacher: Client,
    trainees: list[dict[str, Any]],
    scenarios: list[dict[str, Any]],
    cards: int,
    title: str,
) -> tuple[str, dict[str, dict[str, Any]]]:
    settings = await teacher.request("get_settings", "GET", "/api/settings")
    settings["parallel_cards"] = 1
    plan: dict[str, dict[str, Any]] = {}
    participants = []
    for index, user in enumerate(trainees):
        scenario = scenarios[index % len(scenarios)]
        plan[user["id"]] = scenario
        participants.append(
            {
                "user_id": user["id"],
                "workstation_number": user["workstation_number"],
                "dds_service_id": scenario["target_service_id"],
                "level": 1,
            }
        )
    lesson = await teacher.request(
        "create_session",
        "POST",
        "/api/sessions",
        {"title": title, "participants": participants, "settings_snapshot": settings},
    )
    items = [
        {
            "participant_id": user["id"],
            "scenario_id": plan[user["id"]]["id"],
            "scenario_version": plan[user["id"]]["version"],
            "order": order,
            "delay_from_start_s": 0,
            "delivery_mode": "profile",
        }
        for user in trainees
        for order in range(1, cards + 1)
    ]
    await teacher.request(
        "assign_batch",
        "POST",
        f"/api/sessions/{lesson['id']}/assignments/batch",
        {"request_id": str(uuid.uuid4()), "items": items},
    )
    return lesson["id"], plan


async def class_run(args: argparse.Namespace, metrics: Metrics) -> dict[str, Any]:
    """Класс: N АРМ одновременно, выдача, работа с карточками, всплеск записи, отчёт."""
    teacher = Client(args.base, "teacher", args.demo_password, metrics)
    await teacher.login()
    await teacher.connect_ws()
    users = await teacher.request("list_users", "GET", "/api/users")
    bench = sorted(
        (u for u in users if u["login"].startswith("bench") and u.get("workstation_number")),
        key=lambda u: u["login"],
    )[: args.workstations]
    if len(bench) < args.workstations:
        raise RuntimeError("мало bench-пользователей с рабочим местом: запустите seed_users.py")
    scenarios = [
        s
        for s in await teacher.request("list_scenarios", "GET", "/api/scenarios")
        if s["status"] == "approved" and s.get("reference", {}).get("expected_comment")
    ]
    by_service: dict[str, dict[str, Any]] = {}
    for scenario in scenarios:
        by_service.setdefault(scenario["target_service_id"], scenario)
    chosen = list(by_service.values())
    session_id, plan = await make_session(
        teacher, bench, chosen, args.cards, f"Замер класса {args.workstations} АРМ"
    )

    clients = [Client(args.base, u["login"], args.bench_password, metrics) for u in bench]
    await asyncio.gather(*(c.login() for c in clients))
    await asyncio.gather(*(c.connect_ws() for c in clients))

    lag = LiveLag(metrics)
    stop = asyncio.Event()
    watcher = asyncio.create_task(watch_teacher(teacher, lag, stop))
    written: list[float] = []
    starts: list[float] = []
    card_ids: list[str] = []
    barrier = asyncio.Barrier(len(clients))

    async def trainee(client: Client, user: dict[str, Any]) -> None:
        seen: set[str] = set()
        comment = plan[user["id"]]["reference"]["expected_comment"]
        waited = now()
        for number in range(args.cards):
            first = number == 0
            try:
                card_id = await next_card(client, seen, session_id, args.card_timeout)
            except TimeoutError:
                metrics.fail("card_appeared", "timeout")
                if first:
                    await barrier.abort()
                return
            metrics.add("card_appeared", now() - waited)
            card_ids.append(card_id)
            try:
                stamps, start = await work_card(
                    client,
                    card_id,
                    comment,
                    args.burst if first else 0,
                    args.think,
                    lag,
                    barrier if first else None,
                )
            except Exception as exc:  # noqa: BLE001 — ошибка уже учтена в metrics
                metrics.fail("card_flow", type(exc).__name__)
                if first:
                    await barrier.abort()
                return
            written.extend(stamps)
            if start is not None:
                starts.append(start)
            waited = now()

    started = now()
    await teacher.request("start_session", "POST", f"/api/sessions/{session_id}/start")
    await asyncio.gather(*(trainee(c, u) for c, u in zip(clients, bench, strict=True)))
    duration = now() - started
    await asyncio.sleep(2)
    stop.set()
    await watcher

    rate, window = burst_rate(starts, written)
    # Отчёт строится после того, как worker досчитал оценки завершённых карточек.
    await asyncio.sleep(args.settle)
    report_times = {}
    for name, path in (
        ("report_json", f"/api/reports/session/{session_id}"),
        ("report_csv", f"/api/reports/session/{session_id}/csv"),
        ("analytics", f"/api/reports/session/{session_id}/analytics"),
    ):
        started_report = now()
        await teacher.request(name, "GET", path)
        report_times[name] = round(now() - started_report, 3)

    llm = await measure_llm(teacher, card_ids, args) if args.llm else None
    await teacher.request("finish_session", "POST", f"/api/sessions/{session_id}/finish")
    for client in clients:
        await client.close()
    await teacher.close()
    return {
        "workstations": args.workstations,
        "cards_per_workstation": args.cards,
        "cards_total": len(card_ids),
        "cards_expected": args.workstations * args.cards,
        "duration_s": round(duration, 1),
        "writes": len(written),
        "write_window_s": window,
        "writes_per_s": rate,
        "report_s": report_times,
        "llm": llm,
    }


async def measure_llm(teacher: Client, card_ids: list[str], args: argparse.Namespace) -> Any:
    """Время до готового ИИ-слоя по каждой завершённой карточке (очередь worker → LLM)."""
    started = now()
    pending = set(card_ids[: args.llm_cards])
    done: dict[str, float] = {}
    statuses: dict[str, str] = {}
    while pending and now() - started < args.llm_timeout:
        for card_id in list(pending):
            analysis = await teacher.request("analysis", "GET", f"/api/cards/{card_id}/analysis")
            layers = ((analysis.get("evaluation") or {}).get("layers")) or []
            llm = next((layer for layer in layers if layer.get("layer") == "llm"), None)
            if llm and llm.get("status") not in ("pending", None):
                done[card_id] = now() - started
                statuses[card_id] = llm["status"]
                pending.discard(card_id)
        await asyncio.sleep(2)
    seconds = sorted(done.values())
    return {
        "cards": len(card_ids[: args.llm_cards]),
        "finished": len(done),
        "statuses": dict(sorted(defaultdict_count(statuses.values()).items())),
        "first_s": round(seconds[0], 1) if seconds else None,
        "last_s": round(seconds[-1], 1) if seconds else None,
    }


def defaultdict_count(values: Any) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for value in values:
        counts[value] += 1
    return counts


async def crowd_run(args: argparse.Namespace, metrics: Metrics) -> dict[str, Any]:
    """100 пользователей онлайн, 20 активных карточек; остальные опрашивают список карточек."""
    crowd_metrics = Metrics()
    teacher = Client(args.base, "teacher", args.demo_password, crowd_metrics)
    await teacher.login()
    await teacher.connect_ws()
    users = sorted(
        (
            u
            for u in await teacher.request("list_users", "GET", "/api/users")
            if u["login"].startswith("bench")
        ),
        key=lambda u: u["login"],
    )[: args.crowd]
    active = [u for u in users if u.get("workstation_number")][: args.crowd_active]
    scenarios = [
        s
        for s in await teacher.request("list_scenarios", "GET", "/api/scenarios")
        if s["status"] == "approved" and s.get("reference", {}).get("expected_comment")
    ]
    session_id, plan = await make_session(teacher, active, scenarios, 1, "Замер 100 пользователей")
    clients = {
        u["login"]: Client(args.base, u["login"], args.bench_password, crowd_metrics) for u in users
    }
    await asyncio.gather(*(c.login() for c in clients.values()))
    await asyncio.gather(*(c.connect_ws() for c in clients.values()))
    lag = LiveLag(crowd_metrics)
    stop = asyncio.Event()
    watcher = asyncio.create_task(watch_teacher(teacher, lag, stop))

    async def observer(client: Client) -> None:
        while not stop.is_set():
            try:
                await client.request("get_cards", "GET", "/api/cards")
            except Exception:  # noqa: BLE001 — учтено в metrics
                pass
            await asyncio.sleep(args.poll)

    async def worker_trainee(user: dict[str, Any]) -> None:
        client = clients[user["login"]]
        try:
            card_id = await next_card(client, set(), session_id, args.card_timeout)
            await work_card(
                client,
                card_id,
                plan[user["id"]]["reference"]["expected_comment"],
                5,
                args.think,
                lag,
            )
        except Exception as exc:  # noqa: BLE001
            crowd_metrics.fail("crowd_card", type(exc).__name__)

    observers = [asyncio.create_task(observer(c)) for c in clients.values()]
    await teacher.request("start_session", "POST", f"/api/sessions/{session_id}/start")
    await asyncio.gather(*(worker_trainee(u) for u in active))
    stop.set()
    await asyncio.gather(*observers, watcher)
    await teacher.request("finish_session", "POST", f"/api/sessions/{session_id}/finish")
    for client in clients.values():
        await client.close()
    await teacher.close()
    summary = crowd_metrics.summary()
    http = sorted(
        value
        for name, items in crowd_metrics.latency.items()
        # Рабочие запросы интерфейса; вход и подключение WS — разовые, считаются отдельно.
        if name not in ("login", "ws_connect", "live_board_lag")
        for value in items
    )
    return {
        "users_online": len(users),
        "active_cards": len(active),
        "http_requests": len(http),
        "http_p95_ms": round(http[max(0, int(len(http) * 0.95) - 1)], 1) if http else None,
        "login_p95_ms": summary.get("login", {}).get("p95_ms"),
        "ws_connect_p95_ms": summary.get("ws_connect", {}).get("p95_ms"),
        "latency": summary,
        "errors": dict(crowd_metrics.errors),
    }


def verdict(ok: bool | None) -> str:
    return "—" if ok is None else ("да" if ok else "НЕТ")


def markdown(result: dict[str, Any]) -> str:
    cls, crowd = result.get("class"), result.get("crowd")
    lines = [
        f"# Замеры C-09 · {result['label']}",
        "",
        f"Дата: {result['finished_at']}. Хост: {result['host'].get('cpu', '?')}, "
        f"{result['host'].get('ram', '?')}, {result['host'].get('os', '?')}.",
        "Стенд: изолированный Compose-проект, свежая БД, запросы через nginx (HTTPS/WSS).",
        "",
        "| Показатель | Цель (PRD) | Результат | Выполнено |",
        "|---|---|---|---|",
    ]
    if cls:
        appeared = result["latency"].get("card_appeared", {})
        lines += [
            f"| Одновременных АРМ в классе | 23 (S10) | {cls['workstations']}, карточек "
            f"{cls['cards_total']}/{cls['cards_expected']} | "
            f"{verdict(cls['cards_total'] == cls['cards_expected'])} |",
            f"| Запись событий через API | диагностика (цель NFR-8 относится к БД) | "
            f"{cls['writes_per_s']}/с "
            f"({cls['writes']} событий за {cls['write_window_s']} с: {cls['workstations']} "
            f"клиентов стартуют всплеск одновременно, у каждого по одному событию за раз) | — |",
            f"| Отчёт по занятию (JSON / CSV / аналитика) | ≤ 30 с (FR-6.4) | "
            f"{cls['report_s']['report_json']} / {cls['report_s']['report_csv']} / "
            f"{cls['report_s']['analytics']} с на {cls['cards_total']} карточках | "
            f"{verdict(max(cls['report_s'].values()) <= 30)} |",
            f"| Появление карточки (p95) | — | {appeared.get('p95_ms', '—')} мс | — |",
        ]
        if cls.get("llm"):
            llm = cls["llm"]
            lines.append(
                f"| ИИ-оценка комментария | асинхронно (NFR-5) | {llm['finished']}/{llm['cards']} "
                f"готово; последняя наблюдалась через {llm['last_s']} с после начала опроса, "
                f"статусы {llm['statuses']} | "
                f"{verdict(llm['finished'] == llm['cards'])} |"
            )
    if crowd:
        lines.append(
            f"| Пользователи онлайн и активные карточки | 100 и 20, p95 ≤ 2 с (NFR-4) | "
            f"{crowd['users_online']} онлайн, {crowd['active_cards']} карточек, p95 HTTP "
            f"{crowd['http_p95_ms']} мс на рабочих запросах ({crowd['http_requests']}) | "
            f"{verdict((crowd['http_p95_ms'] or 1e9) <= 2000)} |"
        )
        lines.append(
            f"| Одновременный вход всех пользователей | — | p95 входа {crowd['login_p95_ms']} мс, "
            f"подключения WS {crowd['ws_connect_p95_ms']} мс (все в одну секунду) | — |"
        )
    lines += [
        "",
        "## Задержки класса",
        "",
        "| Операция | n | p50, мс | p95, мс | max, мс |",
        "|---|---|---|---|---|",
    ]
    for name, row in result["latency"].items():
        lines.append(
            f"| {name} | {row['n']} | {row['p50_ms']} | {row['p95_ms']} | {row['max_ms']} |"
        )
    errors = {**result["errors"], **((crowd or {}).get("errors") or {})}
    lines += ["", "## Ошибки", ""]
    lines += [f"- {k}: {v}" for k, v in errors.items()] or ["- нет"]
    lines += [
        "",
        "Параметры: " + ", ".join(f"{k}={v}" for k, v in result["params"].items()),
    ]
    return "\n".join(lines) + "\n"


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="https://web")
    parser.add_argument("--label", default=platform.node())
    parser.add_argument("--out", default="qa/bench/results")
    parser.add_argument("--demo-password", required=True)
    parser.add_argument("--bench-password", required=True)
    parser.add_argument("--workstations", type=int, default=23)
    parser.add_argument("--cards", type=int, default=3)
    parser.add_argument("--burst", type=int, default=40)
    parser.add_argument("--think", type=float, default=1.0)
    parser.add_argument("--settle", type=float, default=10.0)
    parser.add_argument("--card-timeout", type=float, default=120.0)
    parser.add_argument("--crowd", type=int, default=100)
    parser.add_argument("--crowd-active", type=int, default=20)
    parser.add_argument("--poll", type=float, default=5.0)
    parser.add_argument("--skip-crowd", action="store_true")
    parser.add_argument("--llm", action="store_true")
    parser.add_argument("--llm-cards", type=int, default=6)
    parser.add_argument("--llm-timeout", type=float, default=900.0)
    parser.add_argument("--host-info", default="{}")
    args = parser.parse_args()

    metrics = Metrics()
    result: dict[str, Any] = {
        "label": args.label,
        "host": json.loads(args.host_info),
        "params": {
            k: v
            for k, v in vars(args).items()
            if k not in ("demo_password", "bench_password", "host_info")
        },
    }
    result["class"] = await class_run(args, metrics)
    if not args.skip_crowd:
        result["crowd"] = await crowd_run(args, metrics)
    result["latency"] = metrics.summary()
    result["errors"] = dict(metrics.errors)
    result["finished_at"] = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    folder = Path(args.out) / f"{args.label}-{datetime.now(UTC):%Y%m%dT%H%M}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    (folder / "report.md").write_text(markdown(result), encoding="utf-8")
    print(markdown(result))
    print(f"Результаты: {folder}")


if __name__ == "__main__":
    asyncio.run(main())
