#!/usr/bin/env bash
# Сборка реплик служб. Воспроизводимый рецепт: одна команда, один результат.
#
#   scripts/voices/generate.sh
#   scripts/voices/generate.sh --stage completion    # только доклад о завершении (VO-01)
#   scripts/voices/generate.sh --stage complication  # только доклад-осложнение (VAR-01)
#   scripts/voices/generate.sh --stage phrases       # только реплики служб, чей текст
#                                                    # изменился (род: «понял»/«поняла»)
#   scripts/voices/generate.sh --stage refusal       # только отказ ненаправленной бригады
#                                                    # (28.09), затем refusal_manifest.py
#
# Почему в контейнере: piper-tts тянет piper-phonemize, у которого нет колеса
# под macOS ARM — на маке локально он не ставится. В Linux-контейнере ставится
# и на aarch64, и на x86_64, поэтому рецепт одинаков для всей команды.
#
# Модели (~63 МБ каждая) кэшируются в scripts/voices/.cache и в репозиторий
# не попадают: в runtime ни модели, ни синтезатор не нужны.
#
# Piper отдаёт WAV; в поставку идёт Opus в контейнере Ogg. Речь при 32 кбит/с
# не теряет разборчивости, а 26 файлов весят 0,3 МБ вместо 2,9 — они лежат и в
# data/, и копией в бандле, так что вес удваивается. Chromium и Firefox, на
# которых идёт приёмка, Opus играют.

set -euo pipefail

STAGE="all"
while [ $# -gt 0 ]; do
  case "$1" in
    --stage)
      STAGE="$2"
      shift 2
      ;;
    *)
      echo "неизвестный параметр: $1" >&2
      exit 1
      ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="$HERE/.cache"
OUT="$ROOT/data/voices"

# Версия закреплена решением владельца зоны данных (data/voices/README.md).
PIPER_VERSION="1.2.0"
IMAGE="python:3.11-slim-bookworm"

mkdir -p "$CACHE"

docker run --rm \
  -v "$HERE:/work:ro" \
  -v "$CACHE:/cache" \
  -v "$OUT:/out" \
  -w /work \
  "$IMAGE" \
  bash -c "
    set -euo pipefail
    apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg > /dev/null
    pip install --quiet --no-cache-dir 'piper-tts==${PIPER_VERSION}'
    python synth.py /cache /out '${STAGE}'
  "

echo
echo "Файлы: $OUT"
if [ "$STAGE" = "completion" ]; then
  echo "Дальше: scripts/voices/completion_manifest.py — собрать completion.pending.json"
elif [ "$STAGE" = "complication" ]; then
  echo "Дальше: scripts/voices/complication_manifest.py — собрать complication.pending.json"
elif [ "$STAGE" = "refusal" ]; then
  echo "Дальше: scripts/voices/refusal_manifest.py — собрать refusalAssets.ts из refusal-report.json"
else
  echo "Дальше: scripts/voices/manifest.py — собрать manifest.json из synth-report.json"
fi
