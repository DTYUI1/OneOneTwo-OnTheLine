"""Настоящий ASGI WebSocket: медленный send не оставляет живой сокет вне рассылки."""

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest
from app.api import realtime
from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from .test_realtime import until


class Transport:
    def __init__(self, *, slow=None, slow_close=False):
        self.incoming = asyncio.Queue()
        self.incoming.put_nowait({"type": "websocket.connect"})
        self.messages = []
        self.slow = slow
        self.slow_close = slow_close
        self.blocked = asyncio.Event()
        self.release = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.socket = WebSocket({"type": "websocket", "headers": []}, self.incoming.get, self.send)

    async def send(self, message):
        event = json.loads(message["text"]) if "text" in message else None
        if (event and event["type"] == self.slow) or (
            message["type"] == "websocket.close" and self.slow_close
        ):
            self.blocked.set()
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled.set()
                raise
        self.messages.append(message)

    def ping(self):
        self.incoming.put_nowait(
            {
                "type": "websocket.receive",
                "text": json.dumps(
                    {"type": "clock.ping", "client_ts": datetime.now(UTC).isoformat()}
                ),
            }
        )

    def events(self):
        return [json.loads(m["text"]) for m in self.messages if "text" in m]


def make_authenticated_hub(monkeypatch):
    user = SimpleNamespace(id=uuid4(), role="trainee")
    state = SimpleNamespace(allowed=True, authentications=0, revision=1)

    @asynccontextmanager
    async def sessions():
        yield None

    async def authenticate(*args):
        state.authentications += 1
        return (None, user) if state.allowed else None

    async def snapshot(client):
        return {"revision": state.revision}

    monkeypatch.setattr(realtime, "IO_TIMEOUT_S", 0.05)
    monkeypatch.setattr(realtime, "read_token", lambda *args: (uuid4(), user.id))
    monkeypatch.setattr(realtime.auth_repo, "authenticate", authenticate)
    hub = realtime.RealtimeHub(
        SimpleNamespace(
            state=SimpleNamespace(config=None, database=SimpleNamespace(sessions=sessions))
        )
    )
    monkeypatch.setattr(hub, "snapshot", snapshot)
    return hub, state


@pytest.mark.parametrize("slow", ["snapshot", "clock.pong", "presence"])
def test_slow_send_closes_handler_and_reconnects_with_fresh_authorization(monkeypatch, slow):
    async def check():
        hub, state = make_authenticated_hub(monkeypatch)
        transport = Transport(slow=slow)
        handler = asyncio.create_task(hub.connect(transport.socket))
        transport.ping()
        await asyncio.wait_for(transport.blocked.wait(), 0.5)
        client = hub.clients[transport.socket]
        try:
            await asyncio.wait_for(hub._close_clients(), 0.3)
            transport.release.set()
            await asyncio.sleep(0)
            assert {"type": "websocket.close", "code": 1012, "reason": ""} in transport.messages
            await asyncio.wait_for(handler, 0.3)
            assert transport.socket.application_state == WebSocketState.DISCONNECTED
            assert transport.cancelled.is_set()
            with pytest.raises(WebSocketDisconnect):
                await hub.send(client, "clock.pong", {})
            assert not hub.clients and not hub.offsets

            state.revision = 2
            fresh = Transport()
            reconnected = asyncio.create_task(hub.connect(fresh.socket))
            await until(lambda: len(fresh.events()) >= 2)
            assert fresh.events()[0]["payload"] == {"revision": 2}
            await hub.broadcast_presence(client.user_id, True)
            assert fresh.events()[-1]["type"] == "presence"
            state.allowed = False
            await hub._close_clients()
            await asyncio.wait_for(reconnected, 0.3)
            denied = Transport()
            await hub.connect(denied.socket)
            assert denied.messages == [{"type": "websocket.close", "code": 4401, "reason": ""}]
            assert state.authentications == 3
            assert not hub.clients and not hub.tasks
        finally:
            transport.release.set()
            handler.cancel()
            await asyncio.gather(handler, return_exceptions=True)
            await hub.stop()
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]

    asyncio.run(check())


def test_stalled_close_does_not_hold_other_clients_or_leave_receive_tasks(monkeypatch):
    async def check():
        hub, _ = make_authenticated_hub(monkeypatch)
        stalled, healthy = Transport(slow_close=True), Transport()
        handlers = [asyncio.create_task(hub.connect(t.socket)) for t in (stalled, healthy)]
        await until(lambda: all(t.events() for t in (stalled, healthy)))
        await asyncio.wait_for(hub.stop(), 0.3)
        await asyncio.wait_for(asyncio.gather(*handlers), 0.3)
        assert stalled.cancelled.is_set()
        assert healthy.messages[-1]["type"] == "websocket.close"
        assert not hub.clients and not hub.tasks
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]

    asyncio.run(check())


def test_slow_broadcast_is_bounded_and_other_clients_receive_immediately(monkeypatch):
    async def check():
        hub, _ = make_authenticated_hub(monkeypatch)
        slow, healthy = Transport(), Transport()
        handlers = [asyncio.create_task(hub.connect(t.socket)) for t in (slow, healthy)]
        await until(lambda: all(len(t.events()) >= 2 for t in (slow, healthy)))
        slow.slow = "presence"
        before = len(healthy.events())
        broadcast = asyncio.create_task(hub.broadcast_presence(uuid4(), True))
        await slow.blocked.wait()
        await until(lambda: len(healthy.events()) > before, timeout=0.03)
        assert not broadcast.done()
        await asyncio.wait_for(broadcast, 0.3)
        await asyncio.wait_for(handlers[0], 0.3)
        assert slow.cancelled.is_set()
        assert slow.messages[-1]["type"] == "websocket.close"
        healthy.ping()
        await until(lambda: healthy.events()[-1]["type"] == "clock.pong")
        await hub.stop()
        await asyncio.wait_for(handlers[1], 0.3)
        assert not [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]

    asyncio.run(check())
