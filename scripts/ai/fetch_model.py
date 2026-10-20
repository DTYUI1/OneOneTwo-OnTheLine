"""Поставить модель ИИ из каталога data/ai-models.json в models/ (HQ-016).

Модели ставит администратор по желанию: файлы большие (Gemma 26B — 17 ГБ), поэтому сайт их
не качает. Без интернета файл копируют в models/ вручную; этот скрипт — когда сеть есть.
Скачивание продолжается с места обрыва, файл проверяется по SHA-256 и только потом
получает своё имя — роутер llama.cpp не увидит недокачанную модель.

    python3 scripts/ai/fetch_model.py --list
    python3 scripts/ai/fetch_model.py gemma4-26b-a4b
"""

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CHUNK = 8 * 1024 * 1024


def catalog() -> list[dict]:
    return json.loads((ROOT / "data/ai-models.json").read_text(encoding="utf-8"))["models"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while block := file.read(CHUNK):
            digest.update(block)
    return digest.hexdigest()


def fetch(model: dict, folder: Path) -> None:
    target = folder / model["file"]
    if target.is_file() and target.stat().st_size == model["size_bytes"]:
        print(f"{model['id']}: уже установлена ({target})")
        return
    partial = target.with_name(target.name + ".part")
    done = partial.stat().st_size if partial.exists() else 0
    request = urllib.request.Request(model["source"], headers={"Range": f"bytes={done}-"})
    print(f"{model['id']}: {model['size_bytes'] / 1024**3:.1f} ГБ → {target}")
    with urllib.request.urlopen(request) as response, partial.open("ab") as file:
        if done and response.status != 206:
            file.truncate(0)
            done = 0
        while block := response.read(CHUNK):
            file.write(block)
            done += len(block)
            print(f"\r  {done * 100 // model['size_bytes']:3d} %", end="", flush=True)
    print()
    if partial.stat().st_size != model["size_bytes"] or sha256(partial) != model["sha256"]:
        partial.unlink()
        sys.exit(f"{model['id']}: файл повреждён (размер или SHA-256), скачайте заново.")
    partial.rename(target)
    print(f"{model['id']}: установлена. Выберите её в админке: «Модели ИИ».")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("model", nargs="?", help="id модели из data/ai-models.json")
    parser.add_argument("--list", action="store_true", help="показать модели каталога")
    parser.add_argument("--dir", type=Path, default=ROOT / "models", help="папка моделей")
    args = parser.parse_args()
    models = {model["id"]: model for model in catalog()}
    if args.list or not args.model:
        for model in models.values():
            present = (args.dir / model["file"]).is_file()
            mark = "установлена" if present else "нет"
            size = model["size_bytes"] / 1024**3
            print(f"{model['id']:16} {size:5.1f} ГБ  {mark:12} {model['title']}")
        return
    if args.model not in models:
        sys.exit(f"Нет такой модели: {args.model}. Список: --list")
    args.dir.mkdir(parents=True, exist_ok=True)
    fetch(models[args.model], args.dir)


if __name__ == "__main__":
    main()
