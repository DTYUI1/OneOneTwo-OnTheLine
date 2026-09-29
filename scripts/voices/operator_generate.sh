#!/usr/bin/env bash
# Озвучка заявителей модуля «Оператор 112» (этап 2): Piper в контейнере, как generate.sh.
#
#   scripts/voices/operator_generate.sh
#   python3 scripts/voices/operator_manifest.py   # копия для веба и voiceAssets.ts
#
# Тексты — data/operator/scenarios/*.json, раскладка и голоса персонажей —
# operator_texts.py. Модели Piper кэшируются в scripts/voices/.cache (как у generate.sh).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="$HERE/.cache"
OUT="$ROOT/data/voices/operator"

# Версия закреплена решением владельца зоны данных (data/voices/README.md).
PIPER_VERSION="1.2.0"
IMAGE="python:3.11-slim-bookworm"

mkdir -p "$CACHE" "$OUT"
rm -rf "${OUT:?}"/*

# Git Bash на Windows переписывает пути вида /work в аргументах docker — отключаем.
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$HERE:/work:ro" \
  -v "$CACHE:/cache" \
  -v "$ROOT/data/operator:/scenarios:ro" \
  -v "$OUT:/out" \
  -w /work \
  "$IMAGE" \
  bash -c "
    set -euo pipefail
    apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg > /dev/null
    pip install --quiet --no-cache-dir 'piper-tts==${PIPER_VERSION}'
    python operator_synth.py /cache /scenarios /out
  "

echo
echo "Файлы: $OUT"
echo "Дальше: python3 scripts/voices/operator_manifest.py"
