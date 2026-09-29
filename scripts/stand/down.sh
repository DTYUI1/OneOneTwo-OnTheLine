#!/usr/bin/env bash
# Остановка стенда, поднятого up.sh. По умолчанию данные (тома БД и аудио) сохраняются.
set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

PROJECT=arm112-stand
RESET=0
YES=0

usage() {
  cat <<'EOF'
Использование: scripts/stand/down.sh [--project ИМЯ] [--reset --yes]

  --project ИМЯ   имя проекта Docker Compose (по умолчанию arm112-stand)
  --reset --yes   вместе — удаляет тома этого проекта (потеря всех данных стенда)
  --help          эта справка
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
    --reset)
      RESET=1
      shift
      ;;
    --yes)
      YES=1
      shift
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
[ -f "$ENV_FILE" ] || fail "нет секретов проекта $PROJECT ($ENV_FILE) — стенд этим скриптом не поднимался"
[ -f "$OVERRIDE_FILE" ] || fail "нет $OVERRIDE_FILE — стенд этим скриптом не поднимался"

compose() {
  docker compose -p "$PROJECT" -f deploy/docker-compose.yml -f "$OVERRIDE_FILE" --env-file "$ENV_FILE" "$@"
}

# --profile для llm/stt нужен всегда: без него compose stop/down не видит контейнеры
# профилей, даже если up.sh их поднял (--ai local / --stt local) — иначе они остаются
# висеть после "остановки" стенда.
if [ "$RESET" -eq 1 ]; then
  [ "$YES" -eq 1 ] || fail "--reset удаляет все данные проекта $PROJECT — подтвердите флагом --yes"
  echo "→ остановка и удаление данных проекта $PROJECT"
  compose --profile llm --profile stt down -v || fail "не удалось остановить проект $PROJECT"
else
  echo "→ остановка проекта $PROJECT (данные сохраняются)"
  compose --profile llm --profile stt stop || fail "не удалось остановить проект $PROJECT"
fi

echo "Стенд $PROJECT остановлен."
