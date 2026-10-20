"""Модели ИИ (HQ-016): по умолчанию Qwen на процессоре, видеокарта — только рабочая."""

import asyncio
import json

import pytest
from app.api.ai_models import service
from app.api.database import create_database_app
from app.core.models import AuditLog, Setting
from app.worker.runtime import Worker
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from .test_lifecycle import login, run_db

QWEN = service.catalog()["models"][0]
READY = {
    "state": "ready",
    "backend": "vulkan",
    "device": "Vulkan1",
    "name": "NVIDIA GeForce RTX 3050 Laptop GPU (NVK GA107)",
    "vram_mb": 4096,
    "llm_gpu": True,
}


@pytest.fixture
def models_dir(tmp_path):
    # Размер — как у настоящей модели, без 2,5 ГБ на диске: разреженный файл.
    with (tmp_path / QWEN["file"]).open("wb") as file:
        file.truncate(QWEN["size_bytes"])
    return tmp_path


@pytest.fixture(autouse=True)
def clean_choice(database_url):
    async def clean(db):
        await db.execute(
            delete(Setting).where(Setting.key.in_([service.SETTING_KEY, service.NOTICE_KEY]))
        )

    run_db(database_url, clean)
    yield
    run_db(database_url, clean)


def app_for(database_config, models_dir, hardware=None):
    config = database_config.model_copy(
        update={
            "ai_provider": "local",
            "llm_models_dir": models_dir,
            "ai_hardware": json.dumps(hardware) if hardware else "",
            # Сервера модели в тестах нет: роутер «не отвечает», выбор всё равно работает.
            "llm_base_url": "http://127.0.0.1:9/v1",
        }
    )
    return TestClient(create_database_app(config))


def modes(data, model_id):
    model = next(item for item in data["models"] if item["id"] == model_id)
    return {mode["mode"]: mode for mode in model["modes"]}


def test_default_is_qwen_on_cpu_and_card_without_driver_is_not_offered(database_config, models_dir):
    hardware = {"state": "no_driver", "name": "GeForce RTX 3050 Mobile", "vram_mb": None}
    with app_for(database_config, models_dir, hardware) as client:
        login(client, "admin")
        data = client.get("/api/admin/ai-models").json()
    assert data["active"] == {
        "model": "qwen3-4b",
        "mode": "cpu",
        "status": "unknown",
        "fallback": False,
    }
    assert data["router"] is False and data["gpu_suggestion"] is False
    qwen = modes(data, "qwen3-4b")
    assert qwen["cpu"]["available"] and not qwen["gpu"]["available"]
    # Без доступа сервера модели к карте «всё равно» не сработает: подсказка — --gpu force.
    assert "драйвера" in qwen["gpu"]["reason"] and "--gpu force" in qwen["gpu"]["reason"]
    assert qwen["gpu"]["can_force"] is False
    gemma = modes(data, "gemma4-26b-a4b")
    # Файла Gemma нет — ни один режим не выбрать, причина — установка.
    assert not gemma["cpu"]["available"] and gemma["cpu"]["reason"] == "Файл модели не установлен."


def test_working_gpu_is_suggested_and_choice_is_saved_audited_and_used_by_worker(
    database_config, database_url, models_dir
):
    with app_for(database_config, models_dir, READY) as client:
        headers = login(client, "admin")
        data = client.get("/api/admin/ai-models").json()
        assert data["gpu_suggestion"] is True and modes(data, "qwen3-4b")["gpu"]["available"]
        chosen = client.put(
            "/api/admin/ai-models/active",
            headers=headers,
            json={"model": "qwen3-4b", "mode": "gpu"},
        )
        assert chosen.status_code == 200, chosen.text
        assert chosen.json()["active"]["mode"] == "gpu"
        assert chosen.json()["gpu_suggestion"] is False

    async def saved(db):
        row = await db.get(Setting, service.SETTING_KEY)
        audit = await db.scalar(
            select(AuditLog)
            .where(AuditLog.action == "setActiveAIModel")
            .order_by(AuditLog.ts.desc())
            .limit(1)
        )
        return row.value, audit.after

    value, after = run_db(database_url, saved)
    assert value == {"model": "qwen3-4b", "mode": "gpu"} and after == value

    async def worker_model():
        worker = Worker(database_config.model_copy(update={"ai_provider": "local"}))
        try:
            async with worker.database.sessions() as db:
                await worker.handlers.use_active_model(db)
            return worker.handlers.llm.model, worker.handlers.judge.name
        finally:
            await worker.close()

    # Оценка и генерация пишут фактическую модель, а не настройку по умолчанию.
    assert asyncio.run(worker_model()) == ("qwen3-4b-gpu", "local:qwen3-4b-gpu")


