#!/usr/bin/env python3
"""
bruce_media_audit.py — Script réutilisable pour auditer et enrichir media_library.
Déployé sur .230 /home/furycom/bruce-config/scripts/

Modes:
  --enrich-series    : Récupère infos détaillées TMDb pour toutes les séries (saisons, épisodes, complétude)
  --enrich-missing   : Enrichit les entrées sans TMDb/IMDb ID
  --normalize-quality: Normalise quality_tier depuis resolution
  --scan-duplicates  : Détecte doublons cross-disques par TMDb ID et élit best_copy
  --scan-zfs PATH    : Scanne un dossier ZFS et compare avec media_library
  --all              : Exécute tous les modes sauf scan-zfs

Usage:
  python3 bruce_media_audit.py --enrich-series
  python3 bruce_media_audit.py --all
  python3 bruce_media_audit.py --scan-zfs /mnt/RZ1-5TB-4X/RZ1-5TB-4X/Qbit/000\ -\ Fini/
"""

import os, sys, json, time, hashlib, argparse, logging
import requests
from datetime import datetime

# === CONFIG ===
TMDB_TOKEN = open("/home/furycom/bruce-config/tmdb_token.txt").read().strip()
SUPABASE_URL = "http://192.168.2.146:8000/rest/v1"
SUPABASE_KEY = open("/home/furycom/bruce-config/supabase_key_local.txt").read().strip() if os.path.exists("/home/furycom/bruce-config/supabase_key_local.txt") else os.environ.get("SUPABASE_KEY", "")
TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_HEADERS = {"Authorization": f"Bearer {TMDB_TOKEN}", "accept": "application/json"}
SUPA_HEADERS = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Content-Type": "application/json"}
RESULTS_DIR = "/home/furycom/media_audit_results"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("media_audit")

os.makedirs(RESULTS_DIR, exist_ok=True)

# === SUPABASE HELPERS ===
def supa_get(table, params=""):
    """GET from Supabase REST API."""
    h = {k: v for k, v in SUPA_HEADERS.items() if k != "Content-Type"}
    r = requests.get(f"{SUPABASE_URL}/{table}?{params}", headers=h)
    r.raise_for_status()
    return r.json()

def supa_patch(table, match_params, data):
    """PATCH (update) rows in Supabase."""
    h = dict(SUPA_HEADERS)
    h["Prefer"] = "return=minimal"
    r = requests.patch(f"{SUPABASE_URL}/{table}?{match_params}", headers=SUPA_HEADERS, json=data)
    r.raise_for_status()
    return True

def supa_patch_single(table, id_val, data):
    """PATCH a single row by id."""
    return supa_patch(table, f"id=eq.{id_val}", data)

# === TMDB HELPERS ===
def tmdb_get(path, params=None):
    """GET from TMDb API with rate limiting."""
    r = requests.get(f"{TMDB_BASE}{path}", headers=TMDB_HEADERS, params=params or {})
    if r.status_code == 429:
        wait = int(r.headers.get("Retry-After", 2))
        log.warning(f"TMDb rate limited, waiting {wait}s...")
        time.sleep(wait)
        return tmdb_get(path, params)
    r.raise_for_status()
    return r.json()

# === MODE: ENRICH SERIES ===
def enrich_series():
    """Fetch detailed season/episode info from TMDb for all series."""
    log.info("=== ENRICH SERIES ===")
    series = supa_get("media_library", "media_type=eq.series&tmdb_id=not.is.null&is_duplicate=eq.false&select=id,title,tmdb_id,seasons,episodes&order=id.asc")
    log.info(f"Found {len(series)} series with TMDb ID")
    
    updated = 0
    errors = 0
    results = []
    
    for i, s in enumerate(series):
        try:
            tmdb_id = s["tmdb_id"]
            log.info(f"[{i+1}/{len(series)}] {s['title']} (TMDb {tmdb_id})")
            
            tv = tmdb_get(f"/tv/{tmdb_id}", {"language": "fr-CA"})
            
            seasons_total = tv.get("number_of_seasons", 0)
            episodes_total_tmdb = tv.get("number_of_episodes", 0)
            
            # Build seasons_detail: {season_number: {episodes_total, name}}
            seasons_detail = {}
            for sn in tv.get("seasons", []):
                snum = sn.get("season_number", 0)
                if snum == 0:
                    continue  # Skip specials
                seasons_detail[str(snum)] = {
                    "episodes_total": sn.get("episode_count", 0),
                    "name": sn.get("name", f"Saison {snum}")
                }
            
            # seasons_available and episodes_available come from our local data
            seasons_available = s.get("seasons") or 0
            episodes_available = s.get("episodes") or 0
            
            is_complete = (seasons_available >= seasons_total > 0) if seasons_total > 0 else False
            
            patch_data = {
                "seasons_total": seasons_total,
                "episodes_total": episodes_total_tmdb,
                "seasons_available": seasons_available,
                "episodes_available": episodes_available,
                "is_complete": is_complete,
                "seasons_detail": json.dumps(seasons_detail)
            }
            
            supa_patch_single("media_library", s["id"], patch_data)
            updated += 1
            
            result = {
                "id": s["id"], "title": s["title"], "tmdb_id": tmdb_id,
                "seasons_avail": seasons_available, "seasons_total": seasons_total,
                "episodes_avail": episodes_available, "episodes_total": episodes_total_tmdb,
                "complete": is_complete
            }
            results.append(result)
            
            time.sleep(0.3)  # Rate limit respect
            
        except Exception as e:
            log.error(f"  ERROR {s['title']}: {e}")
            errors += 1
    
    # Save results
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    with open(f"{RESULTS_DIR}/series_enrichment_{ts}.json", "w") as f:
        json.dump({"updated": updated, "errors": errors, "results": results}, f, indent=2, ensure_ascii=False)
    
    log.info(f"Series enrichment done: {updated} updated, {errors} errors")
    return updated, errors

