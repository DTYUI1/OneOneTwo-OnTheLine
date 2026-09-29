#!/usr/bin/env bash
# Стенд одной командой: build → db → migrate → seed → seed.training → api/worker/web →
# ожидание /api/health. Секреты — scripts/stand/.local/<проект>/stand.env (создаются один
# раз и переиспользуются). deploy/docker-compose.yml не меняется — свой override в
# .local/<проект>/compose.override.yml задаёт теги образов и порты этого проекта.
set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

PROJECT=arm112-stand
HTTP_PORT=8080
HTTPS_PORT=8443
AI_MODE=off
STT_MODE=off
LAN=0
IP_OVERRIDE=""
NO_BUILD=0
RANDOM_PASSWORD=0

usage() {
  cat <<'EOF'
Использование: scripts/stand/up.sh [--project ИМЯ] [--ports HTTP:HTTPS] [--ai off|local]
                                    [--stt off|local] [--lan] [--ip АДРЕС]
                                    [--no-build] [--random-password]

  --project ИМЯ        имя проекта Docker Compose (по умолчанию arm112-stand)
  --ports HTTP:HTTPS   порты хоста для web (по умолчанию 8080:8443)
  --ai off|local       off — без ИИ (по умолчанию); local — локальная модель
  --stt off|local      off — без распознавания речи (по умолчанию); local — faster-whisper
  --lan                открыть стенд для других компьютеров сети (WEB_BIND=0.0.0.0),
                       IP машины определяется сам
  --ip АДРЕС           задать IP машины вручную вместо автоопределения (включает --lan)
  --no-build           не собирать образы, взять готовые arm112-api:<проект> и
                       arm112-web:<проект> (для слабого сервера: собрать на другой машине,
                       перенести docker save | docker load)
  --random-password    при первом создании секретов — случайный пароль учётных записей
                       вместо demo-local (для стенда, открытого в интернет)
  --help               эта справка

Секреты проекта хранятся в scripts/stand/.local/<проект>/stand.env и создаются один раз.
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
    --ports)
      case "${2:-}" in
        *:*)
          HTTP_PORT="${2%%:*}"
          HTTPS_PORT="${2##*:}"
          ;;
        *) fail "--ports ожидает формат HTTP:HTTPS" ;;
      esac
      shift 2
      ;;
    --ai)
      AI_MODE="${2:-}"
      case "$AI_MODE" in
        off | local) ;;
        *) fail "--ai принимает только off или local" ;;
      esac
      shift 2
      ;;
    --stt)
      STT_MODE="${2:-}"
      case "$STT_MODE" in
        off | local) ;;
        *) fail "--stt принимает только off или local" ;;
      esac
      shift 2
      ;;
    --lan)
      LAN=1
      shift
      ;;
    --ip)
      IP_OVERRIDE="${2:-}"
      [ -n "$IP_OVERRIDE" ] || fail "--ip требует значение"
      LAN=1
      shift 2
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --random-password)
      RANDOM_PASSWORD=1
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

case "$PROJECT" in
  '' | arm112 | *[!a-z0-9_-]*)
    fail "--project: имя должно состоять из строчных букв, цифр, - или _, и не быть 'arm112' (это чужой стенд)"
    ;;
esac
case "$HTTP_PORT$HTTPS_PORT" in
  *[!0-9]*) fail "--ports: порты должны быть числами" ;;
esac

detect_ip() { # печатает IP машины в сети или пустую строку
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  ip=""
  case "$uname_s" in
    Darwin)
      ip="$(ipconfig getifaddr en0 2>/dev/null)"
      [ -n "$ip" ] || ip="$(ipconfig getifaddr en1 2>/dev/null)"
      ;;
    Linux)
      if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
        # WSL: своя внутренняя сеть, адрес для LAN — у хоста Windows
        ip="$(ipconfig.exe 2>/dev/null | awk -F': ' '/IPv4 Address/{gsub(/\r/, "", $2); print $2; exit}')"
      else
        ip="$(ip route get 1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
        [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
      fi
      ;;
    MINGW* | MSYS* | CYGWIN*)
      ip="$(ipconfig 2>/dev/null | awk -F': ' '/IPv4 Address/{gsub(/\r/, "", $2); print $2; exit}')"
      ;;
  esac
  echo "$ip"
}

