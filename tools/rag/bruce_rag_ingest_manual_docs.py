
#!/usr/bin/env python3
import hashlib
import json
import os
import re
import sys
import time
import uuid
import urllib.parse
import urllib.request
import urllib.error
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://127.0.0.1:4000")
DEFAULT_BRUCE_TOKEN = os.environ.get("BRUCE_TOKEN", "")
DEFAULT_MANUAL_DIR = os.environ.get("MANUAL_DOCS_DIR", "/home/furycom/manual-docs")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "").strip()

# Stable namespace UUIDv5 (do not change once data exists)
UUID_NS = uuid.UUID("3b3b0c3b-4c1a-4b1e-9b3e-9c2f3d10a5a1")

SOURCE = "manual-docs"
DOC_TYPE = "manual"

def eprint(*a: Any) -> None:
    print(*a, file=sys.stderr)

def sha256_bytes(b: bytes) -> str:
    h = hashlib.sha256()
    h.update(b)
    return h.hexdigest()

def sha256_text(s: str) -> str:
    return sha256_bytes(s.encode("utf-8", errors="replace"))

def normalize_newlines(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\r", "\n")

def extract_title(md_text: str, fallback: str) -> Tuple[str, bool]:
    """
    Returns (title, from_heading).
    """
    for line in md_text.splitlines():
        m = re.match(r"^\s*#\s+(.+?)\s*$", line)
        if m:
            t = m.group(1).strip()
            if t:
                return t[:300], True
    return fallback[:300], False

@dataclass
class Chunk:
    chunk_index: int
    text: str

def chunk_markdown(text: str, target_chars: int = 1400, overlap: int = 180) -> List[Chunk]:
    t = normalize_newlines(text).strip()
    if not t:
        return []

    blocks = re.split(r"\n\s*\n", t)
    blocks = [b.strip() for b in blocks if b.strip()]

    chunks: List[str] = []
    cur: List[str] = []
    cur_len = 0

    def flush() -> None:
        nonlocal cur, cur_len
        if not cur:
            return
        chunks.append("\n\n".join(cur).strip())
        cur = []
        cur_len = 0

    for b in blocks:
        blen = len(b)
        if cur_len == 0:
            cur.append(b)
            cur_len = blen
            continue
        if cur_len + 2 + blen <= target_chars:
            cur.append(b)
            cur_len += 2 + blen
        else:
            flush()
            cur.append(b)
            cur_len = blen

    flush()

    out: List[Chunk] = []
    prev_tail = ""
    for i, c in enumerate(chunks):
        if i == 0:
            out.append(Chunk(i, c))
        else:
            tail = prev_tail
            merged = (tail + "\n\n" + c).strip() if tail else c
            out.append(Chunk(i, merged))
        prev_tail = c[-overlap:] if overlap > 0 and len(c) > overlap else c

    return out

def http_json(url: str, method: str = "GET",
              headers: Optional[Dict[str, str]] = None,
              body_obj: Optional[Any] = None,
              timeout: int = 25) -> Tuple[int, Dict[str, str], str]:
    hdrs = headers or {}
    data = None
    if body_obj is not None:
        data = json.dumps(body_obj).encode("utf-8")
        hdrs = dict(hdrs)
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = getattr(resp, "status", 200)
            resp_headers = {k.lower(): v for k, v in dict(resp.headers).items()}
            text = resp.read().decode("utf-8", errors="replace")
            return status, resp_headers, text
    except urllib.error.HTTPError as ex:
        text = ex.read().decode("utf-8", errors="replace") if ex.fp else str(ex)
        return ex.code, {k.lower(): v for k, v in dict(ex.headers).items()}, text
    except Exception as ex:
        return 0, {}, str(ex)

def gateway_exec_sql(sql: str, timeout: int = 35) -> Dict[str, Any]:
    url = DEFAULT_GATEWAY_URL.rstrip("/") + "/tools/supabase/exec-sql"
    headers = {"Authorization": "Bearer " + DEFAULT_BRUCE_TOKEN}
    status, _, text = http_json(url, method="POST", headers=headers, body_obj={"sql": sql}, timeout=timeout)
    if status != 200:
        raise RuntimeError(f"exec-sql http {status}: {text[:800]}")
    try:
        obj = json.loads(text)
    except Exception:
        raise RuntimeError(f"exec-sql bad json: {text[:300]}")
    if isinstance(obj, dict) and obj.get("ok") is False:
        raise RuntimeError(f"exec-sql failed: {obj.get('error','')[:900]}")
    return obj if isinstance(obj, dict) else {"data": obj}

def require_env() -> None:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_KEY in environment (.env).")

def rest_headers() -> Dict[str, str]:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }

