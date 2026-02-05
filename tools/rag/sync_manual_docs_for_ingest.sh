#!/usr/bin/env bash

sync_file_with_marker() {
  local src_path="$1"   # real file
  local dst_dir="$2"    # directory in mcp-manual/docs
  local rel_marker="$3" # e.g. operations/SESSION_2026-02-05.md

  local basename
  basename="$(basename "$src_path")"
  local dst_real="${dst_dir}/${basename}"

  mkdir -p "$dst_dir"

  local src_sha dst_sha
  src_sha="$(sha256sum "$src_path" | awk '{print $1}')"
  dst_sha=""
  if [ -f "$dst_real" ]; then
    dst_sha="$(sha256sum "$dst_real" | awk '{print $1}')"
  fi

  if [ "$src_sha" != "$dst_sha" ]; then
    cp -a "$src_path" "$dst_real"
    echo "SYNC: copied $basename -> $dst_dir"
  else
    echo "SYNC: already up-to-date: $dst_real"
  fi

  python3 - <<PY
from pathlib import Path
p = Path("$dst_real")
needle = "File: $rel_marker"
txt = p.read_text(encoding="utf-8", errors="replace")
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

write_latest_pointer_file() {
  local dst_path="$1"   # real file to create/overwrite in mcp-manual/docs
  local rel_marker="$2" # e.g. operations/SESSION_LATEST.md
  local target_real="$3"

  mkdir -p "$(dirname "$dst_path")"

  if [ -L "$dst_path" ]; then
    rm -f "$dst_path"
    echo "SYNC: removed symlink $dst_path"
  fi

  cat > "$dst_path" <<EOF
# POINTER — ${rel_marker}

File: ${rel_marker}

Target: ${target_real}

EOF

  echo "SYNC: wrote pointer file $(basename "$dst_path")"
}

OPS_DST="/home/furycom/mcp-manual/docs/operations"
OPS_SRC="/home/furycom/manual-docs/operations"

SESSION_REAL="$(readlink -f "${OPS_SRC}/SESSION_LATEST.md")"
HANDOFF_REAL="$(readlink -f "${OPS_SRC}/NEXT_SESSION_HANDOFF_LATEST.md")"

write_latest_pointer_file "${OPS_DST}/SESSION_LATEST.md" "operations/SESSION_LATEST.md" "${SESSION_REAL}"
write_latest_pointer_file "${OPS_DST}/NEXT_SESSION_HANDOFF_LATEST.md" "operations/NEXT_SESSION_HANDOFF_LATEST.md" "${HANDOFF_REAL}"

sync_file_with_marker "${SESSION_REAL}" "${OPS_DST}" "operations/$(basename "${SESSION_REAL}")"
sync_file_with_marker "${HANDOFF_REAL}" "${OPS_DST}" "operations/$(basename "${HANDOFF_REAL}")"

sync_file_with_marker "$(readlink -f "${OPS_SRC}/README_SESSION_GUIDE_LATEST.md")" "${OPS_DST}" "operations/README_SESSION_GUIDE_LATEST.md"
sync_file_with_marker "${OPS_SRC}/README_SESSION_GUIDE_V5.md" "${OPS_DST}" "operations/README_SESSION_GUIDE_V5.md"

echo "SYNC: done"