if [ "$LAN" -eq 1 ]; then
  if [ -n "$IP_OVERRIDE" ]; then
    LAN_IP="$IP_OVERRIDE"
  else
    LAN_IP="$(detect_ip)"
    [ -n "$LAN_IP" ] || fail "--lan: не удалось определить IP автоматически, задайте адрес вручную: --ip АДРЕС"
  fi
  DESIRED_WEB_BIND=0.0.0.0
  DESIRED_CERT_HOSTNAMES="localhost,127.0.0.1,$LAN_IP"
else
  DESIRED_WEB_BIND=127.0.0.1
  DESIRED_CERT_HOSTNAMES="localhost,127.0.0.1"
fi

LOCAL_DIR="scripts/stand/.local/$PROJECT"
ENV_FILE="$LOCAL_DIR/stand.env"
OVERRIDE_FILE="$LOCAL_DIR/compose.override.yml"
mkdir -p "$LOCAL_DIR"

random_hex() { # $1 число байт
  python3 -c "import secrets; print(secrets.token_hex($1))"
}
random_b64() { # $1 число байт
  python3 -c "import secrets; print(secrets.token_urlsafe($1))"
}

if [ ! -f "$ENV_FILE" ]; then
  echo "→ секреты проекта $PROJECT: создаю $ENV_FILE"
  POSTGRES_PASSWORD="$(random_hex 24)"
  JWT_SECRET="$(random_b64 48)"
  NEW_DEMO_PASSWORD=demo-local
  [ "$RANDOM_PASSWORD" -eq 1 ] && NEW_DEMO_PASSWORD="$(random_b64 12)"
  {
    echo "API_MODE=database"
    echo "POSTGRES_DB=arm112"
    echo "POSTGRES_USER=arm112"
    echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
    echo "DATABASE_URL=postgresql+asyncpg://arm112:${POSTGRES_PASSWORD}@db:5432/arm112"
    echo "JWT_SECRET=$JWT_SECRET"
    echo "DEMO_PASSWORD=$NEW_DEMO_PASSWORD"
    echo "COOKIE_SECURE=true"
  } >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  echo "ok  секреты проекта $PROJECT уже созданы, использую $ENV_FILE"
fi

# shellcheck disable=SC1090
. "$ENV_FILE"
WEB_BIND="$DESIRED_WEB_BIND"
CERT_HOSTNAMES="$DESIRED_CERT_HOSTNAMES"
export WEB_BIND CERT_HOSTNAMES

PROFILE_ARGS=""
UP_SERVICES="api worker web"

if [ "$AI_MODE" = local ]; then
  MODEL_FILE="$ROOT/models/qwen3-4b-instruct-2507-q4_k_m.gguf"
  [ -f "$MODEL_FILE" ] || fail "--ai local: нет файла models/qwen3-4b-instruct-2507-q4_k_m.gguf. Положите модель в models/ (см. deploy/README.md, раздел «Офлайн-комплект»)."
  docker image inspect arm112-llm:0.1.0 >/dev/null 2>&1 ||
    fail "--ai local: нет образа arm112-llm:0.1.0. Соберите его: uv run --package arm112-scripts python deploy/offline.py (см. deploy/offline.py, LLM_SOURCE)."
  PROFILE_ARGS="$PROFILE_ARGS --profile llm"
  UP_SERVICES="$UP_SERVICES llm"
  export AI_PROVIDER=local
else
  export AI_PROVIDER=off
fi

if [ "$STT_MODE" = local ]; then
  PROFILE_ARGS="$PROFILE_ARGS --profile stt"
  UP_SERVICES="$UP_SERVICES stt"
  export STT_PROVIDER=local
else
  export STT_PROVIDER=off
fi

cat >"$OVERRIDE_FILE" <<EOF
# Автогенерируется up.sh для проекта $PROJECT — не редактируйте вручную.
services:
  migrate:
    image: arm112-api:$PROJECT
  api:
    image: arm112-api:$PROJECT
  worker:
    image: arm112-api:$PROJECT
  certs:
    image: arm112-api:$PROJECT
  web:
    image: arm112-web:$PROJECT
    ports: !override ['$WEB_BIND:$HTTP_PORT:80', '$WEB_BIND:$HTTPS_PORT:443']
  stt:
    image: arm112-stt:$PROJECT
EOF

compose() {
  docker compose -p "$PROJECT" -f deploy/docker-compose.yml -f "$OVERRIDE_FILE" --env-file "$ENV_FILE" "$@"
}

