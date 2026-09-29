"""C-07: учебные материалы преподавателя (contracts/C01_INTERFACES.md, I-CONTENT).

Версии неизменяемы, назначение (reference/evaluation) — свойство версии. Evaluation видит
только владелец-преподаватель; ученику доступны лишь назначенные его занятиям версии
reference. Тип файла проверяется по содержимому, путь хранения клиент не задаёт.
"""

import csv
import hashlib
import io
import json
import os
import zipfile
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4
from xml.etree import ElementTree

from fastapi import HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.c01 import C01Input
from app.core.models import (
    Material,
    MaterialAssignmentReceipt,
    Participant,
    Session,
    SessionMaterial,
)

MAX_BYTES = 10 * 1024 * 1024
EXTENSIONS = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/json": ".json",
    "application/xml": ".xml",
    "text/csv": ".csv",
}


class MaterialView(C01Input):
    contract_name = "Material"


class MaterialMetadata(C01Input):
    contract_name = "MaterialMetadata"


class MaterialAssignmentInput(C01Input):
    contract_name = "MaterialAssignmentInput"


def view(row: Material) -> MaterialView:
    return MaterialView(
        {
            "id": str(row.id),
            "version": row.version,
            "title": row.title,
            "purpose": row.purpose,
            "media_type": row.media_type,
            "size_bytes": row.size_bytes,
            "sha256": row.sha256,
            "created_at": row.created_at.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
    )


def detect(content: bytes) -> str | None:
    """Фактический тип по содержимому; неизвестная/опасная структура — None."""
    if content.startswith(b"%PDF-"):
        return "application/pdf"
    if content.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                names = set(archive.namelist())
        except zipfile.BadZipFile:
            return None
        # DOCX — OOXML-архив с основным документом; макросы (.docm) не принимаются.
        if "word/document.xml" in names and "word/vbaProject.bin" not in names:
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        return None
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None
    if "\x00" in text:
        return None
    stripped = text.lstrip()
    if stripped.startswith("<"):
        # XML не исполняется: DOCTYPE/ENTITY отклоняются (XXE, «billion laughs»).
        if "<!DOCTYPE" in text.upper() or "<!ENTITY" in text.upper():
            return None
        try:
            ElementTree.fromstring(text)
        except ElementTree.ParseError:
            return None
        return "application/xml"
    if stripped.startswith(("{", "[")):
        try:
            json.loads(text)
        except json.JSONDecodeError:
            return None
        return "application/json"
    rows = list(csv.reader(io.StringIO(text)))
    return "text/csv" if rows and any(row for row in rows) else None


async def read_upload(file: UploadFile) -> bytes:
    chunks: list[bytes] = []
    total = 0
    try:
        while chunk := await file.read(1024 * 1024):
            total += len(chunk)
            if total > MAX_BYTES:
                raise HTTPException(413, "Файл превышает 10 МиБ.")
            chunks.append(chunk)
    finally:
        await file.close()
    if total == 0:
        raise HTTPException(422, "Файл пуст.")
    return b"".join(chunks)


def parse_metadata(raw: str) -> dict[str, Any]:
    try:
        return MaterialMetadata.model_validate(json.loads(raw)).root
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(422, "Метаданные материала не соответствуют контракту.") from exc


async def upload(request: Request, file: UploadFile, metadata: str) -> MaterialView:
    request.state.entity = "material"
    meta = parse_metadata(metadata)
    declared = (file.content_type or "").split(";", 1)[0].strip().lower()
    content = await read_upload(file)
    actual = detect(content)
    if declared not in EXTENSIONS or actual != declared:
        raise HTTPException(415, "Поддерживаются PDF, DOCX, JSON, XML и CSV; тип не совпал.")
    db: AsyncSession = request.state.db
    teacher = request.state.user.id
    previous_id, previous_version = meta["previous_id"], meta["previous_version"]
    if (previous_id is None) != (previous_version is None):
        raise HTTPException(422, "previous_id и previous_version задаются вместе.")
    if previous_id is None:
        material_id, version = uuid4(), 1
    else:
        material_id = UUID(previous_id)
        await db.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended(f"material:{material_id}", 0)))
        )
        current = await db.scalar(
            select(func.max(Material.version)).where(
                Material.id == material_id, Material.owner_id == teacher
            )
        )
        if current is None:
            raise HTTPException(404, "Материал не найден.")
        if current != previous_version:
            raise HTTPException(409, "Материал уже изменён: обновите каталог.")
        version = current + 1
    directory: Path = request.app.state.config.materials_dir
    directory.mkdir(parents=True, exist_ok=True)
    relative = f"{material_id}-v{version}{EXTENSIONS[actual]}"
    temporary = directory / f".{relative}.upload"
    temporary.write_bytes(content)
    os.replace(temporary, directory / relative)
    row = Material(
        id=material_id,
        version=version,
        owner_id=teacher,
        title=meta["title"],
        purpose=meta["purpose"],
        media_type=actual,
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        relative_path=relative,
    )
    db.add(row)
    await db.flush()
    await db.refresh(row, attribute_names=["created_at"])
    request.state.entity_id = f"{material_id}:{version}"
    request.state.audit_after = {"id": str(material_id), "version": version, "purpose": row.purpose}
    return view(row)


