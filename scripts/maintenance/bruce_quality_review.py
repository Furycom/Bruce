#!/usr/bin/env python3
import os
"""
bruce_quality_review.py - Review qualite mensuel BRUCE (spec [482] / tache [713])
Cron: 0 3 1 * * (apres bruce_monthly_review a 2h)

3 axes:
  1. Reclassement importance (garde-fous + deterministe + LLM Qwen max 50 calls)
  2. Contradictions temporelles (via conflict_detector_v3 --dry-run + rapport)
  3. Obsolescence infra (regex IPs x SERVICES_CONFIG + Pulse + LLM)

Regles:
  - Jamais d'ecriture directe -> tout via staging_queue
  - --dry-run : simulation (aucune ecriture)
  - author_system = "bruce_quality_review"
"""
import argparse, json, re, subprocess, sys
from datetime import datetime, date, timedelta
import requests

# ── Config ────────────────────────────────────────────────────────────────────
SUPABASE      = "http://192.168.2.146:8000/rest/v1"
LITELLM       = "http://localhost:4100/v1/chat/completions"
LITELLM_MODEL = "alpha"  # [902]
PULSE_URL     = "http://192.168.2.154:7655/api/resources"
PULSE_TOKEN   = "1f8fdec7944f2b4fd9bc8f4479cef94d9ec64dc4039dbe3eb7815d31e668f8b0"
NTFY_URL      = "http://192.168.2.174:8080/bruce-alerts"
CONFLICT_DET  = "/home/furycom/conflict_detector.py"

SK = os.environ.get("SUPABASE_KEY", "")
SH = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}
AUTHOR = "bruce_quality_review"

# Garde-fous: jamais toucher ces types
PROTECTED_TYPES = {"rule_canon"}

# ── CLI ───────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--dry-run", action="store_true", help="Simulation sans ecriture")
parser.add_argument("--axis", choices=["all","importance","contradictions","obsolescence"], default="all")
parser.add_argument("--max-llm", type=int, default=50, help="Max appels LLM/run")
args = parser.parse_args()
DRY, MAX_LLM = args.dry_run, args.max_llm
llm_calls = 0

# ── Helpers ───────────────────────────────────────────────────────────────────
def log(msg): print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def sb_get(table, params="", limit=2000):
    url = f"{SUPABASE}/{table}?{params}&limit={limit}" if params else f"{SUPABASE}/{table}?limit={limit}"
    r = requests.get(url, headers=SH, timeout=20)
    r.raise_for_status()
    return r.json()

def push_staging(contenu, notes=""):
    """Pousse vers staging_queue -> validate.py. Jamais d'ecriture directe."""
    if DRY:
        log(f"  [DRY] STAGING: {str(contenu)[:100]}")
        return True
    body = {
        "table_cible": "lessons_learned",
        "contenu_json": json.dumps(contenu) if not isinstance(contenu, str) else contenu,
        "author_system": AUTHOR,
        "notes": notes
    }
    r = requests.post(f"{SUPABASE}/staging_queue", headers=SH, json=body, timeout=10)
    return r.status_code in (200, 201)

def notify(title, msg, priority="default"):
    try:
        requests.post(NTFY_URL, data=msg.encode(),
                      headers={"Title": title, "Priority": priority}, timeout=5)
    except Exception as e:
        log(f"  [WARN] ntfy: {e}")

def llm_ask(prompt, max_tokens=150):
    global llm_calls
    if llm_calls >= MAX_LLM:
        return None
    llm_calls += 1
    try:
        r = requests.post(LITELLM, json={
            "model": LITELLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens, "temperature": 0.1
        }, timeout=30)
        if r.ok:
            return r.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        log(f"  [WARN] LLM: {e}")
    return None