# === MODE: NORMALIZE QUALITY ===
def normalize_quality():
    """Normalize quality_tier from resolution field."""
    log.info("=== NORMALIZE QUALITY ===")
    
    # Map resolution patterns to quality tiers
    mappings = [
        ("4K", "4K"), ("2160", "4K"), ("3840", "4K"),
        ("1080", "1080p"), ("1920", "1080p"),
        ("720", "720p"), ("1280", "720p"),
        ("480", "SD"), ("576", "SD"), ("640", "SD"), ("352", "SD"),
    ]
    
    entries = supa_get("media_library", "is_duplicate=eq.false&select=id,resolution,video_definition&quality_tier=eq.unknown&limit=5000")
    log.info(f"Found {len(entries)} entries with quality_tier=unknown")
    
    updated = 0
    for entry in entries:
        res = (entry.get("resolution") or "") + " " + (entry.get("video_definition") or "")
        tier = "unknown"
        for pattern, quality in mappings:
            if pattern.lower() in res.lower():
                tier = quality
                break
        if tier != "unknown":
            supa_patch_single("media_library", entry["id"], {"quality_tier": tier})
            updated += 1
    
    log.info(f"Quality normalization done: {updated} updated")
    return updated

# === MODE: SCAN DUPLICATES ===
def scan_duplicates():
    """Find cross-disk duplicates by TMDb ID and elect best_copy."""
    log.info("=== SCAN DUPLICATES ===")
    
    # Get all entries with tmdb_id, grouped
    entries = supa_get("media_library", "tmdb_id=not.is.null&is_duplicate=eq.false&select=id,title,tmdb_id,disk_inventory_id,quality_tier,file_size_bytes,source&order=tmdb_id.asc,id.asc&limit=10000")
    
    # Group by tmdb_id
    groups = {}
    for e in entries:
        tid = e["tmdb_id"]
        if tid not in groups:
            groups[tid] = []
        groups[tid].append(e)
    
    # Find groups with multiple disks
    quality_rank = {"4K": 4, "1080p": 3, "720p": 2, "SD": 1, "unknown": 0}
    
    duplicates_found = 0
    best_elected = 0
    report = []
    
    for tid, group in groups.items():
        disks = set(e.get("disk_inventory_id") for e in group if e.get("disk_inventory_id"))
        if len(disks) <= 1:
            continue
        
        duplicates_found += 1
        
        # Sort by quality (desc) then file_size (desc) to find best
        sorted_group = sorted(group, key=lambda x: (
            quality_rank.get(x.get("quality_tier", "unknown"), 0),
            x.get("file_size_bytes") or 0
        ), reverse=True)
        
        best = sorted_group[0]
        supa_patch_single("media_library", best["id"], {"is_best_copy": True})
        best_elected += 1
        
        report.append({
            "tmdb_id": tid, "title": best["title"],
            "copies": len(group), "disks": list(disks),
            "best_id": best["id"], "best_quality": best.get("quality_tier"),
            "best_disk": best.get("disk_inventory_id")
        })
    
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    with open(f"{RESULTS_DIR}/duplicates_report_{ts}.json", "w") as f:
        json.dump({"duplicates_found": duplicates_found, "best_elected": best_elected, "report": report}, f, indent=2, ensure_ascii=False)
    
    log.info(f"Duplicate scan done: {duplicates_found} groups, {best_elected} best copies elected")
    return duplicates_found, best_elected

