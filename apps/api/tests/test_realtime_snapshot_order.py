"""Первым сообщением WS всегда идёт snapshot, даже если NOTIFY пришёл во время его чтения."""

from app.api.realtime import RealtimeHub

from .test_lifecycle import login


def test_event_during_snapshot_read_follows_snapshot(database_client, monkeypatch):
    original = RealtimeHub.snapshot

    async def racing_snapshot(self, client):
        # Воспроизводим гонку CI: уведомление доставляется, пока snapshot читается из БД.
        await self._send_or_close(
            client, "presence", {"user_id": str(client.user_id), "online": True}
        )
        return await original(self, client)

    monkeypatch.setattr(RealtimeHub, "snapshot", racing_snapshot)
    login(database_client, "trainee01")
    with database_client.websocket_connect("/ws", headers={"origin": "http://testserver"}) as ws:
        assert ws.receive_json()["type"] == "snapshot"
        assert ws.receive_json()["type"] == "presence"
