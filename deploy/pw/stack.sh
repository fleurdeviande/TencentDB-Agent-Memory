#!/usr/bin/env bash
# pw local stack: Postgres (container) + MemoryCore + MemoryKnowledge from source, everything durable in Postgres.
# Usage: deploy/pw/stack.sh up | down | status | admin <username>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RUN="$HERE/.run"
ENV_FILE="$HERE/.env.local"
mkdir -p "$RUN"

rand() { node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))'; }

# Secrets and endpoints live in .env.local (gitignored); created once, then edited by hand if needed.
if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  cat >"$ENV_FILE" <<EOF
POSTGRES_URL=postgres://tdai:tdai-dev@127.0.0.1:55432/tdai
KNOWLEDGE_DB_URL=postgres://tdai:tdai-dev@127.0.0.1:55432/tdai_knowledge
TDAI_GATEWAY_API_KEY=$(rand)
KNOWLEDGE_SERVICE_KEY=$(rand)
KNOWLEDGE_SECRET_KEY=$(rand)
# GLM on r4-ai-01 (SGLang, keyless); IP because the laptop's VPN DNS is flaky.
TDAI_LLM_BASE_URL=http://172.16.4.175:30001/v1
TDAI_LLM_API_KEY=EMPTY
TDAI_LLM_MODEL=glm-5.3-flash
TDAI_EMBEDDING_BASE_URL=https://ollama.corp.pushwoosh.com/v1
TDAI_EMBEDDING_API_KEY=ollama
TDAI_EMBEDDING_MODEL=embeddinggemma:latest
CORE_PORT=8420
KNOWLEDGE_PORT=8424
EOF
  echo "created $ENV_FILE"
fi
set -a; source "$ENV_FILE"; set +a

node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 22 ? 0 : 1)' \
  || { echo "Node 22 required (nvm use 22), got $(node -v)" >&2; exit 1; }

wait_health() { for _ in $(seq 1 90); do curl -sf "$1/health" >/dev/null && return 0; sleep 1; done; return 1; }

up() {
  docker compose -f "$HERE/docker-compose.dev.yml" up -d >/dev/null
  until docker inspect -f '{{.State.Health.Status}}' pw-tdai-postgres 2>/dev/null | grep -q healthy; do sleep 1; done

  # Data dirs exist only because the services expect a path; in postgres mode they stay empty.
  mkdir -p "$RUN/core-data" "$RUN/kn-data" "$RUN/log"

  (cd "$ROOT/MemoryCore" && \
    TDAI_GATEWAY_CONFIG="$HERE/tdai-gateway.pw.yaml" TDAI_GATEWAY_PORT="$CORE_PORT" TDAI_DATA_DIR="$RUN/core-data" \
    STORE_MODE=postgres TDAI_GATEWAY_SHARED_KEY_MODE=off LOG_PATH="$RUN/log" \
    nohup node --import tsx src/gateway/server.ts </dev/null >"$RUN/log/core.out" 2>&1 & echo $! >"$RUN/core.pid")

  (cd "$ROOT/MemoryKnowledge" && \
    PORT="$KNOWLEDGE_PORT" KNOWLEDGE_DATA_DIR="$RUN/kn-data" \
    LLM_MODE=custom LLM_BASE_URL="$TDAI_LLM_BASE_URL" LLM_API_KEY="$TDAI_LLM_API_KEY" LLM_MODEL="$TDAI_LLM_MODEL" \
    LLM_MAX_TOKENS=16384 LLM_TIMEOUT_MS=300000 LOG_LEVEL=info \
    nohup ./node_modules/.bin/tsx src/server.ts </dev/null >"$RUN/log/knowledge.out" 2>&1 & echo $! >"$RUN/knowledge.pid")

  wait_health "http://127.0.0.1:$CORE_PORT" || { echo "MemoryCore did not come up, see $RUN/log/core.out" >&2; exit 1; }
  wait_health "http://127.0.0.1:$KNOWLEDGE_PORT" || { echo "MemoryKnowledge did not come up, see $RUN/log/knowledge.out" >&2; exit 1; }
  status
}

down() {
  for s in core knowledge; do
    # tsx re-execs node as a child, so killing the recorded pid alone leaves the port bound.
    if [[ -f "$RUN/$s.pid" ]]; then
      pid="$(cat "$RUN/$s.pid")"
      pkill -P "$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$RUN/$s.pid"
  done
  echo "services stopped (Postgres container left running: docker compose -f $HERE/docker-compose.dev.yml stop)"
}

status() {
  echo "MemoryCore  http://127.0.0.1:$CORE_PORT  $(curl -s "http://127.0.0.1:$CORE_PORT/health" | head -c 200)"
  echo "Knowledge   http://127.0.0.1:$KNOWLEDGE_PORT  $(curl -s "http://127.0.0.1:$KNOWLEDGE_PORT/health" | head -c 200)"
}

# Create a personal key for a user through the gateway's internal bootstrap route; prints the key once.
admin() {
  local name="${1:?username}" key
  key="sk-mem-$(rand)"
  curl -sf -X POST "http://127.0.0.1:$CORE_PORT/v3/internal/meta/user/init-admin" \
    -H "Authorization: Bearer $TDAI_GATEWAY_API_KEY" -H "x-tdai-service-id: default" -H "Content-Type: application/json" \
    -d "{\"username\":\"$name\",\"user_key\":\"$key\"}" >"$RUN/init-admin-$name.json"
  echo "$key"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  admin) admin "${2:-}" ;;
  *) echo "usage: $0 up|down|status|admin <username>" >&2; exit 2 ;;
esac
