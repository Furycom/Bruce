#!/usr/bin/env python3
"""Populate bruce_uid for all media_library entries."""
import requests

KEY = open("/home/furycom/bruce-config/supabase_key_local.txt").read().strip()
H_GET = {"apikey": KEY, "Authorization": f"Bearer {KEY}"}
H_PATCH = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "Prefer": "return=minimal"}
BASE = "http://192.168.2.146:8000/rest/v1"

# Get all entries without bruce_uid
r = requests.get(f"{BASE}/media_library?bruce_uid=is.null&select=id,tmdb_id&limit=6000", headers=H_GET)
entries = r.json()
print(f"Found {len(entries)} without bruce_uid")

tmdb_count = 0
local_count = 0
for i, e in enumerate(entries):
    tmdb_id = e.get("tmdb_id")
    entry_id = e["id"]
    if tmdb_id:
        uid = f"tmdb:{tmdb_id}"
        tmdb_count += 1
    else:
        uid = f"local:{entry_id}"
        local_count += 1
    requests.patch(f"{BASE}/media_library?id=eq.{entry_id}", headers=H_PATCH, json={"bruce_uid": uid})
    if (i + 1) % 500 == 0:
        print(f"  Progress: {i+1}/{len(entries)}")

print(f"Done: {tmdb_count} tmdb, {local_count} local, {tmdb_count + local_count} total")