"""Сравнение существующей истории выделенной C-01 БД без изменения её строк."""

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

PROJECTS = {"arm112-c01-stage6-final", "arm112-c01-publish", "arm112-ci-database"}
TABLES = (
    "sessions",
    "assignments",
    "cards",
    "card_events",
    "calls",
    "predictions",
    "evaluations",
    "teacher_overrides",
    "audit_log",
)


def read_history(project: str) -> dict[str, Any]:
    """Читает хеши строк; соединяется только с явно разрешённым тестовым проектом."""
    if project not in PROJECTS:
        raise ValueError("Нужен выделенный проект итоговой приёмки C-01.")
    container = f"{project}-db-1"
    inspected = json.loads(
        subprocess.check_output(["docker", "inspect", container], text=True, encoding="utf-8")
    )[0]
    labels = inspected["Config"]["Labels"]
    if (
        labels["com.docker.compose.project"] != project
        or labels["com.docker.compose.service"] != "db"
    ):
        raise ValueError("Контейнер не соответствует выбранной тестовой БД.")

    def query(sql: str) -> Any:
        return json.loads(
            subprocess.check_output(
                [
                    "docker",
                    "exec",
                    "-i",
                    container,
                    "psql",
                    "-X",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-U",
                    "arm112",
                    "-d",
                    "arm112",
                    "-At",
                ],
                input=sql,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
        )

    # Имена таблиц — константы, содержимое строк не сохраняется в артефакте.
    tables = {
        table: query(
            "SELECT coalesce(jsonb_object_agg(id::text, md5(to_jsonb(t)::text)), '{}'::jsonb) "
            f"FROM {table} AS t;"
        )
        for table in TABLES
    }
    unopened = query(
        "SELECT count(*) FROM cards c JOIN assignments a ON a.id=c.assignment_id "
        "JOIN sessions s ON s.id=a.session_id WHERE s.status='finished' "
        "AND c.state='added' AND c.delivered_at IS NULL AND c.opened_at IS NULL;"
    )
    return {"project": project, "tables": tables, "finished_unopened": unopened}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("capture", "verify"))
    parser.add_argument("--project", required=True, choices=sorted(PROJECTS))
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    current = read_history(args.project)
    if args.mode == "capture":
        if args.manifest.exists():
            raise ValueError("Манифест уже существует; используйте новое имя без перезаписи.")
        if current["finished_unopened"] < 1 or any(not rows for rows in current["tables"].values()):
            raise ValueError("Нужна история после полного прогона, включая неоткрытые карточки.")
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(json.dumps(current, indent=2), encoding="utf-8")
    else:
        previous = json.loads(args.manifest.read_text(encoding="utf-8"))
        if previous["project"] != args.project:
            raise ValueError("Манифест относится к другому проекту.")
        for table, rows in previous["tables"].items():
            for identity, digest in rows.items():
                if current["tables"][table].get(identity) != digest:
                    raise AssertionError(
                        f"Историческая строка удалена/изменена: {table}/{identity}"
                    )
    print(
        json.dumps(
            {
                "mode": args.mode,
                "counts": {k: len(v) for k, v in current["tables"].items()},
                "finished_unopened": current["finished_unopened"],
            }
        )
    )


if __name__ == "__main__":
    main()
