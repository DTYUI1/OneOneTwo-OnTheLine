"""WebSocket-хаб одного API-процесса и межпроцессный PostgreSQL LISTEN/NOTIFY."""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import asyncpg  # type: ignore[import-untyped]
from anyio import BrokenResourceError, ClosedResourceError
from fastapi import HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

from app.api.foundation import repo as auth_repo
from app.api.notifications import CHANNEL
from app.core.models import Call
from app.core.security import read_token

logger = logging.getLogger(__name__)
RETRY_INITIAL_S = 0.5
RETRY_MAX_S = 5.0
PROBE_INTERVAL_S = 5.0
IO_TIMEOUT_S = 5.0
TRANSPORT_ERRORS = (BrokenResourceError, ClosedResourceError, RuntimeError, WebSocketDisconnect)
LISTENER_ERRORS = (OSError, TimeoutError, asyncpg.PostgresError, asyncpg.InterfaceError)


@dataclass
class Client:
    socket: WebSocket
    user_id: UUID
    role: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    close_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closing: bool = False
    sender: asyncio.Task[None] | None = None
    receiver: asyncio.Task[Any] | None = None
    # До отправки snapshot события копятся здесь: первым сообщением должен быть snapshot
    # (ws-events.md), а изменение, закоммиченное во время его чтения, не должно теряться.
    pending: list[tuple[str, Any]] | None = field(default_factory=list)