step() { # $1 подпись для человека, дальше — команда
  label="$1"
  shift
  echo "→ $label"
  if ! "$@" >/tmp/stand-up-$$.log 2>&1; then
    echo "ошибка: шаг «${label}» не выполнен" >&2
    tail -n 40 "/tmp/stand-up-$$.log" >&2
    rm -f "/tmp/stand-up-$$.log"
    exit 1
  fi
  rm -f "/tmp/stand-up-$$.log"
}

cert_has_ip() { # $1 том с сертификатом, $2 IP — 0, если IP уже в SAN сертификата
  docker run --rm --user 0:0 -v "$1:/certs:ro" "arm112-api:$PROJECT" python -c '
import ipaddress
import sys

from cryptography import x509

try:
    data = open("/certs/server.crt", "rb").read()
except FileNotFoundError:
    sys.exit(1)
cert = x509.load_pem_x509_certificate(data)
try:
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
except x509.ExtensionNotFound:
    sys.exit(1)
target = ipaddress.ip_address(sys.argv[1])
sys.exit(0 if target in san.get_values_for_type(x509.IPAddress) else 1)
' "$2" >/dev/null 2>&1
}

# shellcheck disable=SC2086
# У migrate, api, worker и certs один образ и одинаковая сборка: общий `compose build`
# собирал бы его четыре раза параллельно, и сборки сталкивались на теге («image …
# already exists»). Каждый образ — один раз: api, web и stt, если включён.
BUILD_SERVICES="api web"
[ "$STT_MODE" = local ] && BUILD_SERVICES="$BUILD_SERVICES stt"
if [ "$NO_BUILD" -eq 1 ]; then
  for service in $BUILD_SERVICES; do
    image="arm112-$service:$PROJECT"
    docker image inspect "$image" >/dev/null 2>&1 ||
      fail "--no-build: нет образа $image. Соберите его на другой машине и перенесите: docker save $image | ssh <сервер> docker load"
  done
  echo "ok  образы готовые, сборку пропускаю"
else
  step "сборка образов" compose $PROFILE_ARGS build $BUILD_SERVICES
fi

if [ "$LAN" -eq 1 ]; then
  CERT_VOLUME="${PROJECT}_cert-data"
  if docker volume inspect "$CERT_VOLUME" >/dev/null 2>&1 && ! cert_has_ip "$CERT_VOLUME" "$LAN_IP"; then
    echo "→ адрес $LAN_IP не в сертификате проекта — пересоздаю том сертификатов (том базы данных не трогаю)"
    compose rm -s -f certs web >/dev/null 2>&1 || true
    # Очищаем содержимое тома, не удаляя сам том (docker volume rm запрещён предохранителем):
    # make_ca.py создаёт новый сертификат, только если server.crt отсутствует.
    docker run --rm --user 0:0 -v "$CERT_VOLUME:/certs" "arm112-api:$PROJECT" sh -c 'rm -f /certs/*' ||
      fail "не удалось очистить том сертификатов $CERT_VOLUME"
  fi
fi

step "запуск базы данных" compose up -d --wait db
step "миграции" compose run --rm --no-deps migrate
step "справочники и сценарии (seed)" compose run --rm --no-deps api python -m app.seed
step "учебные бригады и доклады (seed.training)" compose run --rm --no-deps api python -m app.seed.training
# shellcheck disable=SC2086
step "запуск $UP_SERVICES" compose $PROFILE_ARGS up -d --wait $UP_SERVICES

echo "→ жду готовности /api/health (до 3 минут)"
ready=0
i=0
while [ "$i" -lt 36 ]; do
  status="$(curl -sk --max-time 3 "https://127.0.0.1:$HTTPS_PORT/api/health" 2>/dev/null | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("status",""))
except Exception:
    print("")' 2>/dev/null)"
  if [ "$status" = ok ]; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 5
done
[ "$ready" -eq 1 ] || fail "стенд не ответил status=ok за 3 минуты на https://127.0.0.1:$HTTPS_PORT/api/health. Проверьте: docker compose -p $PROJECT logs api"

echo ""
echo "Стенд готов: https://localhost:$HTTPS_PORT/app/login"
if [ "$LAN" -eq 1 ]; then
  echo "Адрес для других компьютеров сети: https://$LAN_IP:$HTTPS_PORT/app/login"
fi
echo "Учётные записи (пароль: $DEMO_PASSWORD):"
echo "  admin, teacher, trainee01, trainee02, trainee03, trainee04, trainee05"
