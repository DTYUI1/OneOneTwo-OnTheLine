#!/usr/bin/env bash
# Озвучка реплик сценариев ДДС новым набором голосов (GP-15, TC-09): тексты — data/scenarios,
# произношение — data/pronunciation.json, файлы — data/voices/<набор>/ и его manifest.json.
# Синтез в контейнере, как generate.sh; голос «по телефону» — scripts/voices/phone.py.
#
#   scripts/voices/scenario_generate.sh                       # набор dds-v3, Vosk TTS
#   VOICE_SET=dds-v4 scripts/voices/scenario_generate.sh      # другой набор
#   ELEVENLABS_API_KEY=... VOICE_SET=dds-el scripts/voices/scenario_generate.sh
#
# Ключ ElevenLabs берётся только из окружения и в контейнер передаётся по имени: в
# командной строке, файлах и логах его нет. Без ключа — локальный Vosk TTS (CPU).
# После сборки: python3 scripts/voices/scenario_voices.py switch <набор> — сценарии
# переходят на набор новой версией. Подробно — scripts/voices/README.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="${VOICES_CACHE:-$HERE/.cache}"
OUT="$ROOT/data/voices"
VOICE_SET="${VOICE_SET:-dds-v3}"

IMAGE="python:3.11-slim-bookworm"
VOSK_TTS_VERSION="0.3.61"
ONNXRUNTIME_VERSION="1.31.0"

mkdir -p "$CACHE" "$OUT/${VOICE_SET}"
python3 "$HERE/scenario_voices.py" todo "${VOICE_SET}" > "$CACHE/todo-${VOICE_SET}.json"

if [ -n "${ELEVENLABS_API_KEY:-}" ]; then
  echo "движок: ElevenLabs (ключ из окружения)"
  INSTALL="true"
else
  echo "движок: Vosk TTS ${VOSK_TTS_VERSION}, локально"
  INSTALL="pip install --quiet --no-cache-dir 'vosk-tts==${VOSK_TTS_VERSION}' 'onnxruntime==${ONNXRUNTIME_VERSION}'"
fi

# Git Bash на Windows переписывает пути вида /work в аргументах docker — отключаем.
MSYS_NO_PATHCONV=1 docker run --rm \
  -e ELEVENLABS_API_KEY \
  -e ELEVENLABS_BASE_URL \
  -e ELEVENLABS_MODEL \
  -e ELEVENLABS_VOICE_101 -e ELEVENLABS_VOICE_102 -e ELEVENLABS_VOICE_103 \
  -e ELEVENLABS_VOICE_104 -e ELEVENLABS_VOICE_GKH -e ELEVENLABS_VOICE_MOSLIFT \
  ${DOCKER_NETWORK:+--network "${DOCKER_NETWORK}"} \
  -v "$HERE:/work:ro" \
  -v "$CACHE:/root/.cache" \
  -v "$OUT:/out" \
  -v "$ROOT/data/pronunciation.json:/pronunciation.json:ro" \
  -w /work \
  "$IMAGE" \
  bash -c "
    set -euo pipefail
    apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg > /dev/null
    ${INSTALL}
    python scenario_synth.py /root/.cache '/root/.cache/todo-${VOICE_SET}.json' /out '${VOICE_SET}' /pronunciation.json
  "

echo
echo "Файлы: $OUT/${VOICE_SET}"
echo "Дальше: python3 scripts/voices/scenario_voices.py switch ${VOICE_SET}"
