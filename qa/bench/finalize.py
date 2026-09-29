"""Добавить прямой замер PostgreSQL в готовый отчёт нагрузки."""

import json
import sys
from pathlib import Path

from bench import markdown


def main() -> None:
    folder = Path(sys.argv[1])
    db_writes_per_s = int(sys.argv[2])
    result_path = folder / "results.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    # Старое поле означало last_s / finished, а не задержку отдельной карточки.
    if result.get("class", {}).get("llm"):
        result["class"]["llm"].pop("per_card_s", None)
    result["db_writes_per_s"] = db_writes_per_s
    result_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    passed = "да" if db_writes_per_s >= 100 else "НЕТ"
    report = markdown(result)
    report += (
        "\n## Запись в PostgreSQL (NFR-8: БД ≥ 100 записей/с)\n\n"
        "pgbench, одна строка в отдельной транзакции, 8 соединений, 15 с: "
        f"**{db_writes_per_s} записей/с**. Цель выполнена: **{passed}**. "
        "Путь через API измерен отдельно и ограничен задержкой каждого "
        "последовательного запроса.\n"
    )
    (folder / "report.md").write_text(report, encoding="utf-8")


if __name__ == "__main__":
    main()
