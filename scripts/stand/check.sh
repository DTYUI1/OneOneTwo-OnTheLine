#!/usr/bin/env bash
# Диагностика стенда, поднятого up.sh: одна команда — понятные "ok"/"ошибка" по каждому
# пункту и совет, что делать. Ничего не поднимает и не останавливает, только смотрит.
set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

PROJECT=arm112-stand
IP_OVERRIDE=""
ERR=0

usage() {
  cat <<'EOF'
Использование: scripts/stand/check.sh [--project ИМЯ] [--ip АДРЕС]

  --project ИМЯ   имя проекта Docker Compose (по умолчанию arm112-stand)
  --ip АДРЕС      IP машины (вместо автоопределения) — проверить именно его
  --help          эта справка

Код выхода: 0 — всё в порядке, 1 — есть ошибки.
EOF
}

fail() {
  echo "ошибка: $1" >&2
  exit 1
}

ok_line() { # $1 текст
  echo "ok  $1"
}

err_line() { # $1 текст, $2 совет
  echo "ошибка  $1 — совет: $2"
  ERR=1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      PROJECT="${2:-}"
      [ -n "$PROJECT" ] || fail "--project требует имя"
      shift 2
      ;;
    --ip)
      IP_OVERRIDE="${2:-}"
      [ -n "$IP_OVERRIDE" ] || fail "--ip требует значение"
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

compose() {
  docker compose -p "$PROJECT" -f deploy/docker-compose.yml -f "$OVERRIDE_FILE" --env-file "$ENV_FILE" "$@"
}

PORT_INFO="$(python3 - "$OVERRIDE_FILE" <<'PY'
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
        print(parts[0])
        print(parts[1])
        break
PY
)"
[ -n "$PORT_INFO" ] || fail "не удалось прочитать порты web из $OVERRIDE_FILE"
WEB_BIND="$(echo "$PORT_INFO" | sed -n '1p')"
HTTPS_PORT="$(echo "$PORT_INFO" | sed -n '2p')"

echo "Проект: $PROJECT, порт https: $HTTPS_PORT, адрес привязки web: $WEB_BIND"
echo ""

# --- 1. Контейнеры проекта и их health ---------------------------------------------------
ONESHOT_SERVICES=" migrate certs "
CONTAINERS_OUT="$(compose ps -a --format '{{.Name}}|{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null)"
if [ -z "$CONTAINERS_OUT" ]; then
  err_line "контейнеры проекта $PROJECT не найдены" "запустите scripts/stand/up.sh --project $PROJECT"
else
  while IFS='|' read -r name service state health exitcode; do
    [ -n "$name" ] || continue
    case "$ONESHOT_SERVICES" in
      *" $service "*)
        if [ "$exitcode" = "0" ]; then
          ok_line "контейнер $name (разовая задача $service) завершился успешно"
        else
          err_line "контейнер $name (разовая задача $service) завершился с кодом $exitcode" "смотрите логи: docker compose -p $PROJECT logs $service"
        fi
        ;;
      *)
        if [ "$state" != running ]; then
          err_line "контейнер $name не запущен (состояние: $state)" "запустите scripts/stand/up.sh --project $PROJECT и посмотрите логи: docker compose -p $PROJECT logs $service"
        elif [ -n "$health" ] && [ "$health" != healthy ]; then
          err_line "контейнер $name нездоров (health: $health)" "посмотрите логи: docker compose -p $PROJECT logs $service"
        else
          ok_line "контейнер $name работает (состояние: $state${health:+, health: $health})"
        fi
        ;;
    esac
  done <<EOF
$CONTAINERS_OUT
EOF
fi
echo ""

# --- 2. /api/health локально --------------------------------------------------------------
HEALTH_JSON="$(curl -sk --max-time 5 "https://127.0.0.1:$HTTPS_PORT/api/health" 2>/dev/null)"
HEALTH_STATUS="$(echo "$HEALTH_JSON" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d.get("status", ""), d.get("mode", ""))
except Exception:
    print("", "")' 2>/dev/null)"
HS_STATUS="${HEALTH_STATUS%% *}"
HS_MODE="${HEALTH_STATUS#* }"
if [ "$HS_STATUS" = ok ]; then
  ok_line "/api/health на 127.0.0.1:$HTTPS_PORT — status ok, mode $HS_MODE"
else
  err_line "/api/health на 127.0.0.1:$HTTPS_PORT не отвечает status=ok" "проверьте контейнер api: docker compose -p $PROJECT logs api"
fi
echo ""

# --- 3. Кто слушает порт на хосте ----------------------------------------------------------
LISTENER=""
if command -v lsof >/dev/null 2>&1; then
  LISTENER="$(lsof -nP -iTCP:"$HTTPS_PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1"/"$2}')"
elif command -v ss >/dev/null 2>&1; then
  LISTENER="$(ss -ltnp 2>/dev/null | awk -v p=":$HTTPS_PORT" '$4 ~ p {print; exit}')"
elif command -v netstat >/dev/null 2>&1; then
  LISTENER="$(netstat -an 2>/dev/null | awk -v p=".$HTTPS_PORT" '$0 ~ p && $0 ~ /LISTEN/ {print; exit}')"
