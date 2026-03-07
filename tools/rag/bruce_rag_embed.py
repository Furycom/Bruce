#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

# =========================
# Helpers: HTTP + JSON
# =========================

def _http_json(
    method: str,
    url: str,
    headers: Optional[Dict[str, str]] = None,
    body_obj: Optional[Any] = None,
    timeout: int = 12,
) -> Tuple[int, str, Dict[str, str]]:
    data = None
    if body_obj is not None:
        data = json.dumps(body_obj).encode("utf-8")
    req = Request(url=url, method=method, data=data)
    for k, v in (headers or {}).items():
        req.add_header(k, v)

    try:
        with urlopen(req, timeout=timeout) as resp:
            status = int(getattr(resp, "status", 200))
            text = resp.read().decode("utf-8", errors="replace")
            resp_headers = {k.lower(): v for k, v in resp.headers.items()}
            return status, text, resp_headers
    except HTTPError as e:
        try:
            text = e.read().decode("utf-8", errors="replace")
        except Exception:
            text = str(e)
        return int(e.code), text, {}
    except URLError as e:
        return 0, f"URLError: {e}", {}
    except Exception as e:
        return 0, f"Exception: {e}", {}

def _json_loads_safe(s: str) -> Any:
    try:
        return json.loads(s)
    except Exception:
        return None

# =========================
# Gateway: exec-sql
# =========================

def gateway_exec_sql(gateway_url: str, token: str, sql: str, timeout: int = 12) -> Any:
    url = gateway_url.rstrip("/") + "/tools/supabase/exec-sql"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    status, text, _ = _http_json("POST", url, headers=headers, body_obj={"sql": sql}, timeout=timeout)
    if status != 200:
        raise RuntimeError(f"gateway exec-sql not ok: {text[:800]}")
    obj = _json_loads_safe(text)
    if not isinstance(obj, dict) or not obj.get("ok"):
        raise RuntimeError(f"gateway exec-sql not ok: {text[:800]}")
    return obj.get("data")

# =========================
# Vector formatting for pgvector
# =========================

def vector_literal(vec: List[float]) -> str:
    parts = []
    for x in vec:
        if x is None:
            parts.append("0")
        else:
            parts.append(f"{float(x):.8f}".rstrip("0").rstrip("."))
    return "[" + ",".join(parts) + "]"

# =========================
# Embedder client
# =========================

def parse_embedding_response(obj: Any) -> List[List[float]]:
    if isinstance(obj, dict) and "embeddings" in obj and isinstance(obj["embeddings"], list):
        if obj["embeddings"] and isinstance(obj["embeddings"][0], list):
            return obj["embeddings"]
        if obj["embeddings"] and isinstance(obj["embeddings"][0], (int, float)):
            return [obj["embeddings"]]

    if isinstance(obj, dict) and "embedding" in obj and isinstance(obj["embedding"], list):
        if obj["embedding"] and isinstance(obj["embedding"][0], list):
            return obj["embedding"]
        return [obj["embedding"]]

    if isinstance(obj, dict) and "data" in obj and isinstance(obj["data"], list) and obj["data"]:
        first = obj["data"][0]
        if isinstance(first, dict) and "embedding" in first:
            out = []
            for item in obj["data"]:
                if isinstance(item, dict) and isinstance(item.get("embedding"), list):
                    out.append(item["embedding"])
            if out:
                return out

    if isinstance(obj, list):
        if obj and isinstance(obj[0], list):
            return obj
        if obj and isinstance(obj[0], (int, float)):
            return [obj]

    return []

def embedder_embed_batch(embedder_url: str, model: str, inputs: List[str], timeout: int = 20) -> List[List[float]]:
    base = embedder_url.rstrip("/")
    url = base + "/embed"
    headers = {"Content-Type": "application/json"}

    body = {"model": model, "inputs": inputs}
    status, text, _ = _http_json("POST", url, headers=headers, body_obj=body, timeout=timeout)
    if status != 200:
        raise RuntimeError(f"embedder /embed HTTP {status}: {text[:900]}")
    obj = _json_loads_safe(text)
    if obj is None:
        raise RuntimeError(f"embedder /embed non-JSON: {text[:900]}")

    vectors = parse_embedding_response(obj)
    if not vectors:
        raise RuntimeError(f"embedder /embed JSON unrecognized: {text[:900]}")

    if len(vectors) == 1 and len(inputs) > 1:
        vectors = vectors * len(inputs)

    if len(vectors) != len(inputs):
        raise RuntimeError(f"embedder returned {len(vectors)} vectors for {len(inputs)} inputs")

    return vectors

# =========================
# SQL builders
# =========================

def sql_detect_tables() -> str:
    return """
select
  (select to_regclass('public.bruce_chunks') is not null) as has_chunks,
  (select to_regclass('public.bruce_embeddings') is not null) as has_embeddings
;
""".strip()

def sql_missing_chunks(model: str, limit: int) -> str:
    m = model.replace("'", "''")
    return f"""
select c.chunk_id::text as chunk_id,
       c.text as text
from public.bruce_chunks c
where not exists (
  select 1
  from public.bruce_embeddings e
  where e.chunk_id = c.chunk_id
    and e.model = '{m}'
)
order by c.chunk_id
limit {int(limit)}
;
""".strip()