def candidate_rest_bases() -> List[str]:
    bases: List[str] = []
    raw = SUPABASE_URL.rstrip("/")
    if not raw:
        return bases

    if raw.endswith("/rest/v1"):
        bases.append(raw)
        bases.append(raw[:-8])

    try:
        p = urllib.parse.urlparse(raw)
    except Exception:
        return bases

    if p.scheme and p.hostname:
        if p.port is not None:
            bases.append(f"{p.scheme}://{p.hostname}:{p.port}/rest/v1")
            bases.append(f"{p.scheme}://{p.hostname}:{p.port}")
            if p.port == 3000:
                bases.append(f"{p.scheme}://{p.hostname}:8000/rest/v1")
                bases.append(f"{p.scheme}://{p.hostname}:54321/rest/v1")
                bases.append(f"{p.scheme}://{p.hostname}:8000")
                bases.append(f"{p.scheme}://{p.hostname}:54321")
        else:
            bases.append(f"{p.scheme}://{p.hostname}/rest/v1")
            bases.append(f"{p.scheme}://{p.hostname}")
            bases.append(f"{p.scheme}://{p.hostname}:8000/rest/v1")
            bases.append(f"{p.scheme}://{p.hostname}:54321/rest/v1")

    seen = set()
    out: List[str] = []
    for b in bases:
        b2 = b.rstrip("/")
        if not b2:
            continue
        if b2 not in seen:
            seen.add(b2)
            out.append(b2)
    return out

def pick_rest_base() -> str:
    hdrs = rest_headers()
    for base in candidate_rest_bases():
        candidates: List[str] = []
        if base.endswith("/rest/v1"):
            candidates.append(base)
        else:
            candidates.append(base + "/rest/v1")
            candidates.append(base)

        for rb in candidates:
            rb2 = rb.rstrip("/")
            url = rb2 + "/bruce_docs?select=doc_id&limit=1"
            status, _, _ = http_json(url, method="GET", headers=hdrs, body_obj=None, timeout=8)
            if status in (200, 206, 401, 403):
                return rb2
    raise RuntimeError("Could not detect PostgREST endpoint. SUPABASE_URL seems not to expose /rest/v1 on tested ports (3000/8000/54321).")

def rest_upsert(rest_base: str, table: str, rows: List[Dict[str, Any]], on_conflict: str, timeout: int = 40) -> None:
    if not rows:
        return
    url = f"{rest_base.rstrip('/')}/{table}?on_conflict={urllib.parse.quote(on_conflict)}"
    status, _, text = http_json(url, method="POST", headers=rest_headers(), body_obj=rows, timeout=timeout)
    if status not in (200, 201, 204):
        raise RuntimeError(f"rest upsert {table} http {status}: {text[:800]}")

def iter_markdown_files(root: Path) -> List[Path]:
    files: List[Path] = []
    for p in root.rglob("*.md"):
        if p.is_symlink():
            continue
        rel = p.relative_to(root).as_posix()
        if rel.endswith("_LATEST.md"):
            continue
        if rel.startswith("exports/"):
            continue
        files.append(p)
    files.sort(key=lambda x: x.relative_to(root).as_posix())
    return files

