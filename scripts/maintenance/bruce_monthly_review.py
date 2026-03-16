#!/usr/bin/env python3
import os
"""
bruce_monthly_review.py - Rapport qualité mensuel BRUCE
Cron: 0 2 1 * * (1er du mois à 2h)
Modules: (1) normalize, (2) doublons hash, (3) leçons vides, (4) distribution importance
"""
import requests
import json
import hashlib
from datetime import datetime, date
from collections import Counter

SUPABASE_URL = "http://192.168.2.146:8000/rest/v1"
APIKEY = os.environ.get("SUPABASE_KEY", "")
NTFY_URL = "http://192.168.2.174:8080/bruce-alerts"

HEADERS = {
    "apikey": APIKEY,
    "Authorization": f"Bearer {APIKEY}",
    "Content-Type": "application/json",
    "Accept": "application/json"
}

LESSON_TYPES_CANON = {
    "solution", "diagnostic", "rule_canon", "discovery", "anti_pattern",
    "decision", "user_wish", "maintenance", "architecture", "warning"
}

def sb_get(table, params=""):
    r = requests.get(f"{SUPABASE_URL}/{table}?{params}", headers=HEADERS)
    r.raise_for_status()
    return r.json()

def sb_patch(table, filter_param, payload):
    r = requests.patch(
        f"{SUPABASE_URL}/{table}?{filter_param}",
        headers=HEADERS,
        json=payload
    )
    r.raise_for_status()
    return r

def push_staging(table_cible, contenu):
    r = requests.post(
        f"{SUPABASE_URL}/staging_queue",
        headers=HEADERS,
        json={"table_cible": table_cible, "contenu_json": contenu}
    )
    r.raise_for_status()

def notify(title, message, priority="default"):
    try:
        requests.post(NTFY_URL, data=message.encode(),
                      headers={"Title": title, "Priority": priority}, timeout=5)
    except Exception:
        pass

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

# ─────────────────────────────────────────────
# MODULE 1 : Normalize lesson_type
# ─────────────────────────────────────────────
def module_normalize():
    log("=== MODULE 1 : normalize lesson_type ===")
    lessons = sb_get("lessons_learned", "select=id,lesson_type&validated=eq.true&limit=2000")
    fixes = 0
    TYPE_MAP = {
        "anti-pattern": "anti_pattern",
        "antipattern": "anti_pattern",
        "decouverte": "discovery",
        "bug-fix": "solution",
        "bugfix": "solution",
        "brainstorming": "user_wish",
        "maintenance-report-archived": "maintenance",
        "maintenance-report": "maintenance",
        "rule": "rule_canon",
        "regle": "rule_canon",
    }
    for l in lessons:
        lt = (l.get("lesson_type") or "").strip()
        # Pipes -> premier type
        if "|" in lt:
            new_lt = lt.split("|")[0].strip()
        elif lt.lower() in TYPE_MAP:
            new_lt = TYPE_MAP[lt.lower()]
        elif lt not in LESSON_TYPES_CANON:
            new_lt = "discovery"  # fallback pour types inconnus
        else:
            continue
        sb_patch("lessons_learned", f"id=eq.{l['id']}", {"lesson_type": new_lt})
        log(f"  Fix lesson #{l['id']}: '{lt}' -> '{new_lt}'")
        fixes += 1
    log(f"  Normalize: {fixes} corrections")
    return fixes

# ─────────────────────────────────────────────
# MODULE 2 : Doublons par content_hash
# ─────────────────────────────────────────────
def module_doublons_hash():
    log("=== MODULE 2 : doublons content_hash ===")
    lessons = sb_get("lessons_learned",
                     "select=id,lesson_text,content_hash,date_learned&validated=eq.true"
                     "&content_hash=not.is.null&order=id.asc&limit=2000")
    hash_map = {}
    doublons = []
    for l in lessons:
        h = l["content_hash"]
        if h in hash_map:
            # Garder le plus récent (id plus grand), déprécier l'ancien
            older = hash_map[h] if hash_map[h]["id"] < l["id"] else l
            newer = l if hash_map[h]["id"] < l["id"] else hash_map[h]
            doublons.append((older["id"], newer["id"], h))
            hash_map[h] = newer
        else:
            hash_map[h] = l

    log(f"  {len(doublons)} doublons hash détectés")
    for old_id, new_id, h in doublons:
        push_staging("lessons_learned", {
            "id": old_id,
            "validated": False,
            "lesson_type": "maintenance",
            "lesson_text": f"[SUPERSEDED] Doublon hash de lesson #{new_id} (hash={h[:16]}). Déprecié par bruce_monthly_review.",
            "importance": "low",
            "author_system": "bruce_monthly_review"
        })
        log(f"  Doublon: #{old_id} supersede par #{new_id}")
    return len(doublons)

