#!/usr/bin/env bash
set -euo pipefail

# This script finds files that match already-configured .gitignore patterns but
# are still tracked by Git, then removes them from the Git index only (keeps
# files on disk) using `git rm --cached`.

PATTERNS=(
  "*.bak*"
  "*.backup*"
  "server_backup_*"
  "sha256:*"
  "*.snip"
  "_patch_*/"
  "_bak_*/"
  "_scratch_*/"
  "patch_ssh_keypref.py"
)

echo "Ignored/tracked candidates:"
git ls-files --cached --ignored --exclude-standard -- "${PATTERNS[@]}"

echo

# Remove from Git tracking only (do not delete local files).
git ls-files -z --cached --ignored --exclude-standard -- "${PATTERNS[@]}" \
  | xargs -0 -r git rm --cached --
