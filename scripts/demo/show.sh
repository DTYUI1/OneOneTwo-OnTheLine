#!/usr/bin/env bash
# Показ одной командой (TC-14, GP-18): поднимает стенд и открывает два окна браузера —
# преподаватель слева, обучаемый справа, логины уже введены. Для записи ролика.
set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

PROJECT=arm112-stand
HTTP_PORT=8080
HTTPS_PORT=8443
UP=1
HEADLESS=0
DRY=0
TRAINEE=trainee03

usage() {
  cat <<'EOF2'
Использование: scripts/demo/show.sh [--project ИМЯ] [--ports HTTP:HTTPS] [--trainee ЛОГИН]
                                    [--no-up] [--headless] [--dry-run]

  --project ИМЯ        проект Docker Compose стенда (по умолчанию arm112-stand)
  --ports HTTP:HTTPS   порты стенда (по умолчанию 8080:8443)
  --trainee ЛОГИН      кто в правом окне (по умолчанию trainee03)
  --no-up              стенд уже поднят — только открыть окна
  --headless           без видимых окон: проверить, что оба входа проходят
  --dry-run            показать, что будет сделано, и выйти
  --help               эта справка

Стенд поднимает scripts/stand/up.sh (секреты — scripts/stand/.local/<проект>/stand.env),
окна — scripts/demo/show-windows.mjs (Chromium из Playwright). Остановить стенд:
scripts/stand/down.sh --project ИМЯ.
EOF2
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
    --ports)
      case "${2:-}" in
        *:*) HTTP_PORT="${2%%:*}"; HTTPS_PORT="${2##*:}" ;;
        *) fail "--ports ожидает HTTP:HTTPS, например 8080:8443" ;;
      esac
      shift 2
      ;;
    --trainee)
      TRAINEE="${2:-}"
      [ -n "$TRAINEE" ] || fail "--trainee требует логин"
      shift 2
      ;;
    --no-up) UP=0; shift ;;
    --headless) HEADLESS=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --help | -h) usage; exit 0 ;;
    *) usage >&2; fail "неизвестный параметр: $1" ;;
  esac
done

UP_CMD=(scripts/stand/up.sh --project "$PROJECT" --ports "$HTTP_PORT:$HTTPS_PORT")
WIN_CMD=(node scripts/demo/show-windows.mjs --url "https://localhost:$HTTPS_PORT" --trainee "$TRAINEE" --hold)
[ "$HEADLESS" -eq 1 ] && WIN_CMD=(node scripts/demo/show-windows.mjs --url "https://localhost:$HTTPS_PORT" --trainee "$TRAINEE" --headless)

if [ "$DRY" -eq 1 ]; then
  [ "$UP" -eq 1 ] && echo "1. ${UP_CMD[*]}"
  echo "2. ${WIN_CMD[*]} --password <из scripts/stand/.local/$PROJECT/stand.env>"
  exit 0
fi

if [ "$UP" -eq 1 ]; then
  "${UP_CMD[@]}" || fail "стенд не поднялся"
fi

ENV_FILE="scripts/stand/.local/$PROJECT/stand.env"
[ -f "$ENV_FILE" ] || fail "нет $ENV_FILE — стенд этого проекта ещё не создавался (запустите без --no-up)"
PASSWORD="$(sed -n 's/^DEMO_PASSWORD=//p' "$ENV_FILE" | head -n 1)"
[ -n "$PASSWORD" ] || fail "в $ENV_FILE нет DEMO_PASSWORD"

"${WIN_CMD[@]}" --password "$PASSWORD" || fail "окна не открылись или вход не прошёл"
