#!/usr/bin/env bash
set -euo pipefail

sync_one() {
  local src_link="$1"
  local dst_dir="$2"

  local src_real
  src_real="$(readlink -f "$src_link")"
  local basename
  basename="$(basename "$src_real")"
  local dst_real="${dst_dir}/${basename}"

  mkdir -p "$dst_dir"

  local src_sha dst_sha
  src_sha="$(sha256sum "$src_real" | awk '{print $1}')"
  dst_sha=""
  if [ -f "$dst_real" ]; then
    dst_sha="$(sha256sum "$dst_real" | awk '{print $1}')"
  fi

  if [ "$src_sha" != "$dst_sha" ]; then
    cp -a "$src_real" "$dst_real"
    echo "SYNC: copied $basename -> $dst_dir"
  else
    echo "SYNC: already up-to-date: $basename"
  fi

  # Ensure filename marker is present (helps RAG lookup by filename)
  python3 - <<PY
from pathlib import Path

p = Path("$dst_real")
needle = f"File: {p.name}"

txt = p.read_text(encoding="utf-8")
if needle in txt:
    print("SYNC: file marker already present")
    raise SystemExit(0)

lines = txt.splitlines()
out = []
inserted = False
for line in lines:
    out.append(line)
    if (not inserted) and line.startswith("# "):
        out.append("")
        out.append(needle)
        inserted = True

p.write_text("\n".join(out) + "\n", encoding="utf-8")
print("SYNC: inserted file marker")
PY
}

DST_DIR="/home/furycom/mcp-manual/docs/operations"

# 1) Handoff (canon)
sync_one "/home/furycom/manual-docs/operations/NEXT_SESSION_HANDOFF_LATEST.md" "$DST_DIR"

# 2) Session guide (canon)
sync_one "/home/furycom/manual-docs/operations/README_SESSION_GUIDE_LATEST.md" "$DST_DIR"

# 3) Session guide pinned version (V5)
sync_one "/home/furycom/manual-docs/operations/README_SESSION_GUIDE_V5.md" "$DST_DIR"

echo "SYNC: done"

