import asyncio
import os
import subprocess
import sys

import pytest
import yaml
from app.core.config import ROOT
from app.worker import healthcheck


def test_connection_closes_on_its_original_running_loop(monkeypatch):
    calls = []

    async def connect(url, *, timeout):
        loop = asyncio.get_running_loop()
        calls.append(("connect", url, timeout))

        class Connection:
            async def close(self, *, timeout):
                assert asyncio.get_running_loop() is loop
                assert not loop.is_closed()
                calls.append(("close", timeout))

        return Connection()

    monkeypatch.setattr(healthcheck.asyncpg, "connect", connect)
    monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://test:password@db/test")
    # Docker invokes the probe repeatedly; no closed loop or connection is reused.
    for _ in range(2):
        assert healthcheck.main() == 0
    assert (
        calls
        == [
            ("connect", "postgresql://test:password@db/test", 3),
            ("close", 1),
        ]
        * 2
    )


@pytest.mark.parametrize("error", [ConnectionRefusedError, TimeoutError])
def test_unavailable_database_fails_without_logging_credentials(monkeypatch, capsys, error):
    secret_url = "postgresql://test:do-not-log-password@db/test"

    async def connect(url, *, timeout):
        raise error(secret_url)

    monkeypatch.setattr(healthcheck.asyncpg, "connect", connect)
    monkeypatch.setenv("DATABASE_URL", secret_url)
    assert healthcheck.main() == 1
    captured = capsys.readouterr()
    assert error.__name__ in captured.err
    assert "do-not-log-password" not in captured.err + captured.out


def test_close_timeout_fails_probe(monkeypatch):
    class Connection:
        async def close(self, *, timeout):
            raise TimeoutError

    async def connect(url, *, timeout):
        return Connection()

    monkeypatch.setattr(healthcheck.asyncpg, "connect", connect)
    monkeypatch.setenv("DATABASE_URL", "postgresql://db/test")
    assert healthcheck.main() == 1


def test_missing_database_url_fails_probe(monkeypatch, capsys):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert healthcheck.main() == 1
    assert "KeyError" in capsys.readouterr().err


def test_actual_compose_command_with_postgresql(database_url):
    compose = yaml.safe_load((ROOT / "deploy/docker-compose.yml").read_text(encoding="utf-8"))
    command = compose["services"]["worker"]["healthcheck"]["test"]
    assert command == ["CMD", "python", "-m", "app.worker.healthcheck"]
    result = subprocess.run(
        [sys.executable, *command[2:]],
        cwd=ROOT,
        env={**os.environ, "DATABASE_URL": database_url},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stderr == ""
