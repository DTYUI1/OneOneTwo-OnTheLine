#!/usr/bin/env python3
"""Сборка PDF документации (GP-22): описание и три руководства — одной командой.

Источник — четыре файла Markdown в docs/submission/documentation/ (08–11) со снимками
экранов из img/. Без интернета: pandoc собирает один HTML-файл со встроенными рисунками
и стилями, затем Chromium из Playwright (уже стоит для e2e) печатает его в PDF с
номерами страниц. LaTeX и weasyprint не нужны.

    python3 scripts/docs_pdf.py                 # четыре PDF в docs/submission/build/
    python3 scripts/docs_pdf.py --only 11       # только руководство обучаемого
    python3 scripts/docs_pdf.py --html-only     # без печати, только HTML (проверка вёрстки)
    python3 scripts/docs_pdf.py --out /tmp/pdf  # другой каталог
    python3 scripts/docs_pdf.py --revision abc1234 --images /tmp/shots

Нужно: pandoc (≥ 2.19), node и `pnpm install` в корне репозитория (там Playwright),
браузер Chromium Playwright (`pnpm exec playwright install chromium`, если ещё не ставили).
Каталог docs/submission/build/ в Git не входит (`.gitignore`). Снимки экранов обновляет
`qa/e2e/docs-shots.spec.ts` (инструкция — в его шапке).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "submission" / "documentation"
DEFAULT_OUT = ROOT / "docs" / "submission" / "build"
PLAYWRIGHT = ROOT / "node_modules" / "@playwright" / "test" / "index.mjs"

# Шрифты с кириллицей: на Linux — Liberation/DejaVu, на Windows и macOS — Arial.
CSS = """
@page { size: A4; }
html { font-family: "Liberation Sans", "Arial", "DejaVu Sans", sans-serif; font-size: 10.5pt;
       line-height: 1.45; color: #1d2329; }
body { max-width: none; margin: 0; padding: 0; }
header#title-block-header { margin: 0 0 14pt; padding-bottom: 10pt;
  border-bottom: 2pt solid #1b7bbf; }
h1.title { font-size: 22pt; margin: 0 0 4pt; line-height: 1.2; }
p.subtitle { font-size: 12pt; color: #44505a; margin: 0 0 4pt; }
p.date, p.author { color: #44505a; margin: 0; font-size: 10pt; }
nav#TOC { margin: 0 0 16pt; padding: 8pt 12pt; background: #f1f4f7; border-radius: 3pt; }
nav#TOC::before { content: "Содержание"; font-weight: bold; display: block; margin-bottom: 4pt; }
nav#TOC ul { list-style: none; margin: 0; padding-left: 14pt; }
nav#TOC > ul { padding-left: 0; }
nav#TOC a { color: #1d2329; text-decoration: none; }
h1 { font-size: 16pt; margin: 20pt 0 6pt; break-after: avoid; }
h2 { font-size: 13pt; margin: 14pt 0 4pt; break-after: avoid; color: #14527f; }
h3 { font-size: 11pt; margin: 10pt 0 3pt; break-after: avoid; }
p, li { orphans: 3; widows: 3; }
ul, ol { padding-left: 18pt; }
li { margin: 1.5pt 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; font-size: 9.5pt;
        break-inside: auto; }
th, td { border: 0.6pt solid #b9c2ca; padding: 3pt 5pt; vertical-align: top; text-align: left; }
th { background: #e8edf1; }
tr { break-inside: avoid; }
code, kbd { font-family: "Liberation Mono", "DejaVu Sans Mono", monospace; font-size: 9pt;
            background: #eef1f4; padding: 0 2pt; border-radius: 2pt; }
pre { background: #eef1f4; padding: 6pt 8pt; border-radius: 3pt; font-size: 8.8pt;
      white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
pre code { background: none; padding: 0; }
figure { margin: 8pt 0 12pt; text-align: center; break-inside: avoid; }
figure img { max-width: 100%; max-height: 520pt; border: 0.6pt solid #b9c2ca; }
figcaption { font-size: 9pt; color: #44505a; margin-top: 3pt; }
blockquote { margin: 8pt 0; padding: 4pt 10pt; border-left: 3pt solid #1b7bbf;
  background: #f1f4f7; }
blockquote p { margin: 3pt 0; }
a { color: #14527f; }
"""

FOOTER = (
    '<div style="width:100%;font-size:8px;color:#5a6670;padding:0 16mm;'
    'display:flex;justify-content:space-between;font-family:Arial,sans-serif">'
    "<span>{title}</span><span>Страница <span class='pageNumber'></span> из "
    "<span class='totalPages'></span></span></div>"
)

# Печать — один процесс Node с Playwright: браузер запускается один раз на все файлы.
PRINT_JS = """
import { chromium } from %(playwright)s;
import { pathToFileURL } from "node:url";
const jobs = JSON.parse(process.env.DOCS_PDF_JOBS);
const browser = await chromium.launch();
try {
  for (const job of jobs) {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(job.html).href);
    await page.waitForLoadState("load");
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    });
    await page.pdf({
      path: job.pdf,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: job.footer,
      margin: { top: "16mm", bottom: "18mm", left: "16mm", right: "16mm" },
    });
    await page.close();
  }
} finally {
  await browser.close();
}
"""


@dataclass(frozen=True)
class Doc:
    number: str  # «08»…«11» — префикс файла Markdown
    source: str  # имя файла Markdown
    pdf: str  # имя PDF
    title: str  # подпись в колонтитуле


DOCS = (
    Doc(
        "08",
        "08_technical_description.md",
        "C08_1_technical_description.pdf",
        "Общее техническое описание",
    ),
    Doc("09", "09_admin_guide.md", "C08_2_admin_guide.pdf", "Руководство администратора"),
    Doc("10", "10_teacher_guide.md", "C08_3_teacher_guide.pdf", "Руководство преподавателя"),
    Doc("11", "11_trainee_guide.md", "C08_4_trainee_guide.pdf", "Руководство обучаемого"),
)


def fail(message: str) -> None:
    print(f"ошибка: {message}", file=sys.stderr)
    sys.exit(1)


def to_html(
    doc: Doc,
    css_file: Path,
    target: Path,
    *,
    pandoc: str,
    revision: str | None,
    images: Path | None,
) -> dict[str, list[str]]:
    """Markdown → один HTML-файл: рисунки и стили встроены, ссылки на рисунки — из img/."""
    source = SOURCE / doc.source
    content = source.read_text(encoding="utf-8")
    evidence: dict[str, list[str]] = {"current_images": [], "archive_images": []}
    archive_label = ". Архивная иллюстрация: требует сверки с текущим экраном"
    if images is not None:

        def replace_image(match: re.Match[str]) -> str:
            caption, name = match.groups()
            replacement = images / name
            if replacement.is_file():
                evidence["current_images"].append(name)
                return f"![{caption.removesuffix(archive_label)}]({replacement.as_uri()})"
            evidence["archive_images"].append(name)
            archive_caption = caption.removesuffix(archive_label) + archive_label
            return f"![{archive_caption}](img/{name})"

        content = re.sub(r"!\[([^\]]+)\]\(img/([^\)]+)\)", replace_image, content)
    else:
        for caption, name in re.findall(r"!\[([^\]]+)\]\(img/([^\)]+)\)", content):
            group = "archive_images" if caption.endswith(archive_label) else "current_images"
            evidence[group].append(name)
    if evidence["archive_images"]:
        note = (
            "> Статус иллюстраций: свежие кадры подставлены для доступных экранов; "
            "оставшиеся прямо подписаны как архивные. Полный ролевой прогон и "
            "публикация комплекта принимаются отдельно.\n\n"
        )
        content = content.replace("# 1.", note + "# 1.", 1)
    prepared = css_file.parent / doc.source
    prepared.write_text(content, encoding="utf-8")
    command = [
        pandoc,
        str(prepared),
        "--from=markdown+pipe_tables+implicit_figures+ascii_identifiers-smart",
        "--to=html5",
        "--standalone",
        "--embed-resources",
        "--toc",
        "--toc-depth=2",
        f"--css={css_file}",
        f"--resource-path={SOURCE}",
        "--metadata=lang:ru",
        f"--metadata=pagetitle:{doc.title}",
        f"--output={target}",
    ]
    if revision:
        match = re.search(r"^date: (.+)$", content, re.MULTILINE)
        date = match.group(1) if match else "Документация"
        command.append(f"--metadata=date:{date} · сборка {revision}")
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", check=False)
    if result.returncode != 0:
        fail(f"pandoc не собрал {doc.source}:\n{result.stderr.strip()}")
    for line in result.stderr.strip().splitlines():
        print(f"  pandoc: {line}")
    return evidence


def print_pdf(jobs: list[dict[str, str]]) -> None:
    if not PLAYWRIGHT.exists():
        fail("нет node_modules/@playwright/test: выполните `pnpm install` в корне репозитория")
    node = shutil.which("node")
    if node is None:
        fail("не найден node (нужен для печати в PDF через Playwright)")
    code = PRINT_JS % {"playwright": json.dumps(PLAYWRIGHT.as_uri())}
    env = {**os.environ, "DOCS_PDF_JOBS": json.dumps(jobs)}
    result = subprocess.run(
        [str(node), "--input-type=module", "-e", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    if result.returncode != 0:
        fail(
            "печать в PDF не удалась (нужен браузер: `pnpm exec playwright install chromium`):\n"
            + (result.stderr.strip() or result.stdout.strip())
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="каталог результата")
    parser.add_argument(
        "--only",
        nargs="*",
        default=[],
        help="номера документов (08, 09, 10, 11); по умолчанию — все четыре",
    )
    parser.add_argument("--html-only", action="store_true", help="только HTML, без PDF")
    parser.add_argument("--pandoc", default="pandoc", help="путь к установленному pandoc")
    parser.add_argument("--revision", help="версия проверяемой сборки на титульной странице")
    parser.add_argument(
        "--images",
        type=Path,
        help="папка новых снимков с теми же именами; остальные кадры помечаются архивными",
    )
    args = parser.parse_args()

    pandoc = shutil.which(args.pandoc)
    if pandoc is None:
        fail("не найден pandoc (apt install pandoc)")
    images = args.images.resolve() if args.images else None
    if images is not None and not images.is_dir():
        fail(f"нет папки снимков {images}")
    chosen = [doc for doc in DOCS if not args.only or doc.number in args.only]
    if not chosen:
        fail(f"нет документов с номерами {args.only}: допустимы 08, 09, 10, 11")
    for doc in chosen:
        if not (SOURCE / doc.source).exists():
            fail(f"нет файла {SOURCE / doc.source}")

    out: Path = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    jobs: list[dict[str, str]] = []
    documents: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="docs_pdf_") as tmp:
        css_file = Path(tmp) / "style.css"
        css_file.write_text(CSS, encoding="utf-8")
        for doc in chosen:
            html = (
                (out / doc.pdf.replace(".pdf", ".html"))
                if args.html_only
                else Path(tmp) / (doc.number + ".html")
            )
            print(f"{doc.source}: HTML")
            evidence = to_html(
                doc,
                css_file,
                html,
                pandoc=pandoc,
                revision=args.revision,
                images=images,
            )
            documents.append({"source": doc.source, "pdf": doc.pdf, **evidence})
            jobs.append(
                {
                    "html": str(html),
                    "pdf": str(out / doc.pdf),
                    "footer": FOOTER.format(title=doc.title),
                }
            )
        (out / "build-manifest.json").write_text(
            json.dumps(
                {"revision": args.revision, "documents": documents},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        if args.html_only:
            print(f"HTML — {out}")
            return
        print("печать в PDF…")
        print_pdf(jobs)
    for doc in chosen:
        size = (out / doc.pdf).stat().st_size / 1024 / 1024
        print(f"{out / doc.pdf}  {size:.1f} МБ")


if __name__ == "__main__":
    main()
