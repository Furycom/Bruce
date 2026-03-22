#!/bin/bash
# bruce_git_autopush.sh — Auto-commit and push mcp-stack to Forgejo + GitHub
# Deploy: cp to /home/furycom/mcp-stack/scripts/maintenance/
# Cron: 0 3 * * * /home/furycom/mcp-stack/scripts/maintenance/bruce_git_autopush.sh
# Runs daily at 3am on .230

set -euo pipefail

REPO_DIR="/home/furycom/mcp-stack"
LOG="/var/log/bruce_git_autopush.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

log() { echo "[$TIMESTAMP] $*" >> "$LOG"; }

cd "$REPO_DIR"

# Check if there are changes to commit
if git diff --quiet HEAD && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    log "No changes to commit"
    exit 0
fi

# Stage all tracked changes + new files (respecting .gitignore)
git add -A

# Count what changed
CHANGES=$(git diff --cached --stat | tail -1)
log "Changes: $CHANGES"

# Commit with auto-generated message
git commit -m "auto: daily sync $(date '+%Y-%m-%d')

$CHANGES

[bruce-autopush]"

# Push to both remotes
PUSH_OK=0
if git push forgejo main 2>> "$LOG"; then
    log "Push forgejo OK"
    PUSH_OK=$((PUSH_OK + 1))
else
    log "Push forgejo FAILED"
fi

if git push github main 2>> "$LOG"; then
    log "Push github OK"
    PUSH_OK=$((PUSH_OK + 1))
else
    log "Push github FAILED"
fi

if [ $PUSH_OK -eq 0 ]; then
    log "CRITICAL: Both pushes failed!"
    # Notify via ntfy if available
    curl -sf -d "Git autopush FAILED - both remotes" http://192.168.2.230:8089/bruce-alerts 2>/dev/null || true
    exit 1
fi

log "Done ($PUSH_OK/2 remotes OK)"
