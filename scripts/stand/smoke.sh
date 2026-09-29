#!/usr/bin/env bash
# Смоук стенда, поднятого up.sh: вход, приветствие, справка — минимальный набор qa/e2e
# по-настоящему поднятому стенду (E2E_DATABASE=1). Ничего не поднимает и не останавливает.
set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

PROJECT=arm112-stand

usage() {
  cat <<'EOF'
Использование: scripts/stand/smoke.sh [--project ИМЯ]

  --project ИМЯ   имя проекта Docker Compose (по умолчанию arm112-stand)
  --help          эта справка

Запускает qa/e2e (chromium): foundation, welcome, help-mode — против стенда,
поднятого scripts/stand/up.sh --project ИМЯ. Код выхода: 0 — все тесты прошли, 1 — иначе.
EOF
}

fail() {
  echo "ошибка: $1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      PROJECT="${2:-}"
      [ -n "$PROJECT" ] || fail "--project требует имя"
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      fail "неизвестный параметр: $1 (см. --help)"
      ;;
  esac
done

LOCAL_DIR="scripts/stand/.local/$PROJECT"
ENV_FILE="$LOCAL_DIR/stand.env"
OVERRIDE_FILE="$LOCAL_DIR/compose.override.yml"
[ -f "$ENV_FILE" ] || fail "нет секретов проекта $PROJECT ($ENV_FILE) — стенд этим скриптом не поднимался. Совет: scripts/stand/up.sh --project $PROJECT"
[ -f "$OVERRIDE_FILE" ] || fail "нет $OVERRIDE_FILE — стенд этим скриптом не поднимался. Совет: scripts/stand/up.sh --project $PROJECT"

HTTPS_PORT="$(python3 - "$OVERRIDE_FILE" <<'PY'
import re
import sys

text = open(sys.argv[1]).read()
m = re.search(r"ports: !override \[(.*)\]", text)
if not m:
    sys.exit(1)
items = [x.strip().strip("'\"") for x in m.group(1).split(",")]
for item in items:
    parts = item.split(":")
    if parts[-1] == "443":
        print(parts[1])
        break
PY
)"
[ -n "$HTTPS_PORT" ] || fail "не удалось прочитать порт web из $OVERRIDE_FILE"

# shellcheck disable=SC1090
. "$ENV_FILE"

echo "→ проект $PROJECT, https://127.0.0.1:$HTTPS_PORT, спеки: foundation, welcome, help-mode (chromium)"

unset E2E_RECOVERY_PROJECT
export E2E_BASE_URL="https://127.0.0.1:$HTTPS_PORT"
export E2E_DATABASE=1
export DEMO_PASSWORD="${DEMO_PASSWORD:-demo-local}"

pnpm exec playwright test -c qa/playwright.config.ts \
  foundation.spec.ts welcome.spec.ts help-mode.spec.ts \
  --project=chromium
STATUS=$?

echo ""
if [ "$STATUS" -eq 0 ]; then
  echo "Смоук стенда $PROJECT: все тесты прошли (passed)."
else
  echo "Смоук стенда $PROJECT: есть провалы (failed) — код выхода playwright: $STATUS. Трассы: qa/results."
fi

exit "$STATUS"
