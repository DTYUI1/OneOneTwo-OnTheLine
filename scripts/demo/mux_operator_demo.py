"""Свести демо-ролик «Оператор 112»: видео Playwright + голос заявителя по журналу.

Ролик пишет qa/e2e/operator-demo.spec.ts (OPERATOR_DEMO=1): raw.webm без звука, audio.json —
когда какой звук начал и перестал звучать (Date.now()), и сами звуки в audio/.

Запись экрана Playwright идёт медленнее реального времени и неравномерно, поэтому в каждом
кадре внизу слева — полоска 960×12 px: Date.now() по модулю 2^32, 32 клетки по 30 px, старший
бит слева. Здесь кадры пересобираются по их реальному времени, а звуки ставятся по журналу:
равномерное ускорение неравномерной записи могло накладывать соседние реплики друг на друга.
Полоска срезается (нижние 16 px,
картинка масштабируется обратно в 1920×1080). Итог — MP4 (H.264 + AAC) не длиннее
--max-length, с затуханием в конце.

Запуск: .venv/Scripts/python.exe scripts/demo/mux_operator_demo.py [--dir docs/tmp/demo]
[--max-length 180]. Для этого инструмента нужен пакет imageio-ffmpeg
(python -m pip install imageio-ffmpeg); системный ffmpeg используется при наличии.
"""

import argparse
import bisect
import importlib
import json
import math
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Пакет требуется только инструменту демо, а не приложению или общим проверкам типов.
try:
    imageio_ffmpeg = importlib.import_module("imageio_ffmpeg")
except ModuleNotFoundError as error:
    raise SystemExit("Для сведения выполните python -m pip install imageio-ffmpeg.") from error

FFMPEG = shutil.which("ffmpeg") or str(imageio_ffmpeg.get_ffmpeg_exe())
# Фон в трубке тише голоса — как в приложении (voice.ts: BACKGROUND_VOLUME 0.35), чуть тише.
BED_VOLUME = 0.25
FADE_S = 0.8
STRIP_W, STRIP_H, CELLS = 960, 12, 32
CROP_BOTTOM = 16
WRAP = 2**32
# Метка правдоподобна, если она не дальше часа от начала записи.
MAX_SPAN_MS = 3_600_000
OUTPUT_FPS = 25


@dataclass(frozen=True)
class Clip:
    file: Path
    start: float
    length: float | None
    loop: bool = False


def video_fps(video: Path) -> float:
    out = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", str(video)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    ).stderr
    found = re.search(r"([0-9.]+) fps", out)
    return float(found.group(1)) if found else 25.0


