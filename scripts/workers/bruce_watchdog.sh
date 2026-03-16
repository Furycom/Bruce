#!/bin/bash
# bruce_watchdog.sh — Watchdog services BRUCE
# Verifie systemd user services + docker containers
# MAJ [890] session 1085: tmux remplace par systemd user services
# Cron: */5 * * * * /home/furycom/bruce_watchdog.sh >> /home/furycom/logs/watchdog.log 2>&1

NTFY_URL="http://192.168.2.174:8080/bruce-alerts"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [WATCHDOG]"
ISSUES=0

# XDG_RUNTIME_DIR requis pour systemctl --user via cron
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

notify() {
    local title="$1"
    local msg="$2"
    local priority="${3:-default}"
    curl -s -X POST "$NTFY_URL" \
        -H "Title: $title" \
        -H "Priority: $priority" \
        -H "Tags: warning,robot" \
        -d "$msg" > /dev/null 2>&1
}

# ============================================================
# 1. SYSTEMD USER: bruce-embed-worker
# ============================================================
if ! systemctl --user is-active --quiet bruce-embed-worker.service 2>/dev/null; then
    echo "$LOG_PREFIX ALERTE: bruce-embed-worker inactif — relance"
    systemctl --user restart bruce-embed-worker.service 2>/dev/null
    sleep 3
    if systemctl --user is-active --quiet bruce-embed-worker.service 2>/dev/null; then
        echo "$LOG_PREFIX OK: bruce-embed-worker relance avec succes"
        notify "BRUCE Watchdog" "bruce-embed-worker relance avec succes sur .230" "default"
    else
        echo "$LOG_PREFIX ERREUR: bruce-embed-worker ECHEC relance"
        notify "BRUCE Watchdog CRITIQUE" "bruce-embed-worker ECHEC relance sur .230 — intervention manuelle requise" "high"
        ISSUES=$((ISSUES+1))
    fi
else
    echo "$LOG_PREFIX OK: bruce-embed-worker actif"
fi

# ============================================================
# 2. SYSTEMD USER: bruce-validate-svc
# ============================================================
if ! systemctl --user is-active --quiet bruce-validate-svc.service 2>/dev/null; then
    echo "$LOG_PREFIX ALERTE: bruce-validate-svc inactif — relance"
    systemctl --user restart bruce-validate-svc.service 2>/dev/null
    sleep 3
    if systemctl --user is-active --quiet bruce-validate-svc.service 2>/dev/null; then
        echo "$LOG_PREFIX OK: bruce-validate-svc relance avec succes"
        notify "BRUCE Watchdog" "bruce-validate-svc relance avec succes sur .230" "default"
    else
        echo "$LOG_PREFIX ERREUR: bruce-validate-svc ECHEC relance"
        notify "BRUCE Watchdog CRITIQUE" "bruce-validate-svc ECHEC relance sur .230 — intervention manuelle requise" "high"
        ISSUES=$((ISSUES+1))
    fi
else
    echo "$LOG_PREFIX OK: bruce-validate-svc actif"
fi

# ============================================================
# 3. DOCKER: mcp-gateway
# ============================================================
if ! docker ps --format '{{.Names}}' | grep -q '^mcp-gateway$'; then
    echo "$LOG_PREFIX ALERTE: container 'mcp-gateway' absent — relance"
    docker start mcp-gateway 2>/dev/null || docker compose -f /home/furycom/mcp-stack/docker-compose.yml up -d 2>/dev/null
    sleep 3
    if docker ps --format '{{.Names}}' | grep -q '^mcp-gateway$'; then
        echo "$LOG_PREFIX OK: mcp-gateway relance"
        notify "BRUCE Watchdog" "Container mcp-gateway relance sur .230" "default"
    else
        echo "$LOG_PREFIX ERREUR: mcp-gateway ECHEC relance"
        notify "BRUCE Watchdog CRITIQUE" "Container mcp-gateway ECHEC relance — intervention manuelle" "urgent"
        ISSUES=$((ISSUES+1))
    fi
else
    echo "$LOG_PREFIX OK: mcp-gateway actif"
fi

