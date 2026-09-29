#!/usr/bin/env bash
# Замеры C-09 одной командой: свежий изолированный стенд → нагрузка → отчёт → уборка.
#
#   bash qa/bench/run.sh            # полный прогон без ИИ (~10–15 мин)
#   bash qa/bench/run.sh --llm      # плюс ИИ-судья (нужен models/*.gguf, см. README)
#   bash qa/bench/run.sh --quick    # короткая отладка на слабой машине
#
# Флаги: --no-build (взять готовые образы arm112-*:$BENCH_TAG), --keep (не гасить стенд),
# любые другие аргументы передаются в bench.py (например --cards 5).
# Рабочий стенд arm112 и его тома не трогаются: проект arm112-bench, свои порты и тома.
set -euo pipefail
cd "$(dirname "$0")/../.."

LLM=0 NO_BUILD=0 KEEP=0 QUICK=0
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --llm) LLM=1 ;;
    --no-build) NO_BUILD=1 ;;
    --keep) KEEP=1 ;;
    --quick) QUICK=1 ;;
    *) EXTRA+=("$arg") ;;
  esac
done

export COMPOSE_PROJECT_NAME=arm112-bench
export API_MODE=database
export JWT_SECRET=bench-isolated-secret-not-for-production-use
export DEMO_PASSWORD=bench-demo-local
export BENCH_TAG="${BENCH_TAG:-bench}"
export AI_PROVIDER=off
BENCH_PASSWORD=bench-user-local
HOST="${HOSTNAME:-$(uname -n)}"
MODEL_FILE="${LLM_MODEL_FILE:-models/qwen3-4b-instruct-2507-q4_k_m.gguf}"
LLM_IMAGE_SOURCE="ghcr.io/ggml-org/llama.cpp:server@sha256:9dc0a0f4080b7817c9592b19c03a4f4b0be92fd701076b9da259ff941dc5bf91"

C=(docker compose -f compose.yaml -f qa/bench/bench.compose.yml)
if [ "$LLM" = 1 ]; then
  export AI_PROVIDER=local
  # Путь для compose — относительно deploy/.
  export LLM_MODEL_FILE="../$MODEL_FILE"
  C+=(--profile llm)
fi

say() { printf '\n== %s\n' "$*"; }

say "Проверка машины"
docker info >/dev/null 2>&1 || { echo "Docker не запущен."; exit 1; }
CPU=$(lscpu 2>/dev/null | sed -n 's/^\(Model name\|Имя модели\):\s*//p' | head -1)
CORES=$(nproc 2>/dev/null || echo "?")
RAM=$(awk '/MemTotal/ {printf "%.1f ГБ ОЗУ", $2/1048576}' /proc/meminfo 2>/dev/null || echo "?")
OS=$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr)
DOCKER=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "?")
FREE_GB=$(df -Pk . | awk 'NR==2 {printf "%d", $4/1048576}')
echo "CPU: ${CPU:-?} (${CORES} потоков) · ${RAM} · ${OS} · Docker ${DOCKER} · свободно на диске ${FREE_GB} ГБ"
[ "${FREE_GB:-0}" -lt 4 ] && echo "ВНИМАНИЕ: на диске меньше 4 ГБ — сборка образов может упасть."
HOST_JSON=$(printf '{"cpu":"%s (%s потоков)","ram":"%s","os":"%s","docker":"%s"}' \
  "${CPU:-?}" "$CORES" "$RAM" "$OS" "$DOCKER")

if [ "$LLM" = 1 ]; then
  [ -f "$MODEL_FILE" ] || { echo "Нет файла модели $MODEL_FILE — см. qa/bench/README.md."; exit 1; }
  if ! docker image inspect arm112-llm:0.1.0 >/dev/null 2>&1; then
    say "Образ llama.cpp (зафиксированный digest)"
    docker pull "$LLM_IMAGE_SOURCE" && docker tag "$LLM_IMAGE_SOURCE" arm112-llm:0.1.0
  fi
fi

if [ "$NO_BUILD" = 0 ]; then
  say "Сборка образов arm112-*:${BENCH_TAG}"
  "${C[@]}" build api web
fi

