#!/usr/bin/env python3
"""bruce_tmdb_enrich.py - Enrichit media_library avec TMDb."""
import os, sys, json, time, requests

TMDB_TOKEN = open("/home/furycom/bruce-config/tmdb_token.txt").read().strip()
SUPA_URL = "http://192.168.2.146:8000/rest/v1"
SUPA_KEY = open("/home/furycom/bruce-config/supabase_key.txt").read().strip()
TMDB_H = {"Authorization": f"Bearer {TMDB_TOKEN}", "Accept": "application/json"}
SUPA_H = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}", "Content-Type": "application/json"}
PROGRESS = "/tmp/tmdb_enrich_progress.json"

def search_tmdb(title, year=None, mtype="movie"):
    ep = "movie" if mtype == "movie" else "tv"
    params = {"query": title, "language": "fr-CA"}
    if year:
        params["year" if ep == "movie" else "first_air_date_year"] = year
    try:
        r = requests.get(f"https://api.themoviedb.org/3/search/{ep}", headers=TMDB_H, params=params, timeout=10)
        if r.status_code == 200 and r.json().get("results"):
            return r.json()["results"][0]
        if year:
            params.pop("year", None); params.pop("first_air_date_year", None)
            r = requests.get(f"https://api.themoviedb.org/3/search/{ep}", headers=TMDB_H, params=params, timeout=10)
            if r.status_code == 200 and r.json().get("results"):
                return r.json()["results"][0]
    except Exception as e:
        print(f"  ERR search: {e}")
    return None

def get_details(tid, mtype="movie"):
    ep = "movie" if mtype == "movie" else "tv"
    try:
        r = requests.get(f"https://api.themoviedb.org/3/{ep}/{tid}", headers=TMDB_H, params={"language": "fr-CA"}, timeout=10)
        return r.json() if r.status_code == 200 else None
    except: return None

def main():
    r = requests.get(f"{SUPA_URL}/media_library?tmdb_id=is.null&is_duplicate=eq.false&select=id,title,year,media_type&order=id.asc",
        headers={"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}, timeout=15)
    entries = r.json() if r.status_code == 200 else []
    total = len(entries)
    print(f"Found {total} entries to enrich")
    stats = {"total": total, "ok": 0, "nf": 0, "err": 0}
    nf = []
    for i, e in enumerate(entries):
        title, year, mtype = e["title"], e.get("year"), e.get("media_type", "movie")
        print(f"[{i+1}/{total}] {title} ({year}) [{mtype}]...", end=" ", flush=True)
        with open(PROGRESS, "w") as f: json.dump({"step": i+1, "total": total, "title": title, **stats}, f)
        res = search_tmdb(title, year, mtype)
        if not res:
            print("NOT FOUND"); stats["nf"] += 1; nf.append(e); time.sleep(0.25); continue
        tid = str(res["id"])
        det = get_details(tid, mtype)
        if not det:
            print("DETAILS FAIL"); stats["err"] += 1; time.sleep(0.25); continue
        upd = {"tmdb_id": tid}
        if det.get("genres"): upd["genres"] = ", ".join(g["name"] for g in det["genres"])
        if det.get("overview"): upd["plot"] = det["overview"][:2000]
        if det.get("vote_average"): upd["rating"] = f"tmdb - {det['vote_average']:.1f}/10"
        if mtype == "movie":
            if det.get("imdb_id"): upd["imdb_id"] = det["imdb_id"]
            if det.get("runtime"): upd["duration_min"] = det["runtime"]
        else:
            if det.get("number_of_seasons"): upd["seasons"] = det["number_of_seasons"]
            if det.get("number_of_episodes"): upd["episodes"] = det["number_of_episodes"]
            try:
                ext = requests.get(f"https://api.themoviedb.org/3/tv/{tid}/external_ids", headers=TMDB_H, timeout=10)
                if ext.status_code == 200 and ext.json().get("imdb_id"): upd["imdb_id"] = ext.json()["imdb_id"]
            except: pass
        if not year and det.get("release_date" if mtype == "movie" else "first_air_date"):
            try: upd["year"] = int(det.get("release_date" if mtype == "movie" else "first_air_date")[:4])
            except: pass
        if det.get("production_countries" if mtype == "movie" else "origin_country"):
            cs = det.get("production_countries", det.get("origin_country", []))
            if isinstance(cs, list) and cs:
                upd["country"] = ", ".join((c.get("iso_3166_1", c) if isinstance(c, dict) else c) for c in cs[:3])
        try:
            rr = requests.patch(f"{SUPA_URL}/media_library?id=eq.{e['id']}", headers=SUPA_H, json=upd, timeout=10)
            if rr.status_code in (200, 204): print(f"OK TMDb {tid}"); stats["ok"] += 1
            else: print(f"UPD FAIL {rr.status_code}"); stats["err"] += 1
        except: print("UPD ERR"); stats["err"] += 1
        time.sleep(0.25)
    with open(PROGRESS, "w") as f: json.dump({"phase": "done", **stats}, f)
    with open("/home/furycom/bruce-config/scripts/tmdb_not_found.json", "w") as f: json.dump(nf, f, indent=2)
    print(f"\nDONE: {stats['ok']}/{total} enriched, {stats['nf']} not found, {stats['err']} errors")

if __name__ == "__main__": main()