async def visible_to_trainee(db: AsyncSession, user_id: UUID):  # type: ignore[no-untyped-def]
    """Версии reference, назначенные занятиям, где пользователь участник."""
    return (
        select(Material)
        .join(
            SessionMaterial,
            (SessionMaterial.material_id == Material.id)
            & (SessionMaterial.version == Material.version),
        )
        .join(Participant, Participant.session_id == SessionMaterial.session_id)
        .where(Participant.user_id == user_id, Material.purpose == "reference")
        .distinct()
    )


async def list_materials(request: Request) -> list[MaterialView]:
    db: AsyncSession = request.state.db
    user = request.state.user
    if user.role == "teacher":
        query = select(Material).where(Material.owner_id == user.id)
    else:
        query = await visible_to_trainee(db, user.id)
    rows = (await db.scalars(query.order_by(Material.title, Material.id, Material.version))).all()
    return [view(row) for row in rows]


async def find_readable(request: Request, material_id: UUID, version: int) -> Material:
    db: AsyncSession = request.state.db
    user = request.state.user
    if user.role == "teacher":
        row = await db.scalar(
            select(Material).where(
                Material.id == material_id,
                Material.version == version,
                Material.owner_id == user.id,
            )
        )
    else:
        query = await visible_to_trainee(db, user.id)
        row = await db.scalar(query.where(Material.id == material_id, Material.version == version))
    if row is None:
        raise HTTPException(404, "Материал не найден.")
    return row


async def download(request: Request, material_id: UUID, version: int) -> FileResponse:
    row = await find_readable(request, material_id, version)
    path = Path(request.app.state.config.materials_dir) / row.relative_path
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != row.sha256:
        raise HTTPException(404, "Файл материала недоступен.")
    return FileResponse(
        path,
        media_type=row.media_type,
        filename=f"material-{row.id}-v{row.version}{EXTENSIONS[row.media_type]}",
        # Браузер не угадывает тип и не кэширует материал на общих АРМ.
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


async def assign(
    request: Request, session_id: UUID, body: MaterialAssignmentInput
) -> list[MaterialView]:
    db: AsyncSession = request.state.db
    value = body.root
    teacher = request.state.user.id
    request_id = UUID(value["request_id"])
    request.state.entity, request.state.entity_id = "session_materials", str(session_id)
    await db.execute(
        select(func.pg_advisory_xact_lock(func.hashtextextended(f"materials:{request_id}", 0)))
    )
    receipt = await db.get(MaterialAssignmentReceipt, (teacher, request_id))
    lesson = await db.get(Session, session_id, with_for_update=True)
    if lesson is None or lesson.teacher_id != teacher:
        raise HTTPException(404, "Занятие не найдено.")
    if receipt is not None:
        if receipt.session_id != session_id or receipt.body != value:
            raise HTTPException(409, "request_id уже использован для другого назначения.")
        return [MaterialView(item) for item in receipt.response]
    if lesson.status != "draft":
        raise HTTPException(409, "Материалы назначаются только до начала занятия.")
    rows: list[Material] = []
    for item in value["materials"]:
        row = await db.scalar(
            select(Material).where(
                Material.id == UUID(item["material_id"]),
                Material.version == item["version"],
                Material.owner_id == teacher,
            )
        )
        if row is None:
            raise HTTPException(404, "Материал не найден.")
        if row.purpose != "reference":
            raise HTTPException(422, "Ученику назначается только справочный материал.")
        rows.append(row)
    for row in rows:
        exists = await db.get(SessionMaterial, (session_id, row.id, row.version))
        if exists is None:
            db.add(SessionMaterial(session_id=session_id, material_id=row.id, version=row.version))
    response = [view(row) for row in rows]
    db.add(
        MaterialAssignmentReceipt(
            actor_id=teacher,
            request_id=request_id,
            session_id=session_id,
            body=value,
            response=[item.root for item in response],
        )
    )
    request.state.audit_after = {"materials": [f"{r.id}:{r.version}" for r in rows]}
    return response
