#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
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
from typing import Any, Dict, List, Optional, Tuple

# Same stable namespace as manual-docs ingest (do not change once data exists)
UUID_NS = uuid.UUID("3b3b0c3b-4c1a-4b1e-9b3e-9c2f3d10a5a1")

DEFAULT_GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://127.0.0.1:4000")
DEFAULT_BRUCE_TOKEN = os.environ.get("BRUCE_TOKEN", "")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "").strip()

SOURCE = "journal"
DOC_TYPE = "journal"

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

def safe_title_from_text(text: str, fallback: str) -> str:
    t = normalize_newlines(text).strip()
    if not t:
        return fallback[:300]
    first_line = t.splitlines()[0].strip()
    first_line = re.sub(r"\s+", " ", first_line)
    if not first_line:
        return fallback[:300]
    return first_line[:300]

@dataclass
class Chunk:
    chunk_index: int
    text: str

def chunk_text(text: str, target_chars: int = 1400, overlap: int = 180) -> List[Chunk]:
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
            return int(status), resp_headers, text
    except urllib.error.HTTPError as ex:
        text = ex.read().decode("utf-8", errors="replace") if ex.fp else str(ex)
        return int(ex.code), {k.lower(): v for k, v in dict(ex.headers).items()}, text
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
    raise RuntimeError("Could not detect PostgREST endpoint from SUPABASE_URL.")

def rest_upsert(rest_base: str, table: str, rows: List[Dict[str, Any]], on_conflict: str, timeout: int = 40) -> None:
    if not rows:
        return
    url = f"{rest_base.rstrip('/')}/{table}?on_conflict={urllib.parse.quote(on_conflict)}"
    status, _, text = http_json(url, method="POST", headers=rest_headers(), body_obj=rows, timeout=timeout)
    if status not in (200, 201, 204):
        raise RuntimeError(f"rest upsert {table} http {status}: {text[:800]}")

def sql_fetch_journal(limit: int) -> str:
    lim = int(max(1, limit))
    return f"""
select
  id::bigint as id,
  coalesce(source,'')::text as source,
  coalesce(author,'')::text as author,
  coalesce(channel,'')::text as channel,
  coalesce(content,'')::text as content,
  created_at
from public.bruce_memory_journal
order by created_at asc
limit {lim}
;
""".strip()

def main() -> int:
    parser = argparse.ArgumentParser(description="BRUCE RAG Ingest (bruce_memory_journal -> bruce_docs/bruce_chunks)")
    parser.add_argument("--limit", type=int, default=int(os.environ.get("BRUCE_JOURNAL_LIMIT", "5000")))
    args = parser.parse_args()

    print("BRUCE RAG Ingest (journal -> bruce_docs/bruce_chunks)")
    print(f"- gateway:    {DEFAULT_GATEWAY_URL}")
    print(f"- source:     {SOURCE}")
    print(f"- doc_type:   {DOC_TYPE}")
    print(f"- limit:      {args.limit}")
    print()

    try:
        require_env()
    except Exception as ex:
        eprint("ERROR:", str(ex)[:500])
        return 2

    try:
        _ = gateway_exec_sql("select 1 as ok;")
    except Exception as ex:
        eprint("ERROR: gateway exec-sql failed:", str(ex)[:600])
        return 3

    try:
        rest_base = pick_rest_base()
    except Exception as ex:
        eprint("ERROR:", str(ex)[:800])
        return 4

    print(f"Detected PostgREST: {rest_base}")
    print()

    data = gateway_exec_sql(sql_fetch_journal(args.limit), timeout=35).get("data")
    if not isinstance(data, list):
        eprint("ERROR: unexpected journal query result")
        return 5

    rows = []
    for r in data:
        if not isinstance(r, dict):
            continue
        content = str(r.get("content") or "")
        _t = content.strip()
        if not _t:
            continue
        if _t in ("...","..",".","…","—","-","--"):
            continue
        if len(_t) < 5:
            continue
        rows.append(r)

    print(f"Journal rows fetched: {len(data)}")
    print(f"Journal rows usable (non-empty content): {len(rows)}")
    if not rows:
        print("Nothing to ingest.")
        return 0

    docs_payload: List[Dict[str, Any]] = []
    chunks_payload: List[Dict[str, Any]] = []

    for r in rows:
        jid = int(r.get("id"))
        j_source = str(r.get("source") or "")
        j_author = str(r.get("author") or "")
        j_channel = str(r.get("channel") or "")
        j_content = str(r.get("content") or "")
        j_created_at = r.get("created_at")

        original_path = f"/bruce_memory_journal/{jid}"
        doc_id = str(uuid.uuid5(UUID_NS, original_path))

        title = safe_title_from_text(j_content, fallback=f"journal {jid}")
        content_sha = sha256_text(j_content)

        meta = {
            "kind": "journal",
            "journal_id": jid,
            "journal_source": j_source,
            "journal_author": j_author,
            "journal_channel": j_channel,
            "journal_created_at": j_created_at,
            "ingest": "journal_v1_python_uuid5_chunks_text_sha256",
        }

        docs_payload.append({
            "doc_id": doc_id,
            "source": SOURCE,
            "title": title,
            "doc_type": DOC_TYPE,
            "content_sha256": content_sha,
            "original_path": original_path,
            "metadata": meta,
        })

        chunks = chunk_text(j_content, target_chars=1400, overlap=180)
        for ch in chunks:
            chunk_id = str(uuid.uuid5(UUID_NS, f"{doc_id}:{ch.chunk_index}"))
            chunks_payload.append({
                "chunk_id": chunk_id,
                "doc_id": doc_id,
                "chunk_index": int(ch.chunk_index),
                "text": ch.text,
                "text_sha256": sha256_text(ch.text),
            })

    t0 = time.time()

    BATCH_DOCS = 200
    BATCH_CHUNKS = 400
    DOCS_ON_CONFLICT = "source,original_path"

    docs_ingested = 0
    chunks_ingested = 0

    for i in range(0, len(docs_payload), BATCH_DOCS):
        batch = docs_payload[i:i + BATCH_DOCS]
        rest_upsert(rest_base, "bruce_docs", batch, on_conflict=DOCS_ON_CONFLICT, timeout=60)
        docs_ingested += len(batch)

    for i in range(0, len(chunks_payload), BATCH_CHUNKS):
        batch = chunks_payload[i:i + BATCH_CHUNKS]
        rest_upsert(rest_base, "bruce_chunks", batch, on_conflict="chunk_id", timeout=90)
        chunks_ingested += len(batch)

    dt = time.time() - t0
    print()
    print("Ingest summary:")
    print(f"- docs_upserted:   {docs_ingested}")
    print(f"- chunks_upserted: {chunks_ingested}")
    print(f"- seconds:         {dt:.1f}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
