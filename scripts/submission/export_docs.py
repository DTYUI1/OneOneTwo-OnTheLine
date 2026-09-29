"""Собрать сопроводительную документацию в один DOCX и PDF (ТЗ §18).

Запуск: `uv run --with markdown python scripts/submission/export_docs.py`.
Markdown → HTML (пакет markdown) → DOCX/PDF (LibreOffice `soffice --headless`).
Результат в docs/submission/build/ (не хранится в Git).
"""

import shutil
import subprocess
from datetime import date
from pathlib import Path

import markdown  # type: ignore[import-not-found, import-untyped]

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs/submission/documentation"
BUILD = ROOT / "docs/submission/build"
SECTIONS = [
    "01_architecture.md",
    "02_methods.md",
    "03_install.md",
    "04_constraints.md",
    "05_libraries.md",
    "06_requirements_matrix.md",
    "07_operator_112.md",
]
STYLE = """
body { font-family: 'Liberation Serif', 'DejaVu Serif', serif; font-size: 11pt; }
h1 { font-size: 16pt; page-break-before: always; }
h1.title { page-break-before: avoid; font-size: 20pt; }
h2 { font-size: 13pt; } h3 { font-size: 12pt; }
table { border-collapse: collapse; width: 100%; font-size: 9pt; }
th, td { border: 1px solid #555; padding: 3px 5px; vertical-align: top; }
code, pre { font-family: 'Liberation Mono', 'DejaVu Sans Mono', monospace; font-size: 9pt; }
"""


def build_html() -> Path:
    """Все разделы одним HTML; его же печатают в PDF через Chrome, если LibreOffice нет."""
    BUILD.mkdir(parents=True, exist_ok=True)
    body = [
        '<h1 class="title">Учебный симулятор диспетчера ДДС системы 112</h1>',
        "<p>Сопроводительная документация. Задача № 9, ЛЦТ-2026. "
        f"Команда «Артифишл Интележенс». Редакция от {date.today():%d.%m.%Y}.</p>",
    ]
    for name in SECTIONS:
        text = (SOURCE / name).read_text(encoding="utf-8")
        rendered = markdown.markdown(text, extensions=["tables", "fenced_code"])
        # LibreOffice не применяет CSS-рамки при импорте HTML — задаём их атрибутом.
        body.append(rendered.replace("<table>", '<table border="1" cellpadding="4">'))
    html = BUILD / "C08_documentation.html"
    html.write_text(
        "<!DOCTYPE html><html lang='ru'><head><meta charset='utf-8'>"
        f"<title>Учебный симулятор диспетчера ДДС — документация</title><style>{STYLE}</style>"
        "</head><body>" + "\n".join(body) + "</body></html>",
        encoding="utf-8",
    )
    return html


def main() -> None:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice is None:
        raise SystemExit("Нужен LibreOffice (soffice) для экспорта DOCX/PDF.")
    html = build_html()
    for target in ("docx:MS Word 2007 XML", "pdf:writer_pdf_Export"):
        subprocess.run(
            [soffice, "--headless", "--convert-to", target, "--outdir", str(BUILD), str(html)],
            check=True,
            capture_output=True,
        )
    for suffix in (".docx", ".pdf"):
        path = html.with_suffix(suffix)
        print(f"{path.relative_to(ROOT)}: {path.stat().st_size} байт")


if __name__ == "__main__":
    main()