say "Свежий стенд arm112-bench"
"${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${C[@]}" up -d --wait db
"${C[@]}" up -d --wait migrate
# Compose может считать одноразовый сервис готовым до завершения Alembic.
# Seed запускается только после успешного выхода процесса миграции.
MIGRATE_ID=$("${C[@]}" ps -aq migrate)
[ -n "$MIGRATE_ID" ] || { echo "Контейнер миграции не найден."; exit 1; }
MIGRATE_STATUS=$(docker wait "$MIGRATE_ID")
if [ "$MIGRATE_STATUS" != 0 ]; then
  "${C[@]}" logs migrate
  echo "Миграция завершилась с кодом $MIGRATE_STATUS."
  exit 1
fi
"${C[@]}" run --rm --no-deps api python -m app.seed
"${C[@]}" run --rm --no-deps api python -m app.seed.training
"${C[@]}" run --rm --no-deps -v "$PWD/qa/bench:/workspace/qa/bench" api \
  python qa/bench/seed_users.py --count 100 --password "$BENCH_PASSWORD"
SERVICES=(api worker web)
[ "$LLM" = 1 ] && SERVICES+=(llm)
"${C[@]}" up -d --wait --wait-timeout 600 "${SERVICES[@]}"

ARGS=()
[ "$QUICK" = 1 ] && ARGS+=(--cards 1 --burst 10 --crowd 30 --crowd-active 10 --settle 5)
[ "$LLM" = 1 ] && ARGS+=(--llm)
mkdir -p qa/bench/results

say "Замеры"
set +e
"${C[@]}" run --rm --no-deps --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD/qa/bench:/workspace/qa/bench" api \
  python qa/bench/bench.py --base https://web --label "$HOST" \
  --demo-password "$DEMO_PASSWORD" --bench-password "$BENCH_PASSWORD" \
  --host-info "$HOST_JSON" "${ARGS[@]}" "${EXTRA[@]}"
STATUS=$?
set -e

# NFR-8 требует от самой БД ≥ 100 записей/с: pgbench пишет по одной строке в отдельной
# транзакции с 8 соединений 15 с. Путь через API (выше) ограничен задержкой запроса.
if [ "$STATUS" = 0 ]; then
  say "Запись в PostgreSQL (pgbench)"
  DB_ARGS=(exec -T db sh -c)
  "${C[@]}" "${DB_ARGS[@]}" "psql -U \${POSTGRES_USER:-arm112} -d \${POSTGRES_DB:-arm112} -qc 'create table bench_writes(id bigserial primary key, card_id uuid not null, payload jsonb not null, created_at timestamptz not null default now()); create index on bench_writes(card_id, created_at);'"
  PG=$("${C[@]}" "${DB_ARGS[@]}" "echo \"insert into bench_writes(card_id, payload) values (gen_random_uuid(), '{\\\"type\\\":\\\"field_change\\\"}');\" > /tmp/w.sql && pgbench -U \${POSTGRES_USER:-arm112} -d \${POSTGRES_DB:-arm112} -n -f /tmp/w.sql -c 8 -j 4 -T 15 2>&1" | awk '/^tps = / {printf "%.0f", $3}')
  echo "PostgreSQL: ${PG:-?} записей/с"
  REPORT=$(ls -td qa/bench/results/"$HOST"-*/ 2>/dev/null | head -1)
  if [ -n "$REPORT" ] && [ -n "$PG" ]; then
    "${C[@]}" run --rm --no-deps --user "$(id -u):$(id -g)" -e HOME=/tmp \
      -v "$PWD/qa/bench:/workspace/qa/bench" api \
      python qa/bench/finalize.py "$REPORT" "$PG"
  else
    echo "Не удалось сохранить результат pgbench."
    STATUS=1
  fi
fi

if [ "$STATUS" != 0 ]; then
  say "Замер упал — логи сервисов в qa/bench/results/compose-$HOST.log"
  "${C[@]}" logs --no-color > "qa/bench/results/compose-$HOST.log" 2>&1 || true
fi
if [ "$KEEP" = 0 ]; then
  say "Уборка стенда arm112-bench"
  "${C[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
fi
exit "$STATUS"
