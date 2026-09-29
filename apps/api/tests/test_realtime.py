"""Восстановление LISTEN, освобождение ресурсов и повторная синхронизация клиентов."""

import asyncio
from types import SimpleNamespace

import pytest
from app.api import realtime


class Connection:
    def __init__(self, *, subscribe_error=None, probe_error=None):
        self.closed = False
        self.subscribe_error = subscribe_error
        self.probe_error = probe_error
        self.subscriptions = 0
        self.terminations = set()

    async def add_listener(self, channel, callback):
        if self.subscribe_error:
            raise self.subscribe_error
        self.subscriptions += 1

    async def remove_listener(self, channel, callback):
        self.subscriptions -= 1

    def add_termination_listener(self, callback):
        self.terminations.add(callback)

    def remove_termination_listener(self, callback):
        self.terminations.discard(callback)

    def is_closed(self):
        return self.closed

    def terminate(self):
        self.closed = True
        for callback in list(self.terminations):
            callback(self)

    async def close(self, *, timeout=None):
        self.terminate()

    async def fetchval(self, query, *, timeout=None):
        if self.probe_error:
            raise self.probe_error
        return 1


async def until(predicate, timeout=1):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.005)


def make_hub(monkeypatch):
    for name, value in [
        ("RETRY_INITIAL_S", 0.01),
        ("RETRY_MAX_S", 0.02),
        ("PROBE_INTERVAL_S", 0.01),
        ("IO_TIMEOUT_S", 0.05),
    ]:
        monkeypatch.setattr(realtime, name, value, raising=False)
    return realtime.RealtimeHub(
        SimpleNamespace(
            state=SimpleNamespace(config=SimpleNamespace(database_url="postgresql://unused"))
        )
    )


