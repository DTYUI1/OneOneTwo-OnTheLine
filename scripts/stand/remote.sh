#!/usr/bin/env bash
# Стенд на удалённом сервере, где собирать образы нельзя (мало памяти) или не на чем.
# Образы собираются здесь под архитектуру сервера, переносятся через
# docker save | ssh | docker load, на сервер копируются только deploy/docker-compose.yml
# и scripts/stand, там запускается up.sh --no-build. Секреты создаются на сервере
# и остаются там (scripts/stand/.local/<проект>/stand.env).
set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

HOST=""
DIR=/opt/arm112
PROJECT=arm112-stand
PORTS=8080:8443
IP=""
SKIP_BUILD=0
UP_ARGS=""

usage() {
  cat <<'EOF'
Использование: scripts/stand/remote.sh --host SSH-ХОСТ [параметры] [-- параметры up.sh]

  --host ХОСТ          ssh-хост сервера (как в ~/.ssh/config), на сервере нужны docker
                       и docker compose
  --dir ПАПКА          куда положить файлы стенда на сервере (по умолчанию /opt/arm112)
  --project ИМЯ        проект Docker Compose (по умолчанию arm112-stand)
  --ports HTTP:HTTPS   порты на сервере (по умолчанию 8080:8443)
  --ip АДРЕС           внешний IP сервера для сертификата (по умолчанию — адрес из ssh)
  --skip-build         не собирать, перенести уже собранные arm112-{api,web}:<проект>

Сборка — docker buildx под архитектуру сервера (нужен плагин buildx: на Mac с colima —
brew install docker-buildx). Первый запуск создаёт на сервере случайный пароль
учётных записей (up.sh --random-password): посмотреть —
ssh ХОСТ grep DEMO_PASSWORD ПАПКА/scripts/stand/.local/ПРОЕКТ/stand.env
EOF
}

fail() {
  echo "ошибка: $1" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --ports) PORTS="${2:-}"; shift 2 ;;
    --ip) IP="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --help | -h) usage; exit 0 ;;
    --) shift; UP_ARGS="$*"; break ;;
    *) fail "неизвестный параметр: $1 (--help)" ;;
  esac
done
[ -n "$HOST" ] || fail "нужен --host (--help)"

remote() { ssh -o BatchMode=yes "$HOST" "$@"; }

echo "→ сервер $HOST"
remote 'docker compose version >/dev/null' || fail "на $HOST нет docker compose"
case "$(remote uname -m)" in
  x86_64) PLATFORM=linux/amd64 ;;
  aarch64 | arm64) PLATFORM=linux/arm64 ;;
  *) fail "неизвестная архитектура сервера" ;;
esac
if [ -z "$IP" ]; then
  IP="$(ssh -G "$HOST" | awk '$1 == "hostname" {print $2; exit}')"
fi
echo "ok  архитектура $PLATFORM, адрес $IP"

API="arm112-api:$PROJECT"
WEB="arm112-web:$PROJECT"
if [ "$SKIP_BUILD" -eq 0 ]; then
  docker buildx version >/dev/null 2>&1 ||
    fail "нужен docker buildx для сборки под $PLATFORM (Mac с colima: brew install docker-buildx)"
  echo "→ сборка $API и $WEB под $PLATFORM (с эмуляцией может занять полчаса)"
  docker buildx build --platform "$PLATFORM" --load -t "$API" -f apps/api/Dockerfile . ||
    fail "сборка $API"
  docker buildx build --platform "$PLATFORM" --load -t "$WEB" -f apps/web/Dockerfile . ||
    fail "сборка $WEB"
fi
for image in "$API" "$WEB"; do
  arch="$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null)" ||
    fail "нет образа $image"
  [ "$arch" = "$PLATFORM" ] || fail "$image собран под $arch, а сервер — $PLATFORM"
done

echo "→ перенос образов на $HOST"
docker save "$API" "$WEB" | gzip -1 | remote 'gunzip | docker load' ||
  fail "перенос образов"

echo "→ файлы стенда в $HOST:$DIR"
remote "mkdir -p '$DIR'" || fail "не создать $DIR"
# Без расширенных атрибутов macOS: иначе GNU tar на сервере сыплет предупреждениями.
COPYFILE_DISABLE=1 tar --no-xattrs -cf - --exclude 'scripts/stand/.local' deploy/docker-compose.yml scripts/stand |
  remote "tar -xf - -C '$DIR'" || fail "копирование файлов"

echo "→ запуск на сервере"
# Пароль учётных записей up.sh печатает в конце — здесь строку с ним не показываем.
# shellcheck disable=SC2086
remote "cd '$DIR' && scripts/stand/up.sh --no-build --random-password --project '$PROJECT' --ports '$PORTS' --ip '$IP' $UP_ARGS" |
  grep -v 'пароль'
status="${PIPESTATUS[0]}"
[ "$status" -eq 0 ] || fail "up.sh на сервере завершился с кодом $status"

HTTPS_PORT="${PORTS##*:}"
echo
echo "Стенд: https://$IP:$HTTPS_PORT/app/login"
echo "Пароль учётных записей: ssh $HOST grep DEMO_PASSWORD $DIR/scripts/stand/.local/$PROJECT/stand.env"