# ============================================================
# 4. DOCKER: litellm
# ============================================================
if ! docker ps --format '{{.Names}}' | grep -q '^litellm$'; then
    echo "$LOG_PREFIX ALERTE: container 'litellm' absent — relance"
    docker start litellm 2>/dev/null || docker compose -f /home/furycom/litellm-stack/docker-compose.yml up -d 2>/dev/null
    sleep 3
    if docker ps --format '{{.Names}}' | grep -q '^litellm$'; then
        echo "$LOG_PREFIX OK: litellm relance"
        notify "BRUCE Watchdog" "Container litellm relance sur .230" "default"
    else
        echo "$LOG_PREFIX ERREUR: litellm ECHEC relance"
        notify "BRUCE Watchdog CRITIQUE" "Container litellm ECHEC relance — intervention manuelle" "high"
        ISSUES=$((ISSUES+1))
    fi
else
    echo "$LOG_PREFIX OK: litellm actif"
fi

# ============================================================
# 5. HEALTH CHECK: validate_service port 4001
# ============================================================
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:4001/health 2>/dev/null)
if [ "$HTTP_CODE" != "200" ]; then
    echo "$LOG_PREFIX ALERTE: validate_service :4001 ne repond pas (HTTP $HTTP_CODE)"
    notify "BRUCE Watchdog" "validate_service :4001 ne repond pas (HTTP $HTTP_CODE)" "high"
    ISSUES=$((ISSUES+1))
else
    echo "$LOG_PREFIX OK: validate_service :4001 repond"
fi

# ============================================================
# 6. EMBEDDING GAP: chunks vs embeddings
# ============================================================
APIKEY="${SUPABASE_KEY}"
CHUNKS=$(curl -s --max-time 10 "http://192.168.2.146:8000/rest/v1/bruce_chunks?select=id&limit=0" -H "apikey: $APIKEY" -H "Authorization: Bearer $APIKEY" -H "Prefer: count=exact" -D - 2>/dev/null | grep -i "content-range" | cut -d"/" -f2 | tr -d "\r\n ")
EMBEDS=$(curl -s --max-time 10 "http://192.168.2.146:8000/rest/v1/bruce_embeddings?select=id&limit=0" -H "apikey: $APIKEY" -H "Authorization: Bearer $APIKEY" -H "Prefer: count=exact" -D - 2>/dev/null | grep -i "content-range" | cut -d"/" -f2 | tr -d "\r\n ")

if [ -n "$CHUNKS" ] && [ -n "$EMBEDS" ]; then
    DELTA=$(( CHUNKS - EMBEDS ))
    if [ "$DELTA" -lt 0 ]; then DELTA=$(( -DELTA )); fi
    echo "$LOG_PREFIX Embedding gap: chunks=$CHUNKS embeddings=$EMBEDS delta=$DELTA"
    if [ "$DELTA" -gt 5 ]; then
        echo "$LOG_PREFIX ALERTE: embedding gap=$DELTA depasse seuil (5)"
        COOLDOWN_FILE="/tmp/bruce_watchdog_embedding_gap.last"
        NOW_EPOCH=$(date +%s)
        SHOULD_NOTIFY=1
        if [ -f "$COOLDOWN_FILE" ]; then
            LAST_NOTIFY=$(cat "$COOLDOWN_FILE" 2>/dev/null)
            ELAPSED=$(( NOW_EPOCH - LAST_NOTIFY ))
            if [ "$ELAPSED" -lt 3600 ]; then
                SHOULD_NOTIFY=0
                echo "$LOG_PREFIX (ntfy cooldown: ${ELAPSED}s/3600s — notification supprimee)"
            fi
        fi
        if [ "$SHOULD_NOTIFY" -eq 1 ]; then
            notify "BRUCE Embedding Gap" "ALERTE: $DELTA chunks sans embedding (chunks=$CHUNKS embeds=$EMBEDS) — embed_worker a verifier" "high"
            echo "$NOW_EPOCH" > "$COOLDOWN_FILE"
        fi
        ISSUES=$((ISSUES+1))
    fi
else
    echo "$LOG_PREFIX WARN: impossible de lire chunks/embeddings count"
fi

# ============================================================
# BILAN
# ============================================================
if [ "$ISSUES" -eq 0 ]; then
    echo "$LOG_PREFIX Tous les services OK"
else
    echo "$LOG_PREFIX $ISSUES probleme(s) detecte(s)"
fi

exit $ISSUES
