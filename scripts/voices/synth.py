"""Синтез реплик служб через Piper. Запускается внутри контейнера — см. generate.sh.

Модели и синтезатор нужны только здесь: в поставку и в runtime они не попадают,
в репозиторий кладутся только готовые файлы и манифест.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import urllib.request
import wave
from pathlib import Path

from brigade_texts import (
    COMPLETION_MESSAGES,
    COMPLETION_STAGE,
    COMPLICATION_MESSAGES,
    COMPLICATION_STAGE,
    MESSAGES,
    PROFILE_TO_PIPER,
    REFUSAL_PHRASES,
    REFUSAL_STAGE,
    STAGES,
    VOICE_OF_SERVICE,
)

BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# Голоса Piper для русского языка — других в наборе нет.
# md5 взяты из voices.json того же релиза и проверяются после скачивания:
# молча подменённая модель дала бы другой голос в готовых файлах.
VOICES = {
    "denis": {
        "path": "ru/ru_RU/denis/medium/ru_RU-denis-medium",
        "onnx_md5": "76c2f14e521fef3ed574f97ad492728e",
        "json_md5": "e3df5957c07647cab05cf9910ef3ede0",
    },
    "dmitri": {
        "path": "ru/ru_RU/dmitri/medium/ru_RU-dmitri-medium",
        "onnx_md5": "589ccc91745a1e2353508ff62c5941b7",
        "json_md5": "4eaf0d090190ecb8d958d40c76fd85e8",
    },
    "irina": {
        "path": "ru/ru_RU/irina/medium/ru_RU-irina-medium",
        "onnx_md5": "21fbe77fdc68bdc35d7adb6bf4f52199",
        "json_md5": "e239bb7f22d5de4a44ec6b1cb6c06bb5",
    },
    "ruslan": {
        "path": "ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium",
        "onnx_md5": "731eb188e63b4c57320e38047ba2d850",
        "json_md5": "ae6e273bd38d6ecb05c2d1969b24db0c",
    },
}

# Пол говорящего: реплики от первого лица согласуются с ним («понял» / «поняла»).
# Женский голос с «я вас понял» режет слух и выдаёт синтез (замечание капитана 27.09).
GENDER = {"denis": "male", "dmitri": "male", "irina": "female", "ruslan": "male"}

# Обязательные фразы Q&A Q14. Идентификаторы совпадают с `Phrase` в voices.ts.
PHRASES_BY_GENDER = {
    "male": {
        "listen": "Слушаю вас",
        "accepted": "Я вас понял, информация принята",
    },
    "female": {
        "listen": "Слушаю вас",
        "accepted": "Я вас поняла, информация принята",
    },
}


def md5(path: Path) -> str:
    digest = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url: str, target: Path, expected_md5: str) -> None:
    if target.exists() and md5(target) == expected_md5:
        print(f"  кэш: {target.name}")
        return
    print(f"  качаю: {target.name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, target)
    actual = md5(target)
    if actual != expected_md5:
        raise SystemExit(f"md5 не сошёлся у {target.name}: ждали {expected_md5}, получили {actual}")


def duration_ms(path: Path) -> int:
    with wave.open(str(path), "rb") as handle:
        return round(1000 * handle.getnframes() / handle.getframerate())


OPUS_BITRATE = "32k"


def to_opus(wav: Path) -> Path:
    """WAV → Ogg/Opus. Исходный WAV в поставку не едет."""
    ogg = wav.with_suffix(".ogg")
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(wav),
            "-c:a",
            "libopus",
            "-b:a",
            OPUS_BITRATE,
            "-ac",
            "1",
            str(ogg),
        ],
        check=True,
    )
    wav.unlink()
    return ogg


def synth_one(onnx: Path, conf: Path, text: str, target: Path) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "piper",
            "--model",
            str(onnx),
            "--config",
            str(conf),
            "--output_file",
            str(target),
        ],
        input=text.encode("utf-8"),
        check=True,
    )
    # Длительность снимается с WAV: у Ogg её так просто не прочитать.
    millis = duration_ms(target)
    ogg = to_opus(target)
    return {
        "text": text,
        "duration_ms": millis,
        "bytes": ogg.stat().st_size,
        "sha256": sha256(ogg),
    }


def main() -> int:
    cache = Path(sys.argv[1])
    out = Path(sys.argv[2])
    stage_set = sys.argv[3] if len(sys.argv) > 3 else "all"
    out.mkdir(parents=True, exist_ok=True)
    report: dict[str, dict] = {}
    brigade: dict[str, dict] = {}
    completion: dict[str, dict] = {}
    complication: dict[str, dict] = {}
    refusal: dict[str, dict] = {}
    report_path = out / "synth-report.json"
    previous: dict[str, dict] = (
        json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else {}
    )

    for name, voice in VOICES.items():
        changed = {
            phrase_id: text
            for phrase_id, text in PHRASES_BY_GENDER[GENDER[name]].items()
            if previous.get(name, {}).get(phrase_id, {}).get("text") != text
        }
        if stage_set == "phrases" and not changed:
            continue  # модель этого голоса не нужна — не качаем
        print(f"== {name}")
        onnx = cache / f"{Path(voice['path']).name}.onnx"
        conf = cache / f"{Path(voice['path']).name}.onnx.json"
        fetch(f"{BASE}/{voice['path']}.onnx", onnx, voice["onnx_md5"])
        fetch(f"{BASE}/{voice['path']}.onnx.json", conf, voice["json_md5"])

        if stage_set == "completion":
            for service, profile in VOICE_OF_SERVICE.items():
                if PROFILE_TO_PIPER[profile] != name:
                    continue
                rel = f"brigade/{service}/{COMPLETION_STAGE}"
                meta = synth_one(onnx, conf, COMPLETION_MESSAGES[service], out / f"{rel}.wav")
                completion[service] = {"file": f"{rel}.ogg", **meta}
                print(f"  бригада {service}/{COMPLETION_STAGE}: {meta['duration_ms']} мс")
            continue

        if stage_set == "complication":
            for service, profile in VOICE_OF_SERVICE.items():
                if PROFILE_TO_PIPER[profile] != name:
                    continue
                rel = f"brigade/{service}/{COMPLICATION_STAGE}"
                meta = synth_one(onnx, conf, COMPLICATION_MESSAGES[service], out / f"{rel}.wav")
                complication[service] = {"file": f"{rel}.ogg", **meta}
                print(f"  бригада {service}/{COMPLICATION_STAGE}: {meta['duration_ms']} мс")
            continue

        if stage_set == REFUSAL_STAGE:
            # Отказ звучит голосом бригады, а он у бригады — голос её службы: каждому
            # из четырёх голосов нужны обе фразы.
            for refusal_id, text in REFUSAL_PHRASES.items():
                rel = f"{REFUSAL_STAGE}/{name}/{refusal_id}"
                meta = synth_one(onnx, conf, text, out / f"{rel}.wav")
                refusal.setdefault(name, {})[refusal_id] = {"file": f"{rel}.ogg", **meta}
                print(f"  отказ {refusal_id}: {meta['duration_ms']} мс")
            continue

        if stage_set == "phrases":
            # Только реплики, чей текст разошёлся с отчётом прошлой сборки: остальные
            # файлы (и их SHA-256 в манифестах и БД) не трогаем.
            for phrase_id, text in changed.items():
                target = out / name / f"{phrase_id}.wav"
                meta = synth_one(onnx, conf, text, target)
                previous.setdefault(name, {})[phrase_id] = {
                    "file": f"{name}/{phrase_id}.ogg",
                    **meta,
                }
                print(f"  {phrase_id} пересобрана: «{text}», {meta['duration_ms']} мс")
            continue

        files = {}
        for phrase_id, text in PHRASES_BY_GENDER[GENDER[name]].items():
            target = out / name / f"{phrase_id}.wav"
            meta = synth_one(onnx, conf, text, target)
            files[phrase_id] = {"file": f"{name}/{phrase_id}.ogg", **meta}
            print(f"  {phrase_id}: {meta['duration_ms']} мс")
        report[name] = files

        # Сообщения бригад тех служб, что говорят этим голосом.
        for service, profile in VOICE_OF_SERVICE.items():
            if PROFILE_TO_PIPER[profile] != name:
                continue
            for stage in STAGES:
                rel = f"brigade/{service}/{stage}"
                meta = synth_one(onnx, conf, MESSAGES[service][stage], out / f"{rel}.wav")
                brigade.setdefault(service, {})[stage] = {
                    "file": f"{rel}.ogg",
                    **meta,
                }
                print(f"  бригада {service}/{stage}: {meta['duration_ms']} мс")

    if stage_set == "phrases":
        report_path.write_text(
            json.dumps(previous, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print("готово")
        return 0

    if stage_set == "completion":
        (out / "completion-report.json").write_text(
            json.dumps(completion, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print("готово")
        return 0

    if stage_set == REFUSAL_STAGE:
        (out / "refusal-report.json").write_text(
            json.dumps(refusal, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print("готово")
        return 0

    if stage_set == "complication":
        (out / "complication-report.json").write_text(
            json.dumps(complication, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print("готово")
        return 0

    (out / "synth-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (out / "brigade-report.json").write_text(
        json.dumps(brigade, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("готово")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