class RealtimeHub:
    def __init__(self, app: Any) -> None:
        self.app = app
        self.clients: dict[WebSocket, Client] = {}
        self.offsets: dict[UUID, float] = {}
        self.listener: asyncpg.Connection | None = None
        self.tasks: set[asyncio.Task[Any]] = set()
        self.supervisor: asyncio.Task[None] | None = None
        self._stopping = True
        self._ready = False
        self._reconnect = asyncio.Event()

    async def start(self) -> None:
        if self.supervisor is not None and not self.supervisor.done():
            return
        self._stopping = False
        self.supervisor = asyncio.create_task(self._listen(), name="realtime-listener")

    @property
    def healthy(self) -> bool:
        return (
            self._ready
            and self.listener is not None
            and not self.listener.is_closed()
            and self.supervisor is not None
            and not self.supervisor.done()
        )

    async def _open_listener(self) -> asyncpg.Connection:
        url = make_url(self.app.state.config.database_url).set(drivername="postgresql")
        return await asyncpg.connect(
            url.render_as_string(hide_password=False),
            timeout=IO_TIMEOUT_S,
            command_timeout=IO_TIMEOUT_S,
            server_settings={"application_name": "arm112-realtime"},
        )

    def _terminated(self, connection: asyncpg.Connection) -> None:
        if connection is self.listener:
            self._ready = False
            self._reconnect.set()

    async def _listen(self) -> None:
        delay = RETRY_INITIAL_S
        while not self._stopping:
            connection = None
            self._reconnect.clear()
            try:
                connection = await self._open_listener()
                self.listener = connection
                connection.add_termination_listener(self._terminated)
                await connection.add_listener(CHANNEL, self._received)
                # NOTIFY не хранит пропуски. Reconnect заново проверяет авторизацию
                # и даёт каждому браузеру свежий snapshot с его правами доступа.
                await self._close_clients()
                if connection.is_closed():
                    raise OSError("Соединение LISTEN закрыто во время синхронизации.")
                self._ready = True
                delay = RETRY_INITIAL_S
                logger.info("LISTEN/NOTIFY подключён; клиентам запрошена синхронизация.")
                while not self._reconnect.is_set():
                    try:
                        await asyncio.wait_for(self._reconnect.wait(), PROBE_INTERVAL_S)
                    except TimeoutError:
                        # Проверка обнаруживает и молчаливую потерю TCP без callback закрытия.
                        await connection.fetchval("SELECT 1", timeout=IO_TIMEOUT_S)
                logger.warning("LISTEN/NOTIFY потерян; запланировано переподключение.")
            except LISTENER_ERRORS as exc:
                logger.warning(
                    "LISTEN/NOTIFY недоступен (%s); повтор через %.1f с.",
                    type(exc).__name__,
                    delay,
                )
            finally:
                self._ready = False
                self.listener = None
                if connection is not None:
                    connection.remove_termination_listener(self._terminated)
                    try:
                        await connection.close(timeout=IO_TIMEOUT_S)
                    except LISTENER_ERRORS:
                        logger.warning(
                            "LISTEN/NOTIFY закрывается принудительно после ошибки транспорта."
                        )
                    finally:
                        # Отмена stop во время уже начатого close тоже не оставляет TCP-соединение.
                        if not connection.is_closed():
                            connection.terminate()
            if not self._stopping:
                await asyncio.sleep(delay)
                delay = min(delay * 2, RETRY_MAX_S)

    async def stop(self) -> None:
        self._stopping = True
        self._ready = False
        if self.supervisor is not None:
            self.supervisor.cancel()
            await asyncio.gather(self.supervisor, return_exceptions=True)
            self.supervisor = None
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.clear()
        await self._close_clients()
        self.offsets.clear()

    async def _close_clients(self) -> None:
        await asyncio.gather(*(self._close_client(c) for c in list(self.clients.values())))

    async def _close_client(self, client: Client, code: int = 1012) -> None:
        async with client.close_lock:
            client.closing = True
            # Сначала отменяем именно I/O, а не общий dispatch. Иначе send держит lock,
            # close не вызывается, а живой сокет исчезает из рассылки навсегда.
            pending = [task for task in (client.sender, client.receiver) if task is not None]
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            try:
                async with asyncio.timeout(IO_TIMEOUT_S), client.lock:
                    await client.socket.close(code=code)
            except (*TRANSPORT_ERRORS, TimeoutError):
                # Закрытая или зависшая вкладка не задерживает восстановление остальных.
                pass
            self.clients.pop(client.socket, None)

    def _received(
        self, connection: asyncpg.Connection, pid: int, channel: str, payload: str
    ) -> None:
        if self._stopping or connection is not self.listener:
            return
        task = asyncio.create_task(self._dispatch(payload))
        self.tasks.add(task)
        task.add_done_callback(self._dispatched)

    def _dispatched(self, task: asyncio.Task[Any]) -> None:
        self.tasks.discard(task)
        if task.cancelled():
            return
        if (error := task.exception()) is not None:
            logger.error(
                "Уведомление не доставлено (%s); нужна синхронизация.", type(error).__name__
            )
            # Даже при живом LISTEN ошибка чтения могла потерять событие для браузера.
            self._ready = False
            self._reconnect.set()

    def offset_for(self, user_id: UUID) -> float:
        return self.offsets.get(user_id, 0.0)

    @staticmethod
    def envelope(event_type: str, payload: Any, server_ts: str | None = None) -> dict[str, Any]:
        if hasattr(payload, "model_dump"):
            payload = payload.model_dump(mode="json")
        return {
            "schema_version": 1,
            "event_id": str(uuid4()),
            "server_ts": server_ts or datetime.now(UTC).isoformat(),
            "type": event_type,
            "payload": payload,
        }

    async def send(
        self, client: Client, event_type: str, payload: Any, server_ts: str | None = None
    ) -> None:
        async with asyncio.timeout(IO_TIMEOUT_S), client.lock:
            if client.closing:
                raise WebSocketDisconnect(1012)
            client.sender = asyncio.create_task(
                client.socket.send_json(self.envelope(event_type, payload, server_ts))
            )
            try:
                await client.sender
            except asyncio.CancelledError:
                if client.closing:
                    raise WebSocketDisconnect(1012) from None
                raise
            finally:
                client.sender = None

    async def _receive(self, client: Client) -> Any:
        if client.closing:
            raise WebSocketDisconnect(1012)
        client.receiver = asyncio.create_task(client.socket.receive_json())
        try:
            return await client.receiver
        except asyncio.CancelledError:
            if client.closing:
                raise WebSocketDisconnect(1012) from None
            raise
        finally:
            client.receiver = None

    async def _send_or_close(self, client: Client, event_type: str, payload: Any) -> None:
        if client.pending is not None:
            client.pending.append((event_type, payload))
            return
        try:
            await self.send(client, event_type, payload)
        except (*TRANSPORT_ERRORS, TimeoutError):
            await self._close_client(client)

    async def _flush_pending(self, client: Client) -> None:
        """Отправить накопленные до snapshot события в исходном порядке."""
        while client.pending:
            event_type, payload = client.pending.pop(0)
            await self.send(client, event_type, payload)
        # Проверка и сброс без await между ними: новое событие уйдёт уже напрямую.
        client.pending = None

    async def broadcast_presence(self, user_id: UUID, online: bool) -> None:
        await asyncio.gather(
            *(
                self._send_or_close(client, "presence", {"user_id": str(user_id), "online": online})
                for client in list(self.clients.values())
            )
        )

    async def snapshot(self, client: Client) -> dict[str, Any]:
        if client.role == "admin":
            # ТЗ, C-07: администратор не видит учебный процесс и результаты обучаемых.
            return {"cards": [], "sessions": [], "evaluations": []}
        from app.api.cards import repo as card_repo
        from app.api.cards.service import serialize_card
        from app.api.evaluations import repo as evaluation_repo
        from app.api.evaluations.service import serialize as serialize_evaluation
        from app.api.sessions import repo as session_repo
        from app.api.sessions.service import serialize as serialize_session

        async with self.app.state.database.sessions() as db:
            cards = [
                serialize_card(row).model_dump(mode="json")
                for row in await card_repo.cards(db, client.user_id, client.role)
            ]
            sessions = await session_repo.sessions(db, client.user_id, client.role)
            own = client.user_id if client.role == "trainee" else None
            lessons = [
                serialize_session(row, only_user=own).model_dump(mode="json") for row in sessions
            ]
            evaluation_rows = await evaluation_repo.evaluations(db, client.user_id, client.role)
            overrides = await evaluation_repo.latest_overrides(
                db, [row["Evaluation"].id for row in evaluation_rows]
            )
            evaluations = [
                serialize_evaluation(row, overrides.get(row["Evaluation"].id)).model_dump(
                    mode="json"
                )
                for row in evaluation_rows
            ]
        return {"cards": cards, "sessions": lessons, "evaluations": evaluations}

    async def connect(self, socket: WebSocket) -> None:
        origin = socket.headers.get("origin")
        host = socket.headers.get("host")
        if origin and urlsplit(origin).netloc != host:
            await socket.close(code=4403)
            return
        try:
            sid, user_id = read_token(socket.cookies.get("session", ""), self.app.state.config)
            async with self.app.state.database.sessions() as db:
                found = await auth_repo.authenticate(db, sid, user_id)
            if found is None:
                raise HTTPException(401)
            _, user = found
        except HTTPException:
            await socket.close(code=4401)
            return
        except (SQLAlchemyError, OSError, TimeoutError):
            await socket.close(code=1012)
            return
        await socket.accept()
        client = Client(socket=socket, user_id=user.id, role=user.role)
        self.clients[socket] = client
        try:
            await self.send(client, "snapshot", await self.snapshot(client))
            await self._flush_pending(client)
            await self.broadcast_presence(user.id, True)
            while True:
                message = await self._receive(client)
                if isinstance(message, dict) and message.get("type") == "clock.ping.v2":
                    if not await self._pong_v2(client, message):
                        await socket.close(code=4400)
                        break
                    continue
                if set(message) != {"type", "client_ts"} or message["type"] != "clock.ping":
                    await socket.close(code=4400)
                    break
                try:
                    client_ts = datetime.fromisoformat(message["client_ts"].replace("Z", "+00:00"))
                    if client_ts.tzinfo is None:
                        raise ValueError
                except (AttributeError, ValueError, TypeError):
                    await socket.close(code=4400)
                    break
                server_ts = datetime.now(UTC)
                self.offsets[user.id] = (server_ts - client_ts).total_seconds() * 1000
                await self.send(client, "clock.pong", {"client_ts": message["client_ts"]})
        except TRANSPORT_ERRORS:
            pass
        except (SQLAlchemyError, OSError, TimeoutError):
            pass
        finally:
            await self._close_client(client)
            if not any(item.user_id == user.id for item in self.clients.values()):
                self.offsets.pop(user.id, None)
                await self.broadcast_presence(user.id, False)

    async def _pong_v2(self, client: Client, message: dict[str, Any]) -> bool:
        """clock.ping.v2 → сохранённый pong с тем же server_ts (I-TIME, C-02)."""
        from app.api.clock import service as clock

        if set(message) != {"type", "sample_id", "client_ts"}:
            return False
        try:
            sample_id = UUID(str(message["sample_id"]))
            raw = str(message["client_ts"])
            if not raw.endswith("Z"):
                raise ValueError
            client_ts = clock.parse(raw)
        except (ValueError, TypeError):
            return False
        async with self.app.state.database.sessions.begin() as db:
            server_at = await clock.record_ping(db, client.user_id, sample_id, client_ts)
        if server_at is None:
            return False
        await self.send(
            client,
            "clock.pong.v2",
            {"sample_id": str(sample_id), "client_ts": raw},
            server_ts=clock.iso(server_at),
        )
        return True

    async def _dispatch(self, raw: str) -> None:
        from app.api.cards import repo as card_repo
        from app.api.cards.service import serialize_call, serialize_card
        from app.api.evaluations import repo as evaluation_repo
        from app.api.evaluations.service import serialize as serialize_evaluation
        from app.api.sessions import repo as session_repo
        from app.api.sessions.service import serialize as serialize_session

        try:
            message = json.loads(raw)
            event_type, entity_id = message["type"], UUID(message["id"])
            if event_type == "user.revoked":
                # C-07: блокировка и сброс пароля закрывают уже открытые вкладки; 4401 —
                # сессия недействительна, повторное подключение тоже получит отказ.
                await asyncio.gather(
                    *(
                        self._close_client(client, code=4401)
                        for client in list(self.clients.values())
                        if client.user_id == entity_id
                    )
                )
                return
            targets: list[tuple[Client, Any]] = []
            async with self.app.state.database.sessions() as db:
                if event_type.startswith("session."):
                    lesson = await session_repo.get_session(db, entity_id)
                    if lesson is None:
                        return
                    for client in self.clients.values():
                        visible = (
                            client.role == "teacher" and lesson.teacher_id == client.user_id
                        ) or (
                            client.role == "trainee"
                            and any(item.user_id == client.user_id for item in lesson.participants)
                        )
                        if visible:
                            own = client.user_id if client.role == "trainee" else None
                            targets.append((client, serialize_session(lesson, only_user=own)))
                elif event_type == "training.updated":
                    from app.core.models import CardTrainingState

                    card_view = await card_repo.card(db, entity_id, UUID(int=0), "admin")
                    state = await db.get(CardTrainingState, entity_id)
                    if card_view is None or state is None:
                        return
                    training_payload = {"card_id": str(entity_id), "revision": state.revision}
                    for client in self.clients.values():
                        if client.user_id in {
                            card_view["teacher_id"],
                            card_view["trainee_id"],
                        }:
                            targets.append((client, training_payload))
                elif event_type.startswith("card."):
                    card_view = await card_repo.card(db, entity_id, UUID(int=0), "admin")
                    if card_view is None:
                        return
                    if event_type == "card.appeared" and card_view["session_status"] != "running":
                        # NOTIFY мог ждать обработки уже после остановки занятия.
                        return
                    payload = serialize_card(card_view)
                    for client in self.clients.values():
                        if client.user_id in {
                            card_view["teacher_id"],
                            card_view["trainee_id"],
                        }:
                            targets.append((client, payload))
                elif event_type == "call.state":
                    call_row = await db.get(Call, entity_id)
                    if call_row is None:
                        return
                    card_view = await card_repo.card(db, call_row.card_id, UUID(int=0), "admin")
                    if card_view is None:
                        return
                    call_payload = serialize_call(call_row)
                    for client in self.clients.values():
                        if client.user_id in {
                            card_view["teacher_id"],
                            card_view["trainee_id"],
                        }:
                            targets.append((client, call_payload))
                elif event_type.startswith("evaluation."):
                    evaluation_row = await evaluation_repo.evaluation(
                        db, entity_id, UUID(int=0), "admin"
                    )
                    if evaluation_row is None:
                        return
                    override = (await evaluation_repo.latest_overrides(db, [entity_id])).get(
                        entity_id
                    )
                    evaluation_payload = serialize_evaluation(evaluation_row, override)
                    for client in self.clients.values():
                        if client.user_id in {
                            evaluation_row["teacher_id"],
                            evaluation_row["trainee_id"],
                        }:
                            targets.append((client, evaluation_payload))
            await asyncio.gather(
                *(self._send_or_close(client, event_type, payload) for client, payload in targets)
            )
        except (KeyError, ValueError, json.JSONDecodeError):
            logger.warning("Получено некорректное уведомление PostgreSQL.")