def frame_stamps(video: Path, reference: int) -> list[tuple[float, int]]:
    """(время кадра в видео, мс от начала записи) — для кадров с читаемой полоской."""
    raw = subprocess.run(
        [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(video),
            "-vf",
            f"crop={STRIP_W}:{STRIP_H}:0:ih-{STRIP_H},format=gray",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "-",
        ],
        capture_output=True,
        check=True,
    ).stdout
    fps = video_fps(video)
    size = STRIP_W * STRIP_H
    cell = STRIP_W // CELLS
    middle = STRIP_W * (STRIP_H // 2)
    stamps: list[tuple[float, int]] = []
    for index in range(len(raw) // size):
        row = raw[index * size + middle : index * size + middle + STRIP_W]
        levels = [row[bit * cell + cell // 2] for bit in range(CELLS)]
        # Серые клетки — не полоска (вспышка, загрузка страницы): кадр пропускаем.
        if any(60 < level < 190 for level in levels):
            continue
        value = int("".join("1" if level >= 128 else "0" for level in levels), 2)
        relative = (value - reference) % WRAP
        if relative < MAX_SPAN_MS and (not stamps or relative >= stamps[-1][1]):
            stamps.append((index / fps, relative))
    if len(stamps) < 10:
        raise SystemExit("Полоска-метка не читается: проверьте raw.webm")
    return stamps


def clips(journal: dict, audio: Path) -> list[Clip]:
    """Реплика звучит от play до своего end/pause; фон (loop) — до pause.
    Начало и длина — реальное время, без изменения темпа или порядка реплик."""
    t0 = journal["startedAt"]
    log = journal["log"]
    result: list[Clip] = []
    for index, event in enumerate(log):
        if event["e"] != "play" or not event["src"]:
            continue
        stop = next(
            (
                later
                for later in log[index + 1 :]
                if later["src"] == event["src"] and later["e"] in ("end", "pause")
            ),
            None,
        )
        loop = bool(event.get("loop"))
        cut = stop is not None and (loop or stop["e"] == "pause")
        length = (stop["t"] - event["t"]) / 1000 if cut and stop else None
        start = (event["t"] - t0) / 1000
        result.append(Clip(audio / event["src"], start, length, loop=loop))
    return result


def encode_timeline(
    video: Path,
    stamps: list[tuple[float, int]],
    begin_ms: int,
    length: float,
    arguments: list[str],
) -> None:
    """На каждый выходной кадр берём последний кадр с соответствующей меткой времени.
    Читаем исходник последовательно; в памяти остаётся только один полный кадр."""
    frames = imageio_ffmpeg.read_frames(str(video), pix_fmt="yuv420p", bits_per_pixel=12)
    try:
        meta = next(frames)
        width, height = meta["size"]
        source_fps = meta["fps"]
        times = [relative for _, relative in stamps]
        command = [
            FFMPEG,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "yuv420p",
            "-s",
            f"{width}x{height}",
            "-r",
            str(OUTPUT_FPS),
            "-i",
            "pipe:0",
            *arguments,
        ]
        with tempfile.TemporaryFile() as errors:
            encoder = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=errors)
            assert encoder.stdin is not None
            try:
                source_index = -1
                frame = b""
                for index in range(math.ceil(length * OUTPUT_FPS)):
                    moment = begin_ms + index * 1000 / OUTPUT_FPS
                    stamp = max(0, bisect.bisect_right(times, moment) - 1)
                    wanted = round(stamps[stamp][0] * source_fps)
                    while source_index < wanted:
                        frame = next(frames)
                        source_index += 1
                    encoder.stdin.write(frame)
                encoder.stdin.close()
                result = encoder.wait()
            finally:
                if encoder.poll() is None:
                    encoder.terminate()
                    encoder.wait()
            if result:
                errors.seek(0)
                raise RuntimeError(errors.read().decode("utf-8", errors="replace"))
    finally:
        frames.close()


def mux(directory: Path, max_length: float) -> Path:
    journal = json.loads((directory / "audio.json").read_text(encoding="utf-8"))
    video = directory / "raw.webm"
    t0 = journal["startedAt"]
    stamps = frame_stamps(video, t0 % WRAP)
    # Ролик — от первого кадра с меткой (страница входа) до финальной вспышки.
    end_moment = journal["flashEnd"] - t0
    usable = [item for item in stamps if item[1] < end_moment]
    (_, real_begin), (_, real_end) = usable[0], usable[-1]
    length = min((real_end - real_begin) / 1000, max_length)
    parts = clips(journal, directory / "audio")
    print(
        f"Кадров с меткой: {len(stamps)}; пересборка по реальному времени; "
        f"ролик {length:.1f} с, звуков: {len(parts)}"
    )

    command: list[str] = []
    filters: list[str] = []
    labels: list[str] = []
    for index, clip in enumerate(parts, start=1):
        if clip.loop:
            command += ["-stream_loop", "-1"]
        command += ["-i", str(clip.file)]
        start = clip.start - real_begin / 1000
        chain = f"[{index}:a]aformat=sample_rates=48000:channel_layouts=stereo"
        # Звук, начавшийся до начала ролика, входит в него с середины.
        skip = max(0.0, -start)
        span = clip.length if clip.length is not None else (length - start if clip.loop else None)
        if span is not None:
            chain += f",atrim={skip:.3f}:{max(span, skip + 0.05):.3f}"
        elif skip:
            chain += f",atrim={skip:.3f}"
        chain += ",asetpts=PTS-STARTPTS"
        if clip.loop:
            chain += f",volume={BED_VOLUME}"
        chain += f",adelay={max(0, round(start * 1000))}:all=1[a{index}]"
        filters.append(chain)
        labels.append(f"[a{index}]")
    fade_at = length - FADE_S
    filters.append(
        f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,"
        f"apad,atrim=0:{length:.3f},afade=t=out:st={fade_at:.3f}:d={FADE_S}[aout]"
    )
    filters.append(
        f"[0:v]crop=iw:ih-{CROP_BOTTOM}:0:0,scale=1920:1080,setsar=1,"
        f"fade=t=out:st={fade_at:.3f}:d={FADE_S}[vout]"
    )
    output = directory / "operator_112_demo.mp4"
    command += [
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-t",
        f"{length:.3f}",
        str(output),
    ]
    encode_timeline(video, usable, real_begin, length, command)
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=Path, default=Path("docs/tmp/demo"))
    parser.add_argument("--max-length", type=float, default=180.0, help="предел длины, с")
    args = parser.parse_args()
    print(f"Готово: {mux(args.dir, args.max_length)}")


if __name__ == "__main__":
    main()