def main() -> int:
    print("BRUCE RAG Ingest (manual-docs -> bruce_docs/bruce_chunks)")
    print(f"- gateway:      {DEFAULT_GATEWAY_URL}")
    print(f"- manual_dir:   {DEFAULT_MANUAL_DIR}")
    print(f"- source:       {SOURCE}")
    print(f"- doc_type:     {DOC_TYPE}")
    print()

    try:
        require_env()
    except Exception as ex:
        eprint("ERROR:", str(ex)[:500])
        return 2

    root = Path(DEFAULT_MANUAL_DIR)
    if not root.exists() or not root.is_dir():
        eprint(f"ERROR: MANUAL_DOCS_DIR not found or not a dir: {root}")
        return 3

    md_files = iter_markdown_files(root)
    print(f"Found markdown files: {len(md_files)}")
    if not md_files:
        print("Nothing to ingest.")
        return 0

    try:
        _ = gateway_exec_sql("select 1 as ok;")
    except Exception as ex:
        eprint("ERROR: gateway exec-sql failed:", str(ex)[:600])
        return 4

    try:
        rest_base = pick_rest_base()
    except Exception as ex:
        eprint("ERROR:", str(ex)[:800])
        return 5

    print(f"Detected PostgREST: {rest_base}")
    print()

    # Deduplicate by original_path (stable identity per file path)
    # Keep all file paths in metadata.files so no information is lost.
    docs_by_path: Dict[str, Dict[str, Any]] = {}
    text_by_path: Dict[str, str] = {}

    for fp in md_files:
        rel = fp.relative_to(root).as_posix()
        original_path = "/manual-docs/" + rel

        raw = fp.read_bytes()
        content_sha = sha256_bytes(raw)
        text = raw.decode("utf-8", errors="replace")

        title_fallback = Path(rel).stem.replace("-", " ").replace("_", " ")
        title, from_heading = extract_title(text, fallback=title_fallback)

        st = fp.stat()
        file_meta = {
            "rel_path": rel,
            "original_path": original_path,
            "bytes": int(st.st_size),
            "mtime_unix": int(st.st_mtime),
        }

        if original_path not in docs_by_path:
            # doc_id stable on (source + sha) to match unique constraint
            doc_id = str(uuid.uuid5(UUID_NS, original_path))

            meta = {
                "kind": "manual-docs",
                "ingest": "phase2_rest_upsert_dedupe_by_source_sha_v4_chunks_text_sha256",
                "sha256": content_sha,
                "n_files": 1,
                "files": [file_meta],
                "title_candidates": [title],
            }

            docs_by_path[original_path] = {
                "doc_id": doc_id,
                "source": SOURCE,
                "title": title,
                "doc_type": DOC_TYPE,
                "content_sha256": content_sha,
                "original_path": original_path,  # representative path
                "metadata": meta,
                "_title_from_heading": bool(from_heading),
            }
            text_by_path[original_path] = text
        else:
            d = docs_by_path[original_path]
            meta = d.get("metadata") or {}
            files_list = meta.get("files") if isinstance(meta.get("files"), list) else []
            files_list.append(file_meta)
            meta["files"] = files_list
            meta["n_files"] = int(meta.get("n_files", 1)) + 1

            tc = meta.get("title_candidates") if isinstance(meta.get("title_candidates"), list) else []
            tc.append(title)
            meta["title_candidates"] = tc

            # If current doc title came from fallback but we now see a real heading, upgrade title.
            if not d.get("_title_from_heading", False) and from_heading:
                d["title"] = title
                d["_title_from_heading"] = True

            d["metadata"] = meta

    # Build payloads
    docs_payload: List[Dict[str, Any]] = []
    chunks_payload: List[Dict[str, Any]] = []

    t0 = time.time()

    for original_path, d in docs_by_path.items():
        doc_id = d["doc_id"]
        docs_payload.append({
            "doc_id": d["doc_id"],
            "source": d["source"],
            "title": d["title"],
            "doc_type": d["doc_type"],
            "content_sha256": d["content_sha256"],
            "original_path": d["original_path"],
            "metadata": d["metadata"],
        })

        text = text_by_path.get(original_path, "")
        chunks = chunk_markdown(text, target_chars=1400, overlap=180)
        for ch in chunks:
            chunk_id = str(uuid.uuid5(UUID_NS, f"{doc_id}:{ch.chunk_index}"))
            chunks_payload.append({
                "chunk_id": chunk_id,
                "doc_id": doc_id,
                "chunk_index": int(ch.chunk_index),
                "text": ch.text,
                "text_sha256": sha256_text(ch.text),  # REQUIRED by NOT NULL constraint
            })

    docs_ingested = 0
    chunks_inserted = 0

    BATCH_DOCS = 50
    BATCH_CHUNKS = 200

    # Upsert docs on the unique constraint: (source, original_path)
    DOCS_ON_CONFLICT = "source,original_path"

    for i in range(0, len(docs_payload), BATCH_DOCS):
        batch = docs_payload[i:i + BATCH_DOCS]
        rest_upsert(rest_base, "bruce_docs", batch, on_conflict=DOCS_ON_CONFLICT, timeout=60)
        docs_ingested += len(batch)

    for i in range(0, len(chunks_payload), BATCH_CHUNKS):
        batch = chunks_payload[i:i + BATCH_CHUNKS]
        rest_upsert(rest_base, "bruce_chunks", batch, on_conflict="chunk_id", timeout=90)
        chunks_inserted += len(batch)

    dt = time.time() - t0
    print()
    print("Ingest summary:")
    print(f"- docs_ingested:   {docs_ingested}")
    print(f"- chunks_inserted: {chunks_inserted}")
    print(f"- seconds:         {dt:.1f}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
