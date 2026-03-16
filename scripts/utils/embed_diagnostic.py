#!/usr/bin/env python3
import os
"""embed_diagnostic.py v4 - fix colonnes model+dims"""
import requests, sys, json, time
from collections import Counter

SUPABASE = "http://192.168.2.206:8000/rest/v1"
APIKEY = os.environ.get("SUPABASE_KEY", "")
EMBEDDER = "http://192.168.2.85:8081/embed"
MODEL_NAME = "bge-m3"
H = {"apikey": APIKEY, "Authorization": "Bearer " + APIKEY}
FIX = "--fix" in sys.argv

def fetch_all(table, select, filters=""):
    rows, offset, PAGE = [], 0, 500
    while True:
        url = SUPABASE + "/" + table + "?select=" + select + "&limit=" + str(PAGE) + "&offset=" + str(offset) + filters
        r = requests.get(url, headers=H, timeout=15)
        batch = r.json() if r.ok else []
        if not isinstance(batch, list) or not batch:
            break
        rows.extend(batch)
        if len(batch) < PAGE:
            break
        offset += PAGE
    return rows

def embed_text(text):
    r = requests.post(EMBEDDER, json={"inputs": text[:512], "max_length": 256},
        headers={"Content-Type": "application/json"}, timeout=10)
    if r.ok:
        data = r.json()
        return data[0] if isinstance(data, list) else None
    return None

print("=== EMBED DIAGNOSTIC v4 [126] ===")
chunks = fetch_all("bruce_chunks", "id,text,anchor,created_at")
embeds = fetch_all("bruce_embeddings", "chunk_id")
embed_ids = {e["chunk_id"] for e in embeds}
orphans = [c for c in chunks if c["id"] not in embed_ids]

print("Total chunks:     " + str(len(chunks)))
print("Total embeddings: " + str(len(embed_ids)))
print("Orphelins:        " + str(len(orphans)))

if not orphans:
    print("Pipeline sain - 0 orphelins")
    sys.exit(0)

def get_source(c):
    a = c.get("anchor") or {}
    if isinstance(a, str):
        try: a = json.loads(a)
        except: return "?"
    return a.get("source","?")

by_source = Counter(get_source(c) for c in orphans)
print("Orphelins par source:")
for src, cnt in by_source.most_common():
    print("  " + str(src) + ": " + str(cnt))

embeddable = [c for c in orphans if c.get("text")]
null_text = [c for c in orphans if not c.get("text")]
print("Texte null: " + str(len(null_text)) + " | Embeddables: " + str(len(embeddable)))

if FIX and embeddable:
    print("FIX: " + str(len(embeddable)) + " chunks...")
    ok, err = 0, 0
    h2 = dict(list(H.items()) + [("Content-Type","application/json"),("Prefer","return=minimal")])
    for c in embeddable:
        vec = embed_text(c["text"])
        if vec is None:
            err += 1
            continue
        payload = {"chunk_id": c["id"], "embedding": vec, "model": MODEL_NAME, "dims": len(vec)}
        r2 = requests.post(SUPABASE + "/bruce_embeddings", headers=h2, json=payload, timeout=10)
        if r2.ok:
            ok += 1
        else:
            print("  ERR " + c["id"][:8] + ": " + r2.text[:80])
            err += 1
        time.sleep(0.05)
    print("OK: " + str(ok) + " | Erreurs: " + str(err))
elif embeddable:
    print("Relancer avec --fix pour corriger")

print("=== FIN ===")
