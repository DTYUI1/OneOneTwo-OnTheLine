"""Озвучка заявителей «Оператор 112» через Piper. Запускается в контейнере — operator_generate.sh.

    python operator_synth.py <кэш моделей> <data/operator> <data/voices/operator>

Каждая реплика: Piper (голос персонажа, темп по стилю) → ffmpeg: тон, телефонная полоса
300–3400 Гц, громкость → Ogg/Opus 20 кбит/с, 16 кГц. Плюс фон в трубке для каждого сценария.
Отчёт — operator-report.json: тексты, файлы, SHA-256 (по нему test_operator_caller.py
сверяет, что озвучен текущий текст).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from operator_texts import BACKGROUND_SECONDS, BACKGROUNDS, PROFILES, STYLES, lines_for
from synth import BASE, VOICES, duration_ms, fetch, sha256

SAMPLE_RATE = 22050  # у medium-моделей Piper
PHONE_BAND = "highpass=f=300,lowpass=f=3400"
OPUS = ["-ar", "16000", "-ac", "1", "-c:a", "libopus", "-b:a", "20k"]


def model(cache: Path, voice: str) -> tuple[Path, Path]:
    meta = VOICES[voice]
    onnx = cache / f"ru_RU-{voice}-medium.onnx"
    conf = cache / f"ru_RU-{voice}-medium.onnx.json"
    fetch(f"{BASE}/{meta['path']}.onnx", onnx, meta["onnx_md5"])
    fetch(f"{BASE}/{meta['path']}.onnx.json", conf, meta["json_md5"])
    return onnx, conf


def synth_line(onnx: Path, conf: Path, text: str, profile: dict, style: dict, target: Path) -> int:
    wav = target.with_suffix(".wav")
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "piper",
            "--model",
            str(onnx),
            "--config",
            str(conf),
            "--length_scale",
            f"{profile['length'] * style['length']:.3f}",
            "--noise_scale",
            str(style["noise"]),
            "--noise_w",
            str(style["noise_w"]),
            "--output_file",
            str(wav),
        ],
        input=text.encode("utf-8"),
        check=True,
        capture_output=True,
    )
    millis = duration_ms(wav)
    pitch = profile["pitch"] * style["pitch"]
    filters = []
    if abs(pitch - 1) > 1e-3:
        filters.append(
            f"asetrate={SAMPLE_RATE * pitch:.0f},aresample={SAMPLE_RATE},atempo={1 / pitch:.4f}"
        )
    if profile["tremble"]:
        filters.append("vibrato=f=4.5:d=0.05")
    filters.append(PHONE_BAND)
    if style["gain"]:
        filters.append(f"volume={style['gain']}dB")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-af", ",".join(filters)]
        + OPUS
        + [str(target)],
        check=True,
    )
    wav.unlink()
    return millis


def synth_background(name: str, recipe: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    graph = recipe.format(d=BACKGROUND_SECONDS) + f",{PHONE_BAND}"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-filter_complex",
            graph,
            "-t",
            str(BACKGROUND_SECONDS),
        ]
        + OPUS
        + [str(target)],
        check=True,
    )


def main() -> int:
    cache, scenarios_dir, out = (Path(arg) for arg in sys.argv[1:4])
    report: dict = {"lines": {}, "backgrounds": {}}
    for path in sorted((scenarios_dir / "scenarios").glob("*.json")):
        scenario = json.loads(path.read_text(encoding="utf-8"))
        profile = PROFILES[scenario["persona"]["kind"]]
        onnx, conf = model(cache, profile["voice"])
        rows = report["lines"][scenario["id"]] = {}
        print(f"{scenario['id']}: {scenario['persona']['label']}, голос {profile['voice']}")
        for line in lines_for(scenario):
            target = out / scenario["id"] / f"{line['line']}.ogg"
            millis = synth_line(onnx, conf, line["text"], profile, STYLES[line["style"]], target)
            rows[line["line"]] = {
                "text": line["text"],
                "style": line["style"],
                "voice": profile["voice"],
                "file": f"{scenario['id']}/{line['line']}.ogg",
                "duration_ms": millis,
                "bytes": target.stat().st_size,
                "sha256": sha256(target),
            }
        print(f"  реплик: {len(rows)}")
    for name, recipe in BACKGROUNDS.items():
        target = out / "background" / f"{name}.ogg"
        synth_background(name, recipe, target)
        report["backgrounds"][name] = {
            "file": f"background/{name}.ogg",
            "bytes": target.stat().st_size,
            "sha256": sha256(target),
        }
        print(f"фон {name}: {target.stat().st_size} байт")
    (out / "operator-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