# ─────────────────────────────────────────────
# MODULE 3 : Leçons vides ou trop courtes
# ─────────────────────────────────────────────
def module_lecons_vides():
    log("=== MODULE 3 : leçons vides/courtes ===")
    lessons = sb_get("lessons_learned",
                     "select=id,lesson_text,importance&validated=eq.true&limit=2000")
    vides = []
    courtes = []
    for l in lessons:
        txt = (l.get("lesson_text") or "").strip()
        if not txt:
            vides.append(l["id"])
        elif len(txt) < 30:
            courtes.append((l["id"], txt))
    log(f"  Leçons vides: {len(vides)}")
    log(f"  Leçons < 30 chars: {len(courtes)}")
    for lid in vides:
        push_staging("lessons_learned", {
            "id": lid,
            "lesson_type": "maintenance",
            "lesson_text": "[VIDE] Leçon sans contenu détectée par bruce_monthly_review.",
            "importance": "low",
            "validated": False,
            "author_system": "bruce_monthly_review"
        })
    for lid, txt in courtes:
        log(f"    #{lid}: '{txt}'")
    return len(vides), len(courtes)

# ─────────────────────────────────────────────
# MODULE 4 : Distribution importance + alerte
# ─────────────────────────────────────────────
def module_distribution():
    log("=== MODULE 4 : distribution importance ===")
    lessons = sb_get("lessons_learned",
                     "select=importance,lesson_type&validated=eq.true&limit=2000")
    total = len(lessons)
    imp_counts = Counter(l.get("importance", "unknown") for l in lessons)
    type_counts = Counter(l.get("lesson_type", "unknown") for l in lessons)

    log(f"  Total lessons validées: {total}")
    for imp, cnt in sorted(imp_counts.items(), key=lambda x: -x[1]):
        pct = cnt / total * 100 if total else 0
        log(f"  importance={imp}: {cnt} ({pct:.1f}%)")

    critical_pct = imp_counts.get("critical", 0) / total * 100 if total else 0
    alerte_critical = critical_pct > 15

    log(f"  Top lesson_types: {type_counts.most_common(5)}")

    if alerte_critical:
        msg = f"ALERTE: {critical_pct:.1f}% des lessons sont critical (seuil 15%). Revoir importance."
        log(f"  ⚠️  {msg}")
        notify("BRUCE Monthly Review - ALERTE", msg, priority="high")

    return {
        "total": total,
        "distribution": dict(imp_counts),
        "critical_pct": round(critical_pct, 1),
        "alerte_critical": alerte_critical,
        "top_types": dict(type_counts.most_common(5))
    }

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    started = datetime.now()
    log(f"=== BRUCE Monthly Review démarré {started.strftime('%Y-%m-%d %H:%M')} ===")

    fixes_norm = module_normalize()
    doublons = module_doublons_hash()
    vides, courtes = module_lecons_vides()
    distrib = module_distribution()

    elapsed = (datetime.now() - started).seconds
    rapport = (
        f"BRUCE Monthly Review {date.today()}: "
        f"normalize={fixes_norm} fixes, doublons={doublons}, "
        f"vides={vides}, courtes={courtes}, "
        f"critical={distrib['critical_pct']}% (alerte={'OUI' if distrib['alerte_critical'] else 'non'}), "
        f"total_lessons={distrib['total']}, elapsed={elapsed}s"
    )
    log(f"=== RAPPORT FINAL: {rapport} ===")

    # Enregistrer le rapport comme lesson
    push_staging("lessons_learned", {
        "lesson_type": "maintenance",
        "lesson_text": rapport,
        "importance": "normal",
        "confidence_score": 1.0,
        "date_learned": str(date.today()),
        "author_system": "bruce_monthly_review",
        "tags": ["maintenance", "qualite", "cron", "monthly"]
    })
    notify("BRUCE Monthly Review terminé", rapport)
    log("Done.")

if __name__ == "__main__":
    main()
