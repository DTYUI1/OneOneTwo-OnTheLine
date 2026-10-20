from datetime import datetime
from typing import Literal
from uuid import UUID

from app.api.foundation.schemas import ContractModel


class ScreenShare(ContractModel):
    session_id: UUID
    user_id: UUID
    # requested — запрошен, ждёт согласия ученика; sharing — кадры идут, преподаватель смотрит;
    # paused — показ включён, но преподаватель не смотрит (кадры не шлются); stopped — показа нет.
    state: Literal["requested", "sharing", "paused", "stopped"]
    requested_at: datetime | None