@pytest.mark.parametrize(
    ("hardware", "reason"),
    [
        (None, "не проверяли"),
        ({"state": "none"}, "не найдена"),
        ({"state": "no_image", "name": "RTX 3060"}, "Нет образа"),
        ({**READY, "llm_gpu": False}, "перезапустите стенд"),
        ({**READY, "vram_mb": 2048}, "видеопамяти"),
        ({"state": "no_driver", "llm_gpu": True, "forced": True}, "не подтвердила"),
    ],
)
def test_unavailable_gpu_cannot_be_chosen(database_config, models_dir, hardware, reason):
    with app_for(database_config, models_dir, hardware) as client:
        headers = login(client, "admin")
        refused = client.put(
            "/api/admin/ai-models/active",
            headers=headers,
            json={"model": "qwen3-4b", "mode": "gpu"},
        )
        assert refused.status_code == 409 and reason in refused.text
        assert client.get("/api/admin/ai-models").json()["active"]["mode"] == "cpu"


def test_missing_file_unknown_model_and_teacher_are_refused(database_config, models_dir):
    with app_for(database_config, models_dir, READY) as client:
        headers = login(client, "admin")
        missing = client.put(
            "/api/admin/ai-models/active",
            headers=headers,
            json={"model": "gemma4-26b-a4b", "mode": "cpu"},
        )
        assert missing.status_code == 409 and "не установлен" in missing.text
        unknown = client.put(
            "/api/admin/ai-models/active", headers=headers, json={"model": "gpt", "mode": "cpu"}
        )
        assert unknown.status_code == 422
    with app_for(database_config, models_dir, READY) as client:
        headers = login(client, "teacher")
        assert client.get("/api/admin/ai-models").status_code == 403
        assert (
            client.put(
                "/api/admin/ai-models/active",
                headers=headers,
                json={"model": "qwen3-4b", "mode": "cpu"},
            ).status_code
            == 403
        )


def test_partial_copy_is_not_installed(tmp_path):
    (tmp_path / QWEN["file"]).write_bytes(b"GGUF")
    assert not service.installed(tmp_path, QWEN)


def test_low_memory_blocks_big_model_on_cpu():
    gemma = service.catalog()["models"][1]
    box = {"memory_total_bytes": 16 * 1024**3, "gpu": {"state": "none"}, "llm_gpu": False}
    assert "оперативной памяти" in service.mode_check(gemma, "cpu", True, box)[0]
    assert service.mode_check(QWEN, "cpu", True, box) == (None, False)


def test_presets_cover_every_catalog_mode():
    presets = (service.ROOT / "deploy/llm/models.ini").read_text(encoding="utf-8")
    for model in service.catalog()["models"]:
        for mode in ("cpu", "gpu"):
            section = f"[{model['id']}-{mode}]"
            assert section in presets
            body = presets.split(section, 1)[1].split("\n[", 1)[0]
            assert f"model = /models/{model['file']}" in body
            assert ("n-gpu-layers = 0" in body) == (mode == "cpu")


