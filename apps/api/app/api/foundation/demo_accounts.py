"""Учётные записи для проверки на экране входа: логины демо-ролей и пароль стенда."""

import json
from functools import cache

from app.api.foundation import schemas
from app.core.config import ROOT, Settings

ROLE_ORDER = {"admin": 0, "teacher": 1, "trainee": 2}


@cache
def _accounts() -> list[schemas.DemoAccount]:
    users = json.loads((ROOT / "data" / "seed" / "demo_users.json").read_text(encoding="utf-8"))
    rows = [schemas.DemoAccount(**{k: u[k] for k in ("login", "role", "full_name")}) for u in users]
    return sorted(rows, key=lambda row: (ROLE_ORDER[row.role], row.login))


def demo_accounts(config: Settings) -> schemas.DemoAccounts:
    if not config.demo_accounts_shown:
        return schemas.DemoAccounts(enabled=False, password=None, accounts=[])
    return schemas.DemoAccounts(enabled=True, password=config.demo_password, accounts=_accounts())