fi
if [ -n "$LISTENER" ]; then
  ok_line "порт $HTTPS_PORT на хосте слушает: $LISTENER"
else
  err_line "порт $HTTPS_PORT на хосте никто не слушает" "проверьте, поднят ли контейнер web: docker compose -p $PROJECT ps"
fi
echo ""

# --- 4. IP машины и сертификат --------------------------------------------------------------
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

if [ -n "$IP_OVERRIDE" ]; then
  LAN_IP="$IP_OVERRIDE"
else
  LAN_IP="$(detect_ip)"
fi

if [ -z "$LAN_IP" ]; then
  err_line "не удалось определить IP машины автоматически" "задайте вручную: scripts/stand/check.sh --project $PROJECT --ip АДРЕС"
elif ! docker image inspect "arm112-api:$PROJECT" >/dev/null 2>&1; then
  err_line "нет образа arm112-api:$PROJECT — сертификат не проверить" "соберите образ: scripts/stand/up.sh --project $PROJECT"
else
  CERT_HAS_IP="$(docker run --rm --user 0:0 -v "${PROJECT}_cert-data:/certs:ro" "arm112-api:$PROJECT" python -c '
import ipaddress
import sys

from cryptography import x509

try:
    data = open("/certs/server.crt", "rb").read()
except FileNotFoundError:
    print("no-cert")
    sys.exit(0)
cert = x509.load_pem_x509_certificate(data)
try:
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
except x509.ExtensionNotFound:
    print("no-san")
    sys.exit(0)
target = ipaddress.ip_address(sys.argv[1])
print("yes" if target in san.get_values_for_type(x509.IPAddress) else "no")
' "$LAN_IP" 2>/dev/null)"
  case "$CERT_HAS_IP" in
    yes) ok_line "IP машины $LAN_IP есть в сертификате" ;;
    no) err_line "IP машины $LAN_IP не в сертификате" "переподнимите стенд с этим адресом: scripts/stand/up.sh --project $PROJECT --ip $LAN_IP" ;;
    no-cert) err_line "сертификат не найден в томе ${PROJECT}_cert-data" "запустите scripts/stand/up.sh --project $PROJECT" ;;
    *) err_line "не удалось проверить сертификат" "запустите scripts/stand/up.sh --project $PROJECT" ;;
  esac
fi
echo ""

# --- 5. Открывается ли https://<IP>:<порт>/api/health с этой машины -----------------------
if [ -n "$LAN_IP" ]; then
  LAN_HEALTH_JSON="$(curl -sk --max-time 5 "https://$LAN_IP:$HTTPS_PORT/api/health" 2>/dev/null)"
  LAN_STATUS="$(echo "$LAN_HEALTH_JSON" | python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get("status", ""))
except Exception:
    print("")' 2>/dev/null)"
  if [ "$LAN_STATUS" = ok ]; then
    ok_line "https://$LAN_IP:$HTTPS_PORT/api/health отвечает status=ok"
  elif [ "$WEB_BIND" = 127.0.0.1 ]; then
    err_line "https://$LAN_IP:$HTTPS_PORT/api/health не отвечает" "стенд поднят только для этой машины (WEB_BIND=127.0.0.1) — переподнимите с --lan: scripts/stand/up.sh --project $PROJECT --lan"
  else
    err_line "https://$LAN_IP:$HTTPS_PORT/api/health не отвечает" "проверьте firewall и подключены ли компьютеры к одной сети"
  fi
else
  err_line "проверка https://<IP>:$HTTPS_PORT/api/health пропущена" "IP машины не определён, задайте --ip АДРЕС"
fi
echo ""

# --- 6. macOS: брандмауэр -------------------------------------------------------------------
if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  FW_STATE="$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>/dev/null)"
  case "$FW_STATE" in
    *disabled*) ok_line "брандмауэр macOS выключен" ;;
    *enabled*) ok_line "брандмауэр macOS включён (совет: если с других компьютеров не открывается — разрешите входящие соединения для Docker в Системные настройки → Конфиденциальность и безопасность → Брандмауэр)" ;;
    *) ok_line "состояние брандмауэра macOS не определено ($FW_STATE)" ;;
  esac
  echo ""
fi

# --- 7. colima: проброс порта ----------------------------------------------------------------
if command -v colima >/dev/null 2>&1; then
  if colima status >/dev/null 2>&1; then
    ok_line "colima запущена — порты Docker уже проброшены на хост через её VM, отдельная настройка не нужна"
  else
    ok_line "colima установлена, но не запущена (docker может использовать другой движок)"
  fi
  echo ""
fi

cat <<EOF
Если с другого компьютера не открывается, проверьте по порядку:
  1. оба компьютера в одной подсети;
  2. в адресе указаны https:// и порт: https://$LAN_IP:$HTTPS_PORT/app/login;
  3. Wi-Fi не гостевая сеть с изоляцией клиентов (изоляция клиентов блокирует связь
     между устройствами одной сети);
  4. на компьютере обучаемого установлен CA-сертификат стенда: deploy/certs/install-ca.sh
     (Ubuntu) или install-ca.ps1 (Windows), см. deploy/README.md, раздел «Локальный CA».
EOF

exit "$ERR"
