"""Показ экрана ученика преподавателю (HQ-017): состояние и последний кадр — только в памяти.

Решение Dani 18.10: видео без звука, 5 кадров/с. Браузер ученика сам снимает экран
(`getDisplayMedia` — значит, согласие браузера обязательно), уменьшает кадр до ~960 px и шлёт
JPEG сюда, в отдельный WebSocket `/ws/screen`. Отдельный, а не общий `/ws`: кадры бинарные и
крупные (30–60 КБ пять раз в секунду от каждого из до 10 учеников), в общем сокете они стояли бы
в одной очереди с событиями карточек и задерживали бы их.

Хранится только последний кадр показа: преподавателю нужна «картинка сейчас», не запись. Медленный
получатель пропускает промежуточные кадры, а не копит очередь. Ничего из кадров не пишется в БД,
журналы и логи (ПДн, CONTRIBUTING §8); в audit_log попадают только запрос и остановка показа —
это HTTP-мутации (`service.py`), их пишет общий audit middleware.

Состояние одного процесса: стенд запускает один процесс uvicorn (`app.api.__main__`). При
нескольких процессах показ пришлось бы разносить через внешний брокер — сейчас не нужно.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from fastapi import HTTPException, WebSocket, WebSocketDisconnect
from sqlalchemy.exc import SQLAlchemyError

from app.api.sessions import repo as session_repo

if TYPE_CHECKING:
    from app.api.realtime import RealtimeHub

logger = logging.getLogger(__name__)

# 960×540 JPEG качества 0,6 весит 30–80 КБ; 256 КиБ — с запасом на пёстрый экран, но не 16 МиБ
# по умолчанию у uvicorn: один ученик не должен забить канал преподавателя.
MAX_FRAME_BYTES = 256 * 1024
# Предел одного входящего WebSocket-сообщения для uvicorn (`ws_max_size`): без него uvicorn
# дочитывает до 16 МиБ, и лимит кадра выше проверялся бы уже после буферизации. Общий для /ws и
# /ws/screen: в /ws клиент шлёт только clock.ping (меньше 200 байт), снимки идут от сервера и
# под предел не попадают. Запас 64 КиБ — на заголовок кадра и рамки протокола.
WS_MAX_BYTES = MAX_FRAME_BYTES + 64 * 1024
# Столько отброшенных кадров подряд — уже не дрожание таймера, а сломанный или злой клиент.
MAX_DROPS_IN_ROW = 20
# Статус занятия перепроверяется не реже раза в столько секунд, пока открыт сокет показа или
# просмотра: NOTIFY session.finished может потеряться (обрыв LISTEN), а показ не должен пережить
# занятие.
RUNNING_CHECK_S = 5.0
# 5 кадров/с = 200 мс; 150 мс оставляют место дрожанию таймера браузера, всё чаще — отбрасываем.
MIN_FRAME_INTERVAL_S = 0.15
# «До 10 плиток одновременно» (HQ-017): 10 × 5 × 60 КБ ≈ 3 МБ/с — проверено замером.
MAX_SHARES_PER_SESSION = 10
SEND_TIMEOUT_S = 5.0
JPEG_MAGIC = b"\xff\xd8"

# Коды закрытия /ws/screen (contracts/ws-events.md, HQ-017).
CLOSE_FINISHED = 4000
CLOSE_BAD_MESSAGE = 4400
CLOSE_FORBIDDEN = 4403
CLOSE_NOT_FOUND = 4404
CLOSE_REPLACED = 4409


@dataclass(eq=False)
class Share:
    session_id: UUID
    teacher_id: UUID
    user_id: UUID
    requested_at: datetime
    publisher: WebSocket | None = None
    frame: bytes | None = None
    seq: int = 0
    accepted_at: float = float("-inf")
    drops_in_row: int = 0


@dataclass(eq=False)
class Viewer:
    socket: WebSocket
    session_id: UUID
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    sent: dict[UUID, int] = field(default_factory=dict)


def view(share: Share, watched: bool) -> dict[str, Any]:
    """ScreenShare: `paused` — сокет ученика открыт, но преподаватель сейчас не смотрит."""
    if share.publisher is None:
        state = "requested"
    else:
        state = "sharing" if watched else "paused"
    return {
        "session_id": str(share.session_id),
        "user_id": str(share.user_id),
        "state": state,
        "requested_at": share.requested_at.isoformat(),
    }


def stopped(session_id: UUID, user_id: UUID) -> dict[str, Any]:
    return {
        "session_id": str(session_id),
        "user_id": str(user_id),
        "state": "stopped",
        "requested_at": None,
    }


async def _close(socket: WebSocket, code: int) -> None:
    try:
        await socket.close(code=code)
    except (RuntimeError, WebSocketDisconnect):
        # Сокет уже закрыт другой стороной — закрывать нечего.
        pass


class ScreenHub:
    def __init__(self, realtime: "RealtimeHub") -> None:
        self.realtime = realtime
        self.shares: dict[tuple[UUID, UUID], Share] = {}
        self.viewers: list[Viewer] = []
        # Сколько кадров отброшено лимитами — только число, для тестов и замера нагрузки.
        self.dropped = 0
        # session_id → (когда проверено, идёт ли): не ходить в БД на каждый кадр.
        self.running: dict[UUID, tuple[float, bool]] = {}
        # Идущая проверка статуса занятия: кэш истёк у всех сопрограмм занятия разом
        # (ученики, преподаватель) — в БД идёт один запрос, остальные ждут его.
        self.checks: dict[UUID, asyncio.Task[bool]] = {}
        self.swept_at = float("-inf")

    def session_shares(self, session_id: UUID) -> list[Share]:
        return [share for share in self.shares.values() if share.session_id == session_id]

    def watched(self, session_id: UUID) -> bool:
        return any(viewer.session_id == session_id for viewer in self.viewers)

    def view(self, share: Share) -> dict[str, Any]:
        return view(share, self.watched(share.session_id))

    async def _announce(self, share: Share, payload: dict[str, Any] | None = None) -> None:
        await self.realtime.send_to(
            {share.teacher_id, share.user_id}, "screen.state", payload or self.view(share)
        )

    async def _announce_live(self, session_id: UUID) -> None:
        """Получатели появились или ушли: sharing ↔ paused у всех открытых показов занятия."""
        for share in self.session_shares(session_id):
            if share.publisher is not None:
                await self._announce(share)

    async def still_running(self, session_id: UUID, now: float | None = None) -> bool:
        """Идёт ли занятие; ответ БД кэшируется на RUNNING_CHECK_S. Сбой БД — «идёт»:
        показ гасит конец занятия, а не случайная ошибка соединения."""
        now = time.monotonic() if now is None else now
        cached = self.running.get(session_id)
        if cached is not None and now - cached[0] < RUNNING_CHECK_S:
            return cached[1]
        task = self.checks.get(session_id)
        if task is None:
            task = asyncio.create_task(self._check_running(session_id, now))
            self.checks[session_id] = task
        # shield: отмена одного ждущего (ученик ушёл) не отменяет проверку для остальных.
        return await asyncio.shield(task)

    async def _check_running(self, session_id: UUID, now: float) -> bool:
        try:
            async with self.realtime.app.state.database.sessions() as db:
                lesson = await session_repo.get_session(db, session_id)
        except (SQLAlchemyError, OSError, TimeoutError):
            return True
        finally:
            self.checks.pop(session_id, None)
        alive = lesson is not None and lesson.status == "running"
        self.running[session_id] = (now, alive)
        return alive

    def _attended(self, session_id: UUID) -> bool:
        """Есть открытый сокет показа или просмотра — его цикл сам проверяет занятие."""
        return self.watched(session_id) or any(
            share.publisher is not None for share in self.session_shares(session_id)
        )

    async def sweep(self, now: float | None = None) -> None:
        """Дешёвая чистка после потерянного NOTIFY: показы в `requested` без сокетов никто не
        проверяет, и записи кэша статуса остаются навсегда. Не чаще раза в RUNNING_CHECK_S;
        в БД — только занятия с такими показами, и то через кэш still_running."""
        now = time.monotonic() if now is None else now
        if now - self.swept_at < RUNNING_CHECK_S:
            return
        self.swept_at = now
        for session_id in {share.session_id for share in self.shares.values()}:
            if not self._attended(session_id) and not await self.still_running(session_id, now):
                await self.end_session(session_id)
        live = {share.session_id for share in self.shares.values()}
        live.update(viewer.session_id for viewer in self.viewers)
        for session_id, (checked_at, _) in list(self.running.items()):
            if session_id not in live and now - checked_at >= RUNNING_CHECK_S:
                del self.running[session_id]

    async def _ensure_running(self, session_id: UUID) -> bool:
        if await self.still_running(session_id):
            return True
        await self.end_session(session_id)
        return False

    async def request(self, session_id: UUID, teacher_id: UUID, user_id: UUID) -> Share:
        await self.sweep()
        share = self.shares.get((session_id, user_id))
        if share is not None:
            return share
        if len(self.session_shares(session_id)) >= MAX_SHARES_PER_SESSION:
            raise HTTPException(
                409, f"Одновременно можно смотреть не больше {MAX_SHARES_PER_SESSION} экранов."
            )
        share = Share(session_id, teacher_id, user_id, datetime.now(UTC))
        self.shares[(session_id, user_id)] = share
        await self._announce(share)
        return share

    async def stop(self, session_id: UUID, user_id: UUID) -> dict[str, Any]:
        share = self.shares.pop((session_id, user_id), None)
        payload = stopped(session_id, user_id)
        if share is None:
            return payload
        publisher, share.publisher, share.frame = share.publisher, None, None
        if publisher is not None:
            await _close(publisher, 1000)
        await self._announce(share, payload)
        return payload

    async def end_session(self, session_id: UUID) -> None:
        self.running[session_id] = (time.monotonic(), False)
        for share in self.session_shares(session_id):
            await self.stop(session_id, share.user_id)
        for viewer in [item for item in self.viewers if item.session_id == session_id]:
            await _close(viewer.socket, CLOSE_FINISHED)

    def accept_frame(
        self, share: Share, data: bytes, now: float | None = None, keep: bool = True
    ) -> bool:
        """Принять кадр как последний; лишний по частоте, размеру или формату — отбросить.

        `keep=False` — пауза (преподаватель не смотрит): кадр мог быть уже в пути, когда пришла
        пауза, поэтому не хранится и не пересылается, но лимиты те же — иначе клиент на паузе
        мог бы слать без ограничения частоты и никогда не получил бы 4400."""
        now = time.monotonic() if now is None else now
        if (
            len(data) > MAX_FRAME_BYTES
            or not data.startswith(JPEG_MAGIC)
            or now - share.accepted_at < MIN_FRAME_INTERVAL_S
        ):
            self.dropped += 1
            share.drops_in_row += 1
            return False
        share.accepted_at, share.drops_in_row = now, 0
        if not keep:
            return True
        share.frame = data
        share.seq += 1
        for viewer in self.viewers:
            if viewer.session_id == share.session_id:
                viewer.wake.set()
        return True

    async def connect(self, socket: WebSocket) -> None:
        user = await self.realtime.authenticate(socket)
        if user is None:
            return
        try:
            session_id = UUID(socket.query_params.get("session_id", ""))
        except ValueError:
            await socket.close(code=CLOSE_BAD_MESSAGE)
            return
        try:
            async with self.realtime.app.state.database.sessions() as db:
                lesson = await session_repo.get_session(db, session_id)
        except (SQLAlchemyError, OSError, TimeoutError):
            await socket.close(code=1012)
            return
        if lesson is None or lesson.status != "running" or lesson.kind != "lesson":
            await socket.close(code=CLOSE_NOT_FOUND)
            return
        self.running[session_id] = (time.monotonic(), True)
        await self.sweep()
        if user.role == "teacher" and lesson.teacher_id == user.id:
            await self._serve_viewer(socket, session_id)
            return
        share = self.shares.get((session_id, user.id))
        if user.role != "trainee" or not any(p.user_id == user.id for p in lesson.participants):
            await socket.close(code=CLOSE_FORBIDDEN)
        elif share is None:
            # Без запроса преподавателя трансляция не начинается (HQ-017).
            await socket.close(code=CLOSE_NOT_FOUND)
        else:
            await self._serve_publisher(socket, share)

    async def _serve_publisher(self, socket: WebSocket, share: Share) -> None:
        await socket.accept()
        previous, share.publisher = share.publisher, socket
        if previous is not None:
            await _close(previous, CLOSE_REPLACED)
        await self._announce(share)
        try:
            while True:
                try:
                    # Ученик на паузе молчит — просыпаемся сами, чтобы проверить занятие.
                    async with asyncio.timeout(RUNNING_CHECK_S):
                        message = await socket.receive()
                except TimeoutError:
                    message = None
                if not await self._ensure_running(share.session_id):
                    break
                if message is None:
                    continue
                if message["type"] == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data is None:
                    await _close(socket, CLOSE_BAD_MESSAGE)
                    break
                keep = self.watched(share.session_id)
                if (
                    not self.accept_frame(share, data, keep=keep)
                    and share.drops_in_row >= MAX_DROPS_IN_ROW
                ):
                    await _close(socket, CLOSE_BAD_MESSAGE)
                    break
        except (RuntimeError, WebSocketDisconnect):
            pass
        finally:
            # Обрыв без «Остановить показ» — снова запрос: после перезагрузки ученик его увидит.
            if share.publisher is socket:
                share.publisher, share.frame, share.drops_in_row = None, None, 0
                if self.shares.get((share.session_id, share.user_id)) is share:
                    await self._announce(share)

    async def _serve_viewer(self, socket: WebSocket, session_id: UUID) -> None:
        await socket.accept()
        viewer = Viewer(socket, session_id)
        first = not self.watched(session_id)
        self.viewers.append(viewer)
        viewer.wake.set()
        if first:
            await self._announce_live(session_id)
        pump = asyncio.create_task(self._pump(viewer))
        try:
            while True:
                message = await socket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                # Преподаватель только смотрит: любое сообщение от него — ошибка протокола.
                await _close(socket, CLOSE_BAD_MESSAGE)
                break
        except (RuntimeError, WebSocketDisconnect):
            pass
        finally:
            # Обработчик могут отменить сразу после disconnect (остановка сервера; TestClient
            # отменяет задачу приложения, закрыв сокет): уборка — до первого await, а
            # «пауза» ученику и преподавателю — под shield, иначе отмена её теряла и показ
            # оставался «sharing» без получателя.
            pump.cancel()
            self.viewers.remove(viewer)
            if not self.watched(session_id):
                # Смотреть некому: последний кадр не храним, ученик видит паузу.
                for share in self.session_shares(session_id):
                    share.frame = None
                await asyncio.shield(self._announce_live(session_id))
            await asyncio.gather(pump, return_exceptions=True)

    async def _pump(self, viewer: Viewer) -> None:
        """Слать получателю свежие кадры; пока он принимает один, остальные перезаписываются."""
        try:
            while True:
                try:
                    async with asyncio.timeout(RUNNING_CHECK_S):
                        await viewer.wake.wait()
                except TimeoutError:
                    pass
                viewer.wake.clear()
                if not await self._ensure_running(viewer.session_id):
                    return
                for share in self.session_shares(viewer.session_id):
                    frame, seq = share.frame, share.seq
                    if frame is None or viewer.sent.get(share.user_id) == seq:
                        continue
                    async with asyncio.timeout(SEND_TIMEOUT_S):
                        await viewer.socket.send_bytes(share.user_id.bytes + frame)
                    viewer.sent[share.user_id] = seq
        except (RuntimeError, WebSocketDisconnect, TimeoutError, OSError):
            await _close(viewer.socket, 1011)
