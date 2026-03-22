#!/bin/sh
# Bruce git autopush - runs daily via container cron
REPO="/workspace"
LOG="/tmp/bruce_git_autopush.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
log() { echo "[$TIMESTAMP] $*" >> "$LOG"; }
cd "$REPO" || exit 1
git config --global --add safe.directory /workspace 2>/dev/null
if git diff --quiet HEAD 2>/dev/null; then
  if [ -z "$(git ls-files --others --exclude-standard)" ]; then
    log "No changes to commit"
    exit 0
  fi
fi
git add -A
CHANGES=$(git diff --cached --stat | tail -1)
log "Changes: $CHANGES"
git commit -m "auto: daily sync $(date '+%Y-%m-%d') $CHANGES [bruce-autopush]"
git push forgejo main 2>> "$LOG" && log "Push forgejo OK" || log "Push forgejo FAILED"
git push github main 2>> "$LOG" && log "Push github OK" || log "Push github FAILED"
log "Done"