def test_start_retries_listen_after_database_becomes_available(monkeypatch):
    async def check():
        hub = make_hub(monkeypatch)
        calls = 0
        connection = Connection()

        async def connect(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise OSError("Нет соединения")
            return connection

        monkeypatch.setattr(realtime.asyncpg, "connect", connect)
        await hub.start()
        try:
            await until(lambda: calls >= 2, timeout=0.2)
            await until(lambda: hub.listener is connection)
            assert connection.subscriptions == 1
        finally:
            await hub.stop()
        assert connection.is_closed()

    asyncio.run(check())


@pytest.mark.parametrize("failure", [OSError("offline"), TimeoutError("timeout")])
def test_failed_subscription_closes_partial_connection_and_retries(monkeypatch, failure):
    async def check():
        hub = make_hub(monkeypatch)
        broken = Connection(subscribe_error=failure)
        healthy = Connection()
        attempts = []

        async def connect(*args, **kwargs):
            connection = broken if not attempts else healthy
            attempts.append(connection)
            return connection

        monkeypatch.setattr(realtime.asyncpg, "connect", connect)
        await hub.start()
        try:
            await until(lambda: len(attempts) == 2)
            assert broken.is_closed()
            assert healthy.subscriptions == 1
            assert hub.healthy
        finally:
            await hub.stop()
        assert healthy.is_closed()

    asyncio.run(check())


@pytest.mark.parametrize("silent", [False, True])
def test_disconnect_recovers_once_and_resynchronizes_clients(monkeypatch, silent):
    async def check():
        hub = make_hub(monkeypatch)
        connections = []

        async def connect(*args, **kwargs):
            assert all(c.is_closed() for c in connections)
            connection = Connection()
            connections.append(connection)
            return connection

        monkeypatch.setattr(realtime.asyncpg, "connect", connect)
        await hub.start()
        await hub.start()
        try:
            await until(lambda: hub.healthy)
            closed = []

            class Socket:
                async def close(self, *, code):
                    closed.append(code)

            socket = Socket()
            hub.clients[socket] = realtime.Client(socket, "user", "trainee")
            if silent:
                connections[0].probe_error = OSError("Потеря транспорта без FIN")
            else:
                connections[0].terminate()
            await until(lambda: len(connections) == 2 and hub.healthy)
            assert closed == [1012]
            assert not hub.clients
            assert connections[1].subscriptions == 1
            await asyncio.sleep(0.04)
            assert len(connections) == 2
        finally:
            await hub.stop()
            await hub.stop()
        assert all(c.is_closed() for c in connections)
        assert not hub.healthy
        assert not hub.tasks

    asyncio.run(check())


def test_stop_cancels_connection_attempt_without_background_retry(monkeypatch):
    async def check():
        hub = make_hub(monkeypatch)
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def connect(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        monkeypatch.setattr(realtime.asyncpg, "connect", connect)
        await asyncio.wait_for(hub.start(), 0.1)
        await started.wait()
        await asyncio.wait_for(hub.stop(), 0.2)
        assert cancelled.is_set()
        assert hub.listener is None
        assert not hub.healthy
        assert hub.supervisor is None

    asyncio.run(check())


def test_failed_notification_read_requests_fresh_snapshot(monkeypatch):
    async def check():
        hub = make_hub(monkeypatch)
        connections = []
        closed = []

        async def connect(*args, **kwargs):
            connection = Connection()
            connections.append(connection)
            return connection

        async def dispatch(raw):
            raise OSError("БД недоступна при чтении уведомления")

        class Socket:
            async def close(self, *, code):
                closed.append(code)

        monkeypatch.setattr(realtime.asyncpg, "connect", connect)
        monkeypatch.setattr(hub, "_dispatch", dispatch)
        await hub.start()
        try:
            await until(lambda: hub.healthy)
            socket = Socket()
            hub.clients[socket] = realtime.Client(socket, "user", "trainee")
            hub._received(connections[0], 1, realtime.CHANNEL, "{}")
            await until(lambda: len(connections) == 2 and hub.healthy)
            assert connections[0].is_closed()
            assert closed == [1012]
            assert not hub.tasks
        finally:
            await hub.stop()

    asyncio.run(check())


def test_stop_terminates_connection_when_close_is_already_pending(monkeypatch):
    async def check():
        hub = make_hub(monkeypatch)
        closing = asyncio.Event()

        class SlowClose(Connection):
            async def close(self, *, timeout=None):
                closing.set()
                await asyncio.Event().wait()

        connection = SlowClose()

        async def connect(*args, **kwargs):
            return connection

        monkeypatch.setattr(realtime.asyncpg, "connect", connect)
        await hub.start()
        await until(lambda: hub.healthy)
        connection.probe_error = OSError("offline")
        await asyncio.wait_for(closing.wait(), 0.2)
        await asyncio.wait_for(hub.stop(), 0.2)
        assert connection.is_closed()
        assert hub.supervisor is None

    asyncio.run(check())


def test_stop_cancels_dispatch_and_bounds_slow_websocket_close(monkeypatch):
    async def check():
        hub = make_hub(monkeypatch)
        connection = Connection()

        async def connect(*args, **kwargs):
            return connection

        async def dispatch(raw):
            await asyncio.Event().wait()

        class Socket:
            async def close(self, *, code):
                await asyncio.Event().wait()

        monkeypatch.setattr(realtime.asyncpg, "connect", connect)
        monkeypatch.setattr(hub, "_dispatch", dispatch)
        await hub.start()
        await until(lambda: hub.healthy)
        socket = Socket()
        hub.clients[socket] = realtime.Client(socket, "user", "trainee")
        hub._received(connection, 1, "arm112_events", "{}")
        pending = list(hub.tasks)
        await asyncio.wait_for(hub.stop(), 0.2)
        assert all(task.cancelled() for task in pending)
        assert not hub.tasks and not hub.clients
        assert connection.is_closed()
        hub._received(connection, 1, "arm112_events", "{}")
        assert not hub.tasks

    asyncio.run(check())
