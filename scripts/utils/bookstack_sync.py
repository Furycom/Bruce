#!/usr/bin/env python3
"""
bookstack_sync.py - Sync BookStack docs -> BRUCE RAG (knowledge_base)
Usage: python3 bookstack_sync.py [--dry-run]
Nécessite: BS_TOKEN_ID et BS_TOKEN_SECRET dans l'environnement ou en dur ci-dessous.
"""
import os, requests, json, hashlib, sys
from datetime import datetime

# === CONFIG ===
BS_URL      = "http://192.168.2.113:8014"
BS_TOKEN_ID     = os.environ.get("BS_TOKEN_ID", "")
BS_TOKEN_SECRET = os.environ.get("BS_TOKEN_SECRET", "")

SUPABASE = "http://192.168.2.146:8000/rest/v1"
KEY = os.environ.get("SUPABASE_KEY", "")

DRY_RUN = "--dry-run" in sys.argv

SH = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json", "Prefer": "return=minimal"}
SHA = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Accept": "application/json"}

def bs_headers():
    return {"Authorization": f"Token {BS_TOKEN_ID}:{BS_TOKEN_SECRET}"}

def content_hash(text):
    return hashlib.md5(text.encode()).hexdigest()[:16]

def already_exists(ch):
    r = requests.get(SUPABASE + "/knowledge_base?content_hash=eq." + ch + "&limit=1", headers=SHA)
    if r.ok and r.json(): return True
    r2 = requests.get(SUPABASE + "/staging_queue?content_hash=eq." + ch + "&status=neq.rejected&limit=1", headers=SHA)
    return r2.ok and bool(r2.json())

def push_to_staging(entry, ch):
    payload = {
        "table_cible": "knowledge_base",
        "contenu_json": json.dumps(entry),
        "author_system": "bookstack_sync",
        "content_hash": ch,
        "status": "pending"
    }
    r = requests.post(SUPABASE + "/staging_queue", headers=SH, json=payload)
    return r.status_code in (200, 201)

def chunk_text(text, size=2500):
    if len(text) <= size:
        return [text]
    chunks, current, cur_len = [], [], 0
    for line in text.split("\n"):
        current.append(line)
        cur_len += len(line)
        if cur_len >= size:
            chunks.append("\n".join(current))
            current, cur_len = [], 0
    if current:
        chunks.append("\n".join(current))
    return chunks

# === MAIN ===
if not BS_TOKEN_ID or not BS_TOKEN_SECRET:
    print("ERREUR: BS_TOKEN_ID et BS_TOKEN_SECRET requis.")
    print("Usage: BS_TOKEN_ID=xxx BS_TOKEN_SECRET=yyy python3 bookstack_sync.py")
    sys.exit(1)

# Tester la connexion
test = requests.get(BS_URL + "/api/books", headers=bs_headers(), timeout=10)
if test.status_code != 200:
    print(f"ERREUR BookStack API: {test.status_code} {test.text[:100]}")
    sys.exit(1)

books = test.json().get("data", [])
print(f"BookStack: {len(books)} livres trouvés")

pushed = skipped = errors = 0

for book in books:
    book_name = book["name"]
    book_id = book["id"]
    print(f"\n=== Livre: {book_name} (id={book_id}) ===")

    # Pages du livre
    pages = requests.get(BS_URL + f"/api/pages?filter[book_id]={book_id}&count=100", headers=bs_headers()).json().get("data", [])
    print(f"  {len(pages)} pages")

    for page in pages:
        page_id = page["id"]
        page_name = page["name"]

        # Contenu complet
        detail = requests.get(BS_URL + f"/api/pages/{page_id}", headers=bs_headers()).json()
        content = detail.get("markdown") or detail.get("html") or ""
        if not content.strip():
            continue

        # Chunker si long
        chunks = chunk_text(content)
        for i, chunk in enumerate(chunks):
            title = f"[BookStack] {book_name} / {page_name}" + (f" (part {i+1}/{len(chunks)})" if len(chunks) > 1 else "")
            ch = content_hash(chunk)

            if already_exists(ch):
                print(f"  SKIP: {page_name} chunk {i+1}")
                skipped += 1
                continue

            entry = {
                "question": title,
                "answer": chunk,
                "category": "runbook",
                "tags": json.dumps(["bookstack", book_name.lower().replace(" ", "-")]),
                "author_system": "bookstack_sync",
                "validated": True,
                "confidence_score": 0.9
            }

            if DRY_RUN:
                print(f"  [DRY-RUN] Would push: {title[:80]} ({len(chunk)} chars)")
                pushed += 1
            else:
                if push_to_staging(entry, ch):
                    print(f"  PUSH: {title[:80]} ({len(chunk)} chars)")
                    pushed += 1
                else:
                    print(f"  ERREUR: {title[:80]}")
                    errors += 1

print(f"\n=== RÉSUMÉ ===")
print(f"Pushés:  {pushed}")
print(f"Skippés: {skipped}")
print(f"Erreurs: {errors}")

if not DRY_RUN and pushed > 0:
    vr = requests.post("http://192.168.2.230:4000/bruce/staging/validate",
                       headers={"X-BRUCE-TOKEN": os.environ.get("BRUCE_AUTH_TOKEN", "")})
    print(f"Validate: {'OK' if vr.json().get('ok') else 'ERREUR'}")
