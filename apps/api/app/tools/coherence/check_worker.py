"""Рабочий процесс `check_scenario` (`check.py`): запрос JSON на stdin → нарушения на stdout.

Запрос: `{"database", "template", "prefix", "data", "policies"}` — адрес PostgreSQL, шаблон,
начало имени копий БД, проверенный сценарий со своим UUID, имена политик. Ответ одной строкой:
`{"violations": [...]}` или `{"stand_error": "…"}` (сбой стенда, `check.StandError`). Вывод
движка и логи — в stderr: stdout только для ответа.
"""

import json
import sys


def main() -> int:
    answer_to = sys.stdout
    sys.stdout = sys.stderr
    from app.tools.coherence.check import StandError, run_policies

    request = json.load(sys.stdin)
    try:
        found = run_policies(
            request["database"],
            request["template"],
            request["prefix"],
            request["data"],
            request["policies"],
        )
        answer: dict[str, object] = {"violations": found}
    except StandError as error:
        answer = {"stand_error": str(error)}
    answer_to.write(json.dumps(answer, ensure_ascii=False) + "\n")
    answer_to.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
