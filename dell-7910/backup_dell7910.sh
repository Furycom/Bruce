#!/bin/sh
# backup_dell7910.sh - Daily backup of critical files from Dell 7910 (.32)
# Runs from bruce-gateway container via SSH+rsync to .32
# Target: /workspace/dell-7910/backups/ (Git-tracked)
#
# What we backup:
#   - DSPy results, gold sets, scripts
#   - Bench results
#   - Server config scripts
# What we exclude:
#   - GGUF models (too large, re-downloadable)
#   - .dspy_cache, __pycache__
#
# Usage: Called by cron daily at 03:00

set -e

REMOTE_HOST="192.168.2.32"
REMOTE_USER="furycom"
REMOTE_BASE="/home/furycom"
LOCAL_DEST="/workspace/dell-7910/backups"
LOG_FILE="/tmp/backup_dell7910.log"
DATE=$(date '+%Y-%m-%d %H:%M:%S')

echo "=== Backup started: $DATE ===" > "$LOG_FILE"

# Ensure destination exists
mkdir -p "$LOCAL_DEST"

# rsync from .32 to gateway /workspace
# --include/exclude patterns to get only what matters
rsync -avz --timeout=120 \
  --include='dspy_results_*/' \
  --include='dspy_results_*/**' \
  --include='dspy_gold_*' \
  --include='bruce_dspy_*' \
  --include='recreate_llama_server.sh' \
  --include='bench_results_*/' \
  --include='bench_results_*/**' \
  --exclude='*.gguf' \
  --exclude='*.GGUF' \
  --exclude='.dspy_cache/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.cache/' \
  --exclude='models/' \
  --exclude='node_modules/' \
  --exclude='*.bin' \
  --exclude='*' \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_BASE}/" \
  "${LOCAL_DEST}/" \
  >> "$LOG_FILE" 2>&1

RSYNC_EXIT=$?

echo "=== Backup finished: $(date '+%Y-%m-%d %H:%M:%S') - exit code: $RSYNC_EXIT ===" >> "$LOG_FILE"

# Show summary
if [ $RSYNC_EXIT -eq 0 ]; then
  echo "[OK] Dell 7910 backup complete" >> "$LOG_FILE"
  FILECOUNT=$(find "$LOCAL_DEST" -type f | wc -l)
  TOTALSIZE=$(du -sh "$LOCAL_DEST" | cut -f1)
  echo "Files: $FILECOUNT, Size: $TOTALSIZE" >> "$LOG_FILE"
else
  echo "[ERROR] rsync failed with exit code $RSYNC_EXIT" >> "$LOG_FILE"
fi

cat "$LOG_FILE"
exit $RSYNC_EXIT
