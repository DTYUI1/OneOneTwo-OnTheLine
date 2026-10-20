"""Выключатель модуля «Оператор 112» — contracts/operator/module-switch.md.

Настройка — строка `operator_module` в `settings`; строки нет — модуль выключен.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from app.api.foundation.router import require_roles
from app.core.models import Setting

KEY = "operator_module"


class Features(BaseModel):
    operator_module: bool


async def operator_module_enabled(request: Request) -> bool:
    row = await request.state.db.scalar(select(Setting).where(Setting.key == KEY))
    return bool(row and row.value.get("enabled") is True)


async def require_module_enabled(request: Request) -> None:
    if not await operator_module_enabled(request):
        raise HTTPException(404, "Модуль «Оператор 112» отключён администратором.")


router = APIRouter(prefix="/api", include_in_schema=False)


@router.get("/features", operation_id="features")
async def get_features(request: Request) -> Features:
    return Features(operator_module=await operator_module_enabled(request))


@router.put(
    "/admin/features",
    operation_id="features_update",
    dependencies=[Depends(require_roles("admin"))],
)
async def put_features(body: Features, request: Request) -> Features:
    db = request.state.db
    row = await db.scalar(select(Setting).where(Setting.key == KEY))
    before = bool(row and row.value.get("enabled") is True)
    if row is None:
        db.add(
            Setting(
                key=KEY, value={"enabled": body.operator_module}, updated_by=request.state.user.id
            )
        )
    else:
        row.value = {"enabled": body.operator_module}
        row.updated_by = request.state.user.id
    request.state.entity = "features"
    request.state.audit_before = {"operator_module": before}
    request.state.audit_after = {"operator_module": body.operator_module}
    return body