def parse_json_resp(text):
    """Extrait le premier JSON trouve dans le texte LLM."""
    if not text:
        return {}
    m = re.search(r'\{[^{}]+\}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except Exception:
            pass
    return {}

def is_protected(lesson):
    """True = jamais declasser (garde-fous mecaniques spec [482])."""
    if lesson.get("canonical_lock"):
        return True
    if lesson.get("lesson_type") in PROTECTED_TYPES:
        return True
    txt = lesson.get("lesson_text", "") or ""
    if "error_pattern_tracker" in txt.lower():
        return True
    return False

def deterministic_downgrade(lesson):
    """
    Retourne (new_importance, reason) si regle deterministe applicable.
    Regle: diagnostic/warning > 60j -> high
    """
    lt = lesson.get("lesson_type", "")
    created_raw = lesson.get("created_at") or lesson.get("date_learned") or ""
    if lt in ("diagnostic", "warning") and created_raw:
        try:
            created = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
            age = (datetime.now(created.tzinfo) - created).days
            if age > 60:
                return "high", f"{lt} age {age}j (>60j) sans recurrence confirmee"
        except Exception:
            pass
    return None, None

# ═══════════════════════════════════════════════════════════════
# MODULE 1 : Reclassement importance
# ═══════════════════════════════════════════════════════════════
def module_importance():
    log("=== MODULE 1 : Reclassement importance ===")
    st = {"protected": 0, "deterministic": 0, "llm_downgrade": 0, "llm_maintain": 0, "llm_skip": 0}

    lessons = sb_get("lessons_learned",
                     "select=id,lesson_text,lesson_type,importance,canonical_lock,"
                     "confidence_score,created_at,date_learned"
                     "&importance=eq.critical&validated=eq.true", limit=300)
    log(f"  {len(lessons)} lessons critical a analyser")

    for l in lessons:
        lid = l["id"]

        # 1. Garde-fous mecaniques
        if is_protected(l):
            st["protected"] += 1
            continue

        # 2. Declassement deterministe
        new_imp, reason = deterministic_downgrade(l)
        if new_imp:
            log(f"  [DET] #{lid}: critical -> {new_imp} ({reason})")
            push_staging({"id": lid, "importance": new_imp, "author_system": AUTHOR},
                         notes=f"[713] det-downgrade #{lid}: {reason}")
            st["deterministic"] += 1
            continue

        # 3. Jugement LLM pour ambigus
        if llm_calls >= MAX_LLM:
            st["llm_skip"] += 1
            continue

        txt  = (l.get("lesson_text") or "")[:500]
        lt   = l.get("lesson_type", "")
        conf = l.get("confidence_score", 0.5)
        prompt = (
            f"Lecon homelab. TYPE: {lt} | CONF: {conf}\n"
            f"TEXTE: {txt}\n\n"
            f"Cette lecon est CRITICAL. Est-ce encore justifie aujourd'hui?\n"
            f'Reponds UNIQUEMENT JSON: {{"verdict":"CRITICAL_STILL"|"DOWNGRADE_HIGH"|"DOWNGRADE_NORMAL",'
            f'"confidence":0.0-1.0,"raison":"courte"}}'
        )

        result   = parse_json_resp(llm_ask(prompt))
        verdict  = result.get("verdict", "CRITICAL_STILL")
        llm_conf = float(result.get("confidence", 0.5))
        raison   = result.get("raison", "")

        if llm_conf < 0.7:
            st["llm_maintain"] += 1
            continue

        if verdict in ("DOWNGRADE_HIGH", "DOWNGRADE_NORMAL"):
            new_v = "high" if verdict == "DOWNGRADE_HIGH" else "normal"
            push_staging({"id": lid, "importance": new_v, "author_system": AUTHOR},
                         notes=f"[713] llm-downgrade #{lid}: {raison[:80]}")
            log(f"  [LLM] #{lid}: critical -> {new_v} ({raison[:50]})")
            st["llm_downgrade"] += 1
        else:
            st["llm_maintain"] += 1

    log(f"  Stats M1: {st}")
    return st

# ═══════════════════════════════════════════════════════════════
# MODULE 2 : Contradictions temporelles
# ═══════════════════════════════════════════════════════════════
def module_contradictions():
    log("=== MODULE 2 : Contradictions temporelles (conflict_detector_v3) ===")
    st = {"detected": 0, "auto_resolved": 0, "vllm_resolved": 0, "clarif": 0, "errors": 0}
    try:
        result = subprocess.run(
            ["python3", CONFLICT_DET, "--dry-run", "--only", "lessons"],
            capture_output=True, text=True, timeout=120
        )
        out = result.stdout + result.stderr
        # Extraire compteurs depuis la sortie
        for line in out.splitlines():
            for key in ("auto_resolved", "vllm_resolved", "clarif_created"):
                m = re.search(rf"'{key}':\s*(\d+)", line)
                if m:
                    st[key.replace("_created", "")] = int(m.group(1))
        st["detected"] = st["auto_resolved"] + st["vllm_resolved"] + st["clarif"]
        log(f"  conflict_detector: {st}")
        if st["detected"] > 10 and not DRY:
            log("  => >10 contradictions detectees - lancer conflict_detector sans --dry-run recommande")
    except subprocess.TimeoutExpired:
        log("  [WARN] conflict_detector timeout 120s")
        st["errors"] += 1
    except Exception as e:
        log(f"  [ERROR] {e}")
        st["errors"] += 1
    return st

# ═══════════════════════════════════════════════════════════════
# MODULE 3 : Obsolescence infra
# ═══════════════════════════════════════════════════════════════
def module_obsolescence():
    log("=== MODULE 3 : Obsolescence infra ===")
    st = {"scanned": 0, "candidates": 0, "likely_obsolete": 0, "possibly_obsolete": 0, "llm_calls": 0}

    # IPs actives depuis SERVICES_CONFIG
    active_ips = set()
    try:
        cs = sb_get("current_state", "select=value&key=eq.SERVICES_CONFIG")
        if cs:
            svc = json.loads(cs[0]["value"])
            for s in svc.get("services", []):
                active_ips.update(re.findall(r"192\.168\.\d+\.\d+", s.get("url", "")))
        log(f"  IPs SERVICES_CONFIG: {sorted(active_ips)}")
    except Exception as e:
        log(f"  [WARN] SERVICES_CONFIG: {e}")

    # IPs depuis Pulse
    try:
        r = requests.get(PULSE_URL, headers={"Authorization": f"Bearer {PULSE_TOKEN}"}, timeout=10)
        if r.ok:
            for res in r.json():
                active_ips.update(re.findall(r"192\.168\.\d+\.\d+",
                                             str(res.get("ip", "") or res.get("address", ""))))
        log(f"  Total IPs actives: {len(active_ips)}")
    except Exception as e:
        log(f"  [WARN] Pulse: {e}")

    # Lessons >90j critical/high avec IPs mortes
    cutoff = (datetime.now() - timedelta(days=90)).isoformat()
    lessons = sb_get("lessons_learned",
                     f"select=id,lesson_text,lesson_type,importance,created_at"
                     f"&validated=eq.true&importance=in.(critical,high)&created_at=lt.{cutoff}",
                     limit=500)
    st["scanned"] = len(lessons)
    log(f"  {len(lessons)} lessons a scanner (>90j, critical/high)")

    for l in lessons:
        if st["candidates"] >= 20 or llm_calls >= MAX_LLM:
            break
        txt = l.get("lesson_text", "") or ""
        found_ips = set(re.findall(r"192\.168\.\d+\.\d+", txt))
        dead_ips  = found_ips - active_ips
        if not found_ips or not dead_ips:
            continue
        if is_protected(l):
            continue
        st["candidates"] += 1

        prompt = (
            f"Lecon homelab. IPs mentionnees: {sorted(found_ips)}. "
            f"IPs actives connues: {sorted(active_ips)}. "
            f"IPs absentes de l'infra: {sorted(dead_ips)}.\n"
            f"TEXTE: {txt[:400]}\n"
            f'JSON: {{"verdict":"CURRENT"|"POSSIBLY_OBSOLETE"|"LIKELY_OBSOLETE",'
            f'"confidence":0.0-1.0,"raison":"courte"}}'
        )

        result   = parse_json_resp(llm_ask(prompt, max_tokens=100))
        st["llm_calls"] += 1
        verdict  = result.get("verdict", "CURRENT")
        llm_conf = float(result.get("confidence", 0.5))
        raison   = result.get("raison", "")

        if llm_conf < 0.6:
            continue

        if verdict == "LIKELY_OBSOLETE":
            log(f"  [OBS] #{l['id']}: LIKELY_OBSOLETE (IPs mortes: {dead_ips})")
            push_staging({"id": l["id"], "importance": "low", "author_system": AUTHOR},
                         notes=f"[713] obsolescence #{l['id']}: {raison[:80]}")
            st["likely_obsolete"] += 1
        elif verdict == "POSSIBLY_OBSOLETE":
            log(f"  [OBS] #{l['id']}: POSSIBLY_OBSOLETE (IPs: {dead_ips})")
            st["possibly_obsolete"] += 1

    log(f"  Stats M3: {st}")
    return st

# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════
def main():
    started = datetime.now()
    log(f"=== BRUCE Quality Review {started:%Y-%m-%d %H:%M} "
        f"| dry={DRY} | axis={args.axis} | max-llm={MAX_LLM} ===")

    results = {}
    if args.axis in ("all", "importance"):
        results["importance"]     = module_importance()
    if args.axis in ("all", "contradictions"):
        results["contradictions"] = module_contradictions()
    if args.axis in ("all", "obsolescence"):
        results["obsolescence"]   = module_obsolescence()

    elapsed = int((datetime.now() - started).total_seconds())
    rapport = (
        f"BRUCE Quality Review {date.today()} | dry={DRY} | llm={llm_calls}/{MAX_LLM} | {elapsed}s | "
        + " | ".join(f"{k}={json.dumps(v)}" for k, v in results.items())
    )
    log(f"=== RAPPORT FINAL: {rapport} ===")

    # Rapport en KB via staging
    push_staging({
        "lesson_type": "maintenance",
        "lesson_text": rapport,
        "importance": "normal",
        "confidence_score": 1.0,
        "date_learned": str(date.today()),
        "author_system": AUTHOR
    }, notes="[713] rapport quality review mensuel")

    # Alerte ntfy
    total_deg = sum(
        (v.get("deterministic", 0) + v.get("llm_downgrade", 0) + v.get("likely_obsolete", 0))
        for v in results.values() if isinstance(v, dict)
    )
    notify("BRUCE Quality Review", rapport[:500], priority="high" if total_deg > 5 else "default")
    log("Done.")

if __name__ == "__main__":
    main()
