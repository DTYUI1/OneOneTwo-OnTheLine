"""Локальные неизменяемые версии аудио, доступные только через выданное сообщение."""

import asyncio
import hashlib
from pathlib import Path
from uuid import UUID

from fastapi import HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.cards import repo
from app.core.models import MessageAudioAsset, MessageDelivery


def asset_path(directory: Path, relative_path: str) -> Path:
    root = directory.resolve()
    path = (root / relative_path).resolve()
    if Path(relative_path).is_absolute() or not path.is_relative_to(root):
        raise HTTPException(422, "Аудио должно находиться в локальном каталоге сообщений.")
    return path


async def register_asset(
    db: AsyncSession,
    directory: Path,
    *,
    asset_id: UUID,
    version: int,
    relative_path: str,
    duration_ms: int,
    media_type: str,
) -> MessageAudioAsset:
    """Импорт фиксирует digest файла; повтор не может подменить прежнюю версию."""
    if (
        version < 1
        or duration_ms < 0
        or media_type not in {"audio/wav", "audio/webm", "audio/ogg", "audio/mpeg"}
    ):
        raise HTTPException(422, "Неверная версия или формат аудио.")
    path = asset_path(directory, relative_path)
    try:
        content = await asyncio.to_thread(path.read_bytes)
    except OSError as exc:
        raise HTTPException(404, "Аудиофайл не найден.") from exc
    digest = hashlib.sha256(content).hexdigest()
    existing = await db.get(MessageAudioAsset, (asset_id, version))
    if existing is not None:
        if (existing.sha256, existing.duration_ms, existing.media_type, existing.relative_path) != (
            digest,
            duration_ms,
            media_type,
            relative_path,
        ):
            raise HTTPException(409, "Версия аудио уже зарегистрирована с другим содержимым.")
        return existing
    row = MessageAudioAsset(
        asset_id=asset_id,
        version=version,
        relative_path=relative_path,
        duration_ms=duration_ms,
        media_type=media_type,
        sha256=digest,
    )
    db.add(row)
    await db.flush()
    return row


async def download(request: Request, card_id: UUID, delivery_id: UUID, version: int) -> Response:
    db = request.state.db
    if await repo.card(db, card_id, request.state.user.id, request.state.user.role) is None:
        raise HTTPException(404, "Карточка не найдена.")
    delivery = await db.get(MessageDelivery, delivery_id)
    if delivery is None or delivery.card_id != card_id or delivery.message["audio"] is None:
        raise HTTPException(404, "Аудио выданного сообщения не найдено.")
    audio = delivery.message["audio"]
    if version != audio["version"]:
        raise HTTPException(409, "Запрошена другая версия аудио.")
    asset = await db.get(MessageAudioAsset, (UUID(audio["asset_id"]), version))
    if asset is None:
        raise HTTPException(404, "Аудио выданного сообщения не найдено.")
    path = asset_path(request.app.state.config.information_audio_dir, asset.relative_path)
    try:
        content = await asyncio.to_thread(path.read_bytes)
    except OSError as exc:
        raise HTTPException(404, "Аудио выданного сообщения недоступно.") from exc
    if hashlib.sha256(content).hexdigest() != audio["sha256"] or asset.sha256 != audio["sha256"]:
        raise HTTPException(409, "Содержимое аудио не соответствует выданной версии.")
    # Отдаём именно проверенные байты: замена файла после hash не подменит ответ.
    return Response(
        content,
        media_type=asset.media_type,
        headers={"Cache-Control": "private, no-store", "ETag": f'"{asset.sha256}"'},
    )
