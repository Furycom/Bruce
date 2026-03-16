#!/bin/bash
# Cron watchdog DSPy — vérifie toutes les 5min indépendamment du wrapper bash
LOG="/home/furycom/dspy_results_v30/bench_v30.log"
WRAPPER_LOG="/home/furycom/dspy_results_v30/overnight_v2.log"
ALERT_LOG="/home/furycom/dspy_results_v30/watchdog_alerts.log"
STUCK_MINUTES=25

log_alert() { echo "$(date): CRON-WATCHDOG: $*" | tee -a "$ALERT_LOG"; }

# Si wrapper terminé normalement — ne rien faire
grep -q "wrapper v2 terminé" "$WRAPPER_LOG" 2>/dev/null && exit 0

# Si DSPy absent mais wrapper pas terminé — alerte
if ! pgrep -f bruce_dspy_optimizer_v30.py > /dev/null; then
    log_alert "ALERTE: Process DSPy absent et wrapper non terminé!"
    exit 1
fi

# Vérifier fraîcheur du log
last_line_ts=$(tail -1 "$LOG" 2>/dev/null | grep -oP '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}' || echo "")
[ -z "$last_line_ts" ] && exit 0

now_ts=$(date +%s)
last_ts=$(date -d "$last_line_ts" +%s 2>/dev/null || echo "$now_ts")
stale_min=$(( (now_ts - last_ts) / 60 ))

if [ "$stale_min" -ge "$STUCK_MINUTES" ]; then
    log_alert "LOG STALE depuis ${stale_min}min — watchdog bash devrait déjà avoir agi. Vérification manuelle recommandée."
fi

exit 0
