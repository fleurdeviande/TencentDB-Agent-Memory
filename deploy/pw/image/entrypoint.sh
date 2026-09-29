#!/bin/sh
# agent-memory image entrypoint: `core` = MemoryCore gateway, `knowledge` = MemoryKnowledge.
set -eu

role="${1:-}"
[ $# -gt 0 ] && shift

case "$role" in
  core)
    cd /app/core
    # Upstream runs the gateway from source; tsx is a runtime dependency.
    exec node --import tsx src/gateway/server.ts "$@"
    ;;
  knowledge)
    cd /app/knowledge
    mkdir -p "${KNOWLEDGE_DATA_DIR:-/data/knowledge}"
    exec node dist/server.mjs "$@"
    ;;
  *)
    echo "usage: <image> core|knowledge" >&2
    exit 64
    ;;
esac