@pytest.mark.parametrize(
    "hardware",
    [{**READY, "vram_mb": 2048}, {"state": "no_driver", "llm_gpu": True, "forced": True}],
)
def test_force_uses_gpu_only_when_model_server_has_access(database_config, models_dir, hardware):
    # «Всё равно использовать видеокарту»: проверка не подтвердила или мало видеопамяти,
    # но доступ у сервера модели есть — администратор решает сам.
    with app_for(database_config, models_dir, hardware) as client:
        headers = login(client, "admin")
        gpu = modes(client.get("/api/admin/ai-models").json(), "qwen3-4b")["gpu"]
        assert not gpu["available"] and gpu["can_force"]
        forced = client.put(
            "/api/admin/ai-models/active",
            headers=headers,
            json={"model": "qwen3-4b", "mode": "gpu", "force": True},
        )
        assert forced.status_code == 200, forced.text
        assert forced.json()["active"]["mode"] == "gpu"
    without = {"state": "no_driver", "llm_gpu": False}
    with app_for(database_config, models_dir, without) as client:
        headers = login(client, "admin")
        refused = client.put(
            "/api/admin/ai-models/active",
            headers=headers,
            json={"model": "qwen3-4b", "mode": "gpu", "force": True},
        )
        assert refused.status_code == 409 and "--gpu force" in refused.text


def test_failed_gpu_load_falls_back_to_cpu(database_config, database_url, models_dir, monkeypatch):
    async def choose_gpu(db):
        db.add(Setting(key=service.SETTING_KEY, value={"model": "qwen3-4b", "mode": "gpu"}))

    run_db(database_url, choose_gpu)

    async def failed(base_url):
        return {"qwen3-4b-gpu": "failed", "qwen3-4b-cpu": "unloaded"}

    monkeypatch.setattr(service, "router_statuses", failed)
    with app_for(database_config, models_dir, READY) as client:
        login(client, "admin")
        active = client.get("/api/admin/ai-models").json()["active"]
    assert active == {"model": "qwen3-4b", "mode": "gpu", "status": "failed", "fallback": True}

    async def worker_model():
        worker = Worker(database_config.model_copy(update={"ai_provider": "local"}))
        try:
            async with worker.database.sessions() as db:
                await worker.handlers.use_active_model(db)
            return worker.handlers.llm.model
        finally:
            await worker.close()

    # Видеокарта не загрузила модель — работа идёт на процессоре, занятие не ломается.
    assert asyncio.run(worker_model()) == "qwen3-4b-cpu"


def test_dismissed_notice_stops_gpu_suggestion_for_everyone(database_config, models_dir):
    with app_for(database_config, models_dir, READY) as client:
        headers = login(client, "admin")
        assert client.get("/api/admin/ai-models").json()["gpu_suggestion"] is True
        quiet = client.put(
            "/api/admin/ai-models/gpu-notice", headers=headers, json={"dismissed": True}
        ).json()
        assert quiet["notice_dismissed"] is True and quiet["gpu_suggestion"] is False
        # Видеокарту по-прежнему можно выбрать вручную — пропадает только напоминание.
        assert modes(quiet, "qwen3-4b")["gpu"]["available"] is True
    with app_for(database_config, models_dir, READY) as client:
        headers = login(client, "admin")
        assert client.get("/api/admin/ai-models").json()["gpu_suggestion"] is False
        again = client.put(
            "/api/admin/ai-models/gpu-notice", headers=headers, json={"dismissed": False}
        ).json()
        assert again["gpu_suggestion"] is True


def test_local_timings_use_only_last_day_local_attempts(database_url):
    from datetime import UTC, datetime, timedelta

    from app.core.models import Scenario
    from sqlalchemy import update

    async def measure(db):
        try:
            await db.execute(update(Scenario).values(generation_metadata=None))
            assert await service.local_generation(db) == {
                "period_hours": 24,
                "attempts": 0,
                "mean_seconds": None,
            }
            rows = list((await db.scalars(select(Scenario).limit(3))).all())
            now = datetime.now(UTC)
            for row in rows:
                row.created_at = now
                row.generation_metadata = {
                    "model": "local:qwen3-4b-gpu",
                    "attempts": [{"duration_seconds": 10}, {"duration_seconds": 20}],
                }
            rows[1].created_at = now - timedelta(hours=25)
            rows[2].generation_metadata = {
                "model": "mock",
                "attempts": [{"duration_seconds": 999}],
            }
            await db.flush()
            assert await service.local_generation(db) == {
                "period_hours": 24,
                "attempts": 2,
                "mean_seconds": 15,
            }
        finally:
            await db.rollback()

    run_db(database_url, measure)
