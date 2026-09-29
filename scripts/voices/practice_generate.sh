#!/usr/bin/env bash
# Озвучка докладов бригад в сценариях самостоятельной тренировки: Piper в контейнере,
# как generate.sh. Результат — data/voices/practice/<происшествие>/<служба>/*.ogg и
# data/voices/practice/manifest.json; seed (python -m app.seed.training) берёт их сам.
#
#   scripts/voices/practice_generate.sh
#   VOICES_CACHE=/путь/к/.cache scripts/voices/practice_generate.sh   # модели из другого клона
#
# Тексты — data/practice/*.json. Уже озвученный доклад с тем же текстом не пересобирается.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="${VOICES_CACHE:-$HERE/.cache}"
OUT="$ROOT/data/voices"

# Версия закреплена решением владельца зоны данных (data/voices/README.md).
PIPER_VERSION="1.2.0"
IMAGE="python:3.11-slim-bookworm"

mkdir -p "$CACHE" "$OUT/practice"

# Git Bash на Windows переписывает пути вида /work в аргументах docker — отключаем.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$HERE:/work:ro" \
  -v "$CACHE:/cache" \
  -v "$ROOT/data/practice:/scenarios:ro" \
  -v "$OUT:/out" \
  -w /work \
  "$IMAGE" \
  bash -c "
    set -euo pipefail
    apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg > /dev/null
    pip install --quiet --no-cache-dir 'piper-tts==${PIPER_VERSION}'
    python practice_synth.py /cache /scenarios /out
  "

echo
echo "Файлы: $OUT/practice"
