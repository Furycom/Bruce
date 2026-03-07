#!/usr/bin/env bash
set -euo pipefail

cd /home/furycom/mcp-stack

mkdir -p tools/rag/_runs

TS="$(date +%Y%m%d_%H%M%S)"
LOG="tools/rag/_runs/run_${TS}.log"

# Safe defaults (can be overridden by env)
export GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:4000}"
export EMBEDDER_URL="${EMBEDDER_URL:-http://192.168.2.85:8081}"

# Token: prefer already-provided BRUCE_TOKEN; otherwise extract from container env (do not print)
if [ -z "${BRUCE_TOKEN:-}" ]; then
  BRUCE_TOKEN="$(docker exec mcp-gateway sh -lc 'printf %s "$BRUCE_AUTH_TOKEN"' 2>/dev/null || true)"
  export BRUCE_TOKEN
fi

LIMIT="${1:-50}"
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  LIMIT=50
fi

python3 tools/rag/bruce_rag_embed.py --limit "$LIMIT" >"$LOG" 2>&1 || true

echo "OK: log => $LOG"
echo "---- tail (max 60 lines) ----"
tail -n 60 "$LOG" || true