def sql_upsert_embedding(chunk_id: str, model: str, vec: List[float]) -> str:
    cid = chunk_id.replace("'", "''")
    m = model.replace("'", "''")
    dims = len(vec)
    vec_lit = vector_literal(vec).replace("'", "''")

    inner = f"""
insert into public.bruce_embeddings (chunk_id, model, dims, created_at, updated_at, embedding)
values ('{cid}'::uuid, '{m}', {dims}, now(), now(), '{vec_lit}'::vector)
on conflict (chunk_id, model)
do update set
  dims = excluded.dims,
  updated_at = now(),
  embedding = excluded.embedding
""".strip()

    # Cast explicite: évite "unknown" -> text mismatch
    return f"select public.exec_sql_write(($bruce${inner}$bruce$)::text) as ok;"

# =========================
# Main
# =========================

def main() -> int:
    parser = argparse.ArgumentParser(description="BRUCE RAG Embedder (Pack B.1)")
    parser.add_argument("--gateway", default=os.environ.get("BRUCE_GATEWAY_URL", "http://127.0.0.1:4000"))
    parser.add_argument("--token", default=os.environ.get("BRUCE_GATEWAY_TOKEN", "bruce-secret-token-01"))
    parser.add_argument("--embedder", default=os.environ.get("BRUCE_EMBEDDER_URL", "http://192.168.2.85:8081"))
    parser.add_argument("--model", default=os.environ.get("BRUCE_EMBED_MODEL", "BAAI/bge-m3"))
    parser.add_argument("--limit", type=int, default=int(os.environ.get("BRUCE_EMBED_LIMIT", "500")))
    parser.add_argument("--batch-size", type=int, default=int(os.environ.get("BRUCE_EMBED_BATCH", "16")))
    parser.add_argument("--dry-run", action="store_true", default=(os.environ.get("BRUCE_DRY_RUN", "0") == "1"))
    args = parser.parse_args()

    gateway_url = args.gateway
    token = args.token
    embedder_url = args.embedder
    model = args.model
    limit = max(1, int(args.limit))
    batch_size = max(1, int(args.batch_size))
    dry_run = bool(args.dry_run)

    print("BRUCE RAG Embedder (Pack B.1)")
    print(f"- gateway:  {gateway_url}")
    print(f"- embedder: {embedder_url}")
    print(f"- model:    {model}")
    print(f"- limit:    {limit}")
    print(f"- batch:    {batch_size}")
    print(f"- dry_run:  {dry_run}")
    print()

    det = gateway_exec_sql(gateway_url, token, sql_detect_tables(), timeout=12)
    has_chunks = False
    has_embeddings = False
    if isinstance(det, list) and det:
        row = det[0]
        has_chunks = bool(row.get("has_chunks"))
        has_embeddings = bool(row.get("has_embeddings"))
    if not has_chunks or not has_embeddings:
        print("ERROR: missing required tables in public schema")
        print(f"- has_chunks: {has_chunks}")
        print(f"- has_embeddings: {has_embeddings}")
        return 2

    print("Detected RAG tables:")
    print("- chunks:      public.bruce_chunks")
    print("- embeddings:  public.bruce_embeddings.embedding (vector)")
    print("- text column: bruce_chunks.text")
    print()

    sql_missing = sql_missing_chunks(model=model, limit=limit)
    missing_rows = gateway_exec_sql(gateway_url, token, sql_missing, timeout=12)
    if not isinstance(missing_rows, list):
        print("ERROR: unexpected result from missing query")
        return 3

    total = len(missing_rows)
    print(f"Missing embeddings (chunks without embedding): {total}")
    if total == 0:
        return 0

    ok = 0
    err = 0
    t0 = time.time()

    i = 0
    while i < total:
        batch = missing_rows[i:i + batch_size]
        batch_ids = []
        batch_texts = []
        for r in batch:
            cid = str(r.get("chunk_id", "")).strip()
            txt = r.get("text", "")
            if not cid or txt is None:
                continue
            batch_ids.append(cid)
            batch_texts.append(str(txt))

        if not batch_ids:
            i += batch_size
            continue

        try:
            vectors = embedder_embed_batch(embedder_url, model, batch_texts, timeout=25)
        except Exception as e:
            for k, cid in enumerate(batch_ids, start=1):
                idx = i + k
                print(f"row {idx}/{total} chunk_id={cid} ERROR: embedder request failed (/embed): {e}")
                err += 1
            i += batch_size
            continue

        for k, (cid, vec) in enumerate(zip(batch_ids, vectors), start=1):
            idx = i + k
            try:
                if dry_run:
                    print(f"row {idx}/{total} chunk_id={cid} OK (dry_run) dims={len(vec)}")
                    ok += 1
                    continue

                sql_ins = sql_upsert_embedding(chunk_id=cid, model=model, vec=vec)
                gateway_exec_sql(gateway_url, token, sql_ins, timeout=20)
                print(f"row {idx}/{total} chunk_id={cid} OK dims={len(vec)}")
                ok += 1
            except Exception as e:
                print(f"row {idx}/{total} chunk_id={cid} ERROR: upsert failed: {e}")
                err += 1

        i += batch_size

    dt = time.time() - t0
    print()
    print("Run summary:")
    print(f"- selected:   {total}")
    print(f"- ok:         {ok}")
    print(f"- err:        {err}")
    print(f"- seconds:    {dt:.1f}")

    return 0 if err == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
