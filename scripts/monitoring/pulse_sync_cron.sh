#!/bin/bash
LOG=/home/furycom/logs/pulse_sync.log
NTFY_URL=http://192.168.2.174:8080/bruce-alerts

# Lancer pulse_sync
python3 /home/furycom/pulse_sync.py --json > /tmp/pulse_sync_last.json 2>&1
EXIT_CODE=$?

# Lire résultat
RESULT=$(cat /tmp/pulse_sync_last.json 2>/dev/null | head -c 500)
if [ -z "$RESULT" ]; then
  RESULT='{"error":"no output"}'
fi

# Extraire stats
NEW=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stats',{}).get('new',0))" 2>/dev/null || echo "?")
MOD=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stats',{}).get('modified',0))" 2>/dev/null || echo "?")
MATCHED=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stats',{}).get('matched',0))" 2>/dev/null || echo "?")

MSG="pulse_sync [685] new=$NEW modified=$MOD matched=$MATCHED exit=$EXIT_CODE"
PRIORITY=1
if [ "$NEW" != "0" ] && [ "$NEW" != "?" ]; then PRIORITY=3; fi
if [ "$MOD" != "0" ] && [ "$MOD" != "?" ]; then PRIORITY=3; fi

# Envoyer à ntfy
curl -s -X POST "$NTFY_URL" \
  -H "Title: BRUCE Autodiscovery pulse_sync" \
  -H "Priority: $PRIORITY" \
  -H "Tags: bruce,autodiscovery,pulse" \
  -d "$MSG" > /dev/null 2>&1

# Aussi append au log
echo "$(date '+%Y-%m-%d %H:%M:%S') $MSG" >> "$LOG"
