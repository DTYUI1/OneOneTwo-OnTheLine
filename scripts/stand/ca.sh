#!/usr/bin/env bash
# Достаёт корневой сертификат стенда из тома сертификатов проекта и печатает, как
# доверить его в ОС/браузере — чтобы у обучаемых не было "Не защищено".
set -uo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

PROJECT=arm112-stand

usage() {
  cat <<'EOF'
Использование: scripts/stand/ca.sh [--project ИМЯ]

  --project ИМЯ   имя проекта Docker Compose (по умолчанию arm112-stand)
  --help          эта справка

Кладёт корневой сертификат в scripts/stand/.local/<проект>/ca.crt и печатает
инструкции, как доверить его на macOS, Windows и Linux/Firefox.
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
OUT_FILE="$LOCAL_DIR/ca.crt"
VOLUME="${PROJECT}_cert-data"

docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || fail "нет тома сертификатов $VOLUME — стенд этим скриптом не поднимался. Совет: scripts/stand/up.sh --project $PROJECT"

mkdir -p "$LOCAL_DIR"

if ! docker run --rm --user 0:0 -v "$VOLUME:/certs:ro" busybox cat /certs/ca.crt >"$OUT_FILE" 2>/dev/null; then
  rm -f "$OUT_FILE"
  fail "не удалось прочитать ca.crt из тома $VOLUME — стенд поднят, но сертификаты ещё не выпущены (docker compose -p $PROJECT logs certs)"
fi

echo "Корневой сертификат: $OUT_FILE"
echo ""
cat <<EOF
Как довериться сертификату:

  macOS:
    sudo security add-trusted-cert -d -r trustRoot \\
      -k /Library/Keychains/System.keychain "$OUT_FILE"

  Windows (PowerShell от администратора):
    certutil -addstore -f Root "$OUT_FILE"
    (или deploy/certs/install-ca.ps1 -CertificatePath "$OUT_FILE")

  Linux (Ubuntu/Debian):
    sh deploy/certs/install-ca.sh "$OUT_FILE"

  Firefox (своё хранилище сертификатов, отдельно от ОС):
    настройки → Приватность и защита → Сертификаты → Просмотр сертификатов →
    Центры сертификации → Импортировать → выбрать "$OUT_FILE" →
    отметить "Доверять при идентификации веб-сайтов".

После доверия перезапустите браузер и откройте адрес стенда снова.
EOF
