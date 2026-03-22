#!/bin/bash
# Watchdog on .32: when DSPy finishes (slot idle for 5min), recreate with --metrics
LOG="/home/furycom/llama_watchdog.log"
echo "[$(date)] Watchdog started on .32. Waiting for slot to be idle..." > $LOG
IDLE_COUNT=0

while true; do
    BUSY=$(curl -s -H "Authorization: Bearer token-abc123" http://localhost:8000/slots 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['is_processing'])" 2>/dev/null || echo "error")
    if [ "$BUSY" = "False" ]; then
        IDLE_COUNT=$((IDLE_COUNT + 1))
        echo "[$(date)] Slot idle ($IDLE_COUNT/5)" >> $LOG
        if [ "$IDLE_COUNT" -ge 5 ]; then
            echo "[$(date)] Slot idle 5 min. Recreating with --metrics..." >> $LOG
            bash /home/furycom/recreate_llama_server.sh >> $LOG 2>&1
            echo "[$(date)] Done." >> $LOG
            exit 0
        fi
    else
        IDLE_COUNT=0
    fi
    sleep 60
done