# === MODE: ENRICH MISSING ===
def enrich_missing():
    """Try to find TMDb IDs for entries that have none."""
    log.info("=== ENRICH MISSING IDs ===")
    
    entries = supa_get("media_library", "tmdb_id=is.null&is_duplicate=eq.false&select=id,title,year,media_type&limit=500")
    log.info(f"Found {len(entries)} entries without TMDb ID")
    
    found = 0
    not_found = 0
    
    for i, e in enumerate(entries):
        try:
            mtype = "tv" if e.get("media_type") == "series" else "movie"
            params = {"query": e["title"], "language": "fr-CA"}
            if e.get("year") and mtype == "movie":
                params["year"] = e["year"]
            
            results = tmdb_get(f"/search/{mtype}", params)
            
            if results.get("results"):
                best = results["results"][0]
                patch = {"tmdb_id": str(best["id"])}
                
                # Also get IMDb ID if missing
                if mtype == "movie":
                    detail = tmdb_get(f"/movie/{best['id']}")
                    if detail.get("imdb_id"):
                        patch["imdb_id"] = detail["imdb_id"]
                else:
                    detail = tmdb_get(f"/tv/{best['id']}/external_ids")
                    if detail.get("imdb_id"):
                        patch["imdb_id"] = detail["imdb_id"]
                
                supa_patch_single("media_library", e["id"], patch)
                found += 1
                log.info(f"  [{i+1}] FOUND: {e['title']} -> TMDb {best['id']}")
            else:
                not_found += 1
                log.warning(f"  [{i+1}] NOT FOUND: {e['title']}")
            
            time.sleep(0.3)
            
        except Exception as ex:
            log.error(f"  ERROR {e['title']}: {ex}")
            not_found += 1
    
    log.info(f"Enrich missing done: {found} found, {not_found} not found")
    return found, not_found

# === MODE: FILE SIZE GB ===
def update_file_size_gb():
    """Calculate file_size_gb from file_size_bytes."""
    log.info("=== UPDATE FILE SIZE GB ===")
    entries = supa_get("media_library", "file_size_bytes=not.is.null&file_size_gb=is.null&select=id,file_size_bytes&limit=10000")
    log.info(f"Found {len(entries)} entries to update")
    
    updated = 0
    for e in entries:
        gb = round(e["file_size_bytes"] / (1024**3), 2)
        supa_patch_single("media_library", e["id"], {"file_size_gb": gb})
        updated += 1
    
    log.info(f"File size GB done: {updated} updated")
    return updated

# === MAIN ===
def main():
    parser = argparse.ArgumentParser(description="BRUCE Media Library Audit Tool")
    parser.add_argument("--enrich-series", action="store_true", help="Enrich series with TMDb season/episode details")
    parser.add_argument("--enrich-missing", action="store_true", help="Find TMDb IDs for entries without them")
    parser.add_argument("--normalize-quality", action="store_true", help="Normalize quality_tier from resolution")
    parser.add_argument("--scan-duplicates", action="store_true", help="Find cross-disk duplicates and elect best copy")
    parser.add_argument("--update-sizes", action="store_true", help="Calculate file_size_gb from file_size_bytes")
    parser.add_argument("--all", action="store_true", help="Run all modes")
    
    args = parser.parse_args()
    
    if not any(vars(args).values()):
        parser.print_help()
        return
    
    log.info(f"=== BRUCE MEDIA AUDIT START {datetime.now().isoformat()} ===")
    
    summary = {}
    
    if args.all or args.enrich_missing:
        f, nf = enrich_missing()
        summary["enrich_missing"] = {"found": f, "not_found": nf}
    
    if args.all or args.normalize_quality:
        u = normalize_quality()
        summary["normalize_quality"] = {"updated": u}
    
    if args.all or args.update_sizes:
        u = update_file_size_gb()
        summary["update_sizes"] = {"updated": u}
    
    if args.all or args.enrich_series:
        u, e = enrich_series()
        summary["enrich_series"] = {"updated": u, "errors": e}
    
    if args.all or args.scan_duplicates:
        d, b = scan_duplicates()
        summary["scan_duplicates"] = {"duplicates": d, "best_elected": b}
    
    log.info(f"=== SUMMARY ===")
    for k, v in summary.items():
        log.info(f"  {k}: {v}")
    
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    with open(f"{RESULTS_DIR}/audit_summary_{ts}.json", "w") as f:
        json.dump(summary, f, indent=2)
    
    log.info("=== BRUCE MEDIA AUDIT DONE ===")

if __name__ == "__main__":
    main()