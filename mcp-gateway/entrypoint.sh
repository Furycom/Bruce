#!/bin/sh
# entrypoint.sh — Attend que server.js soit syntaxiquement valide avant de lancer Node
# Fix race condition: bind mount server.js peut être lu partiellement pendant un rebuild/edit
MAX_RETRIES=10
RETRY_DELAY=2
RETRY=0

echo "[entrypoint] Checking server.js syntax before start..."

while [ $RETRY -lt $MAX_RETRIES ]; do
  if node --check /app/server.js 2>/dev/null; then
    echo "[entrypoint] server.js syntax OK — starting gateway"
    exec node /app/server.js
  fi
  RETRY=$((RETRY + 1))
  echo "[entrypoint] server.js syntax check failed (attempt $RETRY/$MAX_RETRIES) — retrying in ${RETRY_DELAY}s..."
  sleep $RETRY_DELAY
done

echo "[entrypoint] FATAL: server.js still invalid after $MAX_RETRIES attempts — aborting"
exit 1