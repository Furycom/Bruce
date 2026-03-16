#!/bin/bash
# inbox_watcher.sh - Surveille /home/furycom/inbox/ et lance bruce_ingest.py
# Cree session #72 Sonnet 2026-02-22
# Usage: bash inbox_watcher.sh (lancer dans tmux)
# Ou via cron: */5 * * * * bash /home/furycom/inbox_watcher.sh >> /home/furycom/logs/inbox_watcher.log 2>&1

INBOX="/home/furycom/inbox"
DONE_DIR="/home/furycom/inbox/done"
LOG="/home/furycom/logs/inbox_watcher.log"
INGEST="/home/furycom/bruce_ingest.py"
DATE=$(date "+%Y-%m-%d %H:%M:%S")

mkdir -p "$INBOX" "$DONE_DIR" "$(dirname $LOG)"

# Chercher tous les .txt dans inbox (pas dans done/)
for f in "$INBOX"/*.txt "$INBOX"/*.md; do
    [ -f "$f" ] || continue
    fname=$(basename "$f")
    echo "[$DATE] Fichier detecte: $fname" >> "$LOG"

    # Lancer ingestion
    cd /home/furycom
    if python3 "$INGEST" "$f" --source "inbox_watcher $DATE" >> "$LOG" 2>&1; then
        echo "[$DATE] Ingestion OK: $fname" >> "$LOG"
        mv "$f" "$DONE_DIR/${fname}.done_$(date +%Y%m%d_%H%M%S)"
    else
        echo "[$DATE] ERREUR ingestion: $fname" >> "$LOG"
        mv "$f" "$DONE_DIR/${fname}.error_$(date +%Y%m%d_%H%M%S)"
    fi
done

echo "[$DATE] Scan termine. $(ls $INBOX/*.txt $INBOX/*.md 2>/dev/null | wc -l) fichiers en attente." >> "$LOG"