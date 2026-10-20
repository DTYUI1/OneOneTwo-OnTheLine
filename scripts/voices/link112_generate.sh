#!/usr/bin/env bash
# Устарело (проверка 17.10, HQ-036): seed связки (app.seed.link112) больше не берёт эту
# озвучку — голос реплик связки берётся из банка (data/voices/bank-v*, книги
# scripts/voices/bank/link112/), записи нет — реплика текстом. Скрипт оставлен для истории
# записей data/voices/link112 (PROVENANCE.md).
#
# Озвучка докладов и реплик бригад связки 112 → ДДС (DT-10): Piper в контейнере, как
# practice_generate.sh. Результат — data/voices/link112/<сюжет>/<служба>/*.ogg и
# data/voices/link112/manifest.json; seed (python -m app.seed.training) берёт их сам.
#
#   scripts/voices/link112_generate.sh
#   VOICES_CACHE=/путь/к/.cache scripts/voices/link112_generate.sh   # модели из другого клона
#
# Тексты — data/link112/plots/*.json и records/*.json, правда адреса — data/operator/scenarios.
# Уже озвученная реплика с тем же текстом не пересобирается.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="${VOICES_CACHE:-$HERE/.cache}"
OUT="$ROOT/data/voices"

# Версия закреплена решением владельца зоны данных (data/voices/README.md).
PIPER_VERSION="1.2.0"
IMAGE="python:3.11-slim-bookworm"

mkdir -p "$CACHE" "$OUT/link112"

# Git Bash на Windows переписывает пути вида /work в аргументах docker — отключаем.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$HERE:/work:ro" \
  -v "$CACHE:/cache" \
  -v "$ROOT/data/link112:/link112:ro" \
  -v "$ROOT/data/operator/scenarios:/scenarios:ro" \
  -v "$OUT:/out" \
  -w /work \
  "$IMAGE" \
  bash -c "
    set -euo pipefail
    apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg > /dev/null
    pip install --quiet --no-cache-dir 'piper-tts==${PIPER_VERSION}'
    python link112_synth.py /cache /link112 /out /scenarios
  "

echo
echo "Файлы: $OUT/link112"
