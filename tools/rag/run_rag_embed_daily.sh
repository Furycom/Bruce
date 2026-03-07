#!/usr/bin/env bash

BASE_DIR="/home/furycom/mcp-stack"
RUNS_DIR="$BASE_DIR/tools/rag/_runs"
mkdir -p "$RUNS_DIR"

# Load env (SUPABASE_* etc.)
set -a
. "$BASE_DIR/.env"
set +a

# Read real gateway auth token from container (do not print)
BRUCE_TOKEN="$(docker exec mcp-gateway sh -lc 'printf %s "$BRUCE_AUTH_TOKEN"' 2>/dev/null | tr -d '\r\n')"
if [ -z "$BRUCE_TOKEN" ]; then
  echo "ERROR: BRUCE_TOKEN empty (cannot read BRUCE_AUTH_TOKEN from mcp-gateway). abort."
  exit 12
fi
export BRUCE_TOKEN

# -------------------------
# Guardrails (anti-salissage)
# -------------------------

# Hard whitelist: ingest ONLY the ops subset synced by sync_manual_docs_for_ingest.sh
export MANUAL_DOCS_DIR="/home/furycom/mcp-manual/docs/operations"

# Default: DO NOT ingest journal (it can re-salir RAG if journal contains big/noisy content)
BRUCE_RAG_INGEST_JOURNAL="${BRUCE_RAG_INGEST_JOURNAL:-0}"

# Clamp embed limit (1..500)
BRUCE_EMBED_LIMIT="${BRUCE_EMBED_LIMIT:-200}"
case "$BRUCE_EMBED_LIMIT" in
  ''|*[!0-9]*) BRUCE_EMBED_LIMIT=200 ;;
esac
if [ "$BRUCE_EMBED_LIMIT" -lt 1 ]; then BRUCE_EMBED_LIMIT=1; fi
if [ "$BRUCE_EMBED_LIMIT" -gt 500 ]; then BRUCE_EMBED_LIMIT=500; fi
export BRUCE_EMBED_LIMIT

TS="$(date -u +%Y%m%d_%H%M%S)"
LOG="$RUNS_DIR/daily_${TS}.log"

EXIT_CODE=0

run_step() {
  local label="$1"
  shift
  echo "=== ${label} ==="
  "$@"
  local rc=$?
  echo "rc=${rc}"
  echo
  return "$rc"
}

{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) START daily ingest+embed ==="
  echo "host=$(hostname)"
  echo
  echo "=== GUARDRAILS ==="
  echo "MANUAL_DOCS_DIR=${MANUAL_DOCS_DIR}"
  echo "BRUCE_RAG_INGEST_JOURNAL=${BRUCE_RAG_INGEST_JOURNAL}"
  echo "BRUCE_EMBED_LIMIT=${BRUCE_EMBED_LIMIT}"
  echo

  run_step "SYNC source-of-truth manual-docs -> mcp-manual/docs/operations" \
    "$BASE_DIR/tools/rag/sync_manual_docs_for_ingest.sh" || EXIT_CODE=$?

  if [ "$EXIT_CODE" -eq 0 ]; then
    run_step "INGEST manual-docs (ops whitelist only) -> bruce_docs/bruce_chunks" \
      python3 "$BASE_DIR/tools/rag/bruce_rag_ingest_manual_docs.py" || EXIT_CODE=$?
  fi

  if [ "$EXIT_CODE" -eq 0 ]; then
    if [ "$BRUCE_RAG_INGEST_JOURNAL" = "1" ]; then
      run_step "INGEST journal (explicit opt-in) -> bruce_docs/bruce_chunks" \
        python3 "$BASE_DIR/tools/rag/bruce_rag_ingest_journal.py" || EXIT_CODE=$?
    else
      echo "=== SKIP journal ingest (BRUCE_RAG_INGEST_JOURNAL != 1) ==="
      echo
    fi
  fi

  if [ "$EXIT_CODE" -eq 0 ]; then
    run_step "EMBED missing chunks -> bruce_embeddings" \
      python3 "$BASE_DIR/tools/rag/bruce_rag_embed.py" --limit "$BRUCE_EMBED_LIMIT" || EXIT_CODE=$?
  fi

  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) END ==="
  echo "exit_code=${EXIT_CODE}"
} >"$LOG" 2>&1

# Keep last 50 logs
ls -1t "$RUNS_DIR"/daily_*.log 2>/dev/null | tail -n +51 | xargs -r rm -f

# Optional ntfy alert (only if configured in env)
if [ "$EXIT_CODE" -ne 0 ]; then
  MSG="BRUCE RAG daily ingest+embed FAILED on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ). exit_code=${EXIT_CODE}. log=${LOG}"
  if [ -n "${NTFY_PUBLISH_URL:-}" ]; then
    curl -fsS -d "$MSG" "$NTFY_PUBLISH_URL" >/dev/null 2>&1 || true
  elif [ -n "${NTFY_URL:-}" ] && [ -n "${NTFY_TOPIC:-}" ]; then
    curl -fsS -d "$MSG" "${NTFY_URL%/}/${NTFY_TOPIC}" >/dev/null 2>&1 || true
  fi
fi

exit "$EXIT_CODE"
