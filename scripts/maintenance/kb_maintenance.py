#!/usr/bin/env python3
import os
"""
kb_maintenance.py v2 — Job LLM de maintenance avec AUTO-CORRECTION
Conçu par Claude Opus session 18, v2 par Opus session 92.

MODES:
  --dry-run     Analyse sans écriture (rapport seulement)
  --auto-fix    Applique les corrections automatiques (default pour cron)
  --only X      Exécuter seulement: contradictions|doublons|roadmap

CHANGEMENTS v2 (session Opus 92):
  - Mode --auto-fix: suppression directe des doublons overlap>=0.8
  - Doublons 0.35<overlap<0.8: proposés via staging_queue pour review
  - Contradictions high: staging_queue avec suggestion de résolution
  - Notification ntfy résumé après chaque run
  - Protection canonical_lock=true (jamais touchée)
  - Nettoyage des chunks/embeddings orphelins après suppression
  - Log structuré de chaque action corrective

Usage:
  python3 kb_maintenance.py                    # Auto-fix (default)
  python3 kb_maintenance.py --dry-run          # Analyse sans écriture
  python3 kb_maintenance.py --auto-fix         # Explicite auto-fix
  python3 kb_maintenance.py --only doublons    # Un seul module
"""

import json, sys, time, os, subprocess, requests, hashlib
from datetime import datetime, timezone
from collections import defaultdict

# === CONFIG ===
SUPABASE = "http://192.168.2.146:8000/rest/v1"
SK = os.environ.get("SUPABASE_KEY", "")
VLLM_BASE = "http://192.168.2.230:4100/v1"  # [902] LiteLLM proxy
VLLM_KEY = "token-abc123"
VLLM_MODEL = "Qwen/Qwen2.5-7B-Instruct-AWQ"
VALIDATE_URL = "http://192.168.2.230:4001/run/validate"
VALIDATE_TOKEN = os.environ.get("BRUCE_AUTH_TOKEN", "")
NTFY_URL = "http://192.168.2.174:8080/bruce-alerts"

# Seuils
COSINE_DOUBLON_THRESHOLD = 0.92
HIGH_OVERLAP_THRESHOLD = 0.80    # v2: auto-suppression au-dessus
LOW_OVERLAP_THRESHOLD = 0.35     # En dessous = pas un doublon
CONTRADICTION_BATCH_SIZE = 20
MAX_LESSONS_PER_TYPE = 50

SB_HEADERS = {
    "apikey": SK,
    "Authorization": f"Bearer {SK}",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Prefer": "return=minimal"
}

SB_HEADERS_RETURN = {
    "apikey": SK,
    "Authorization": f"Bearer {SK}",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "Prefer": "return=representation"
}

# Modes
DRY_RUN = "--dry-run" in sys.argv
AUTO_FIX = not DRY_RUN  # v2: auto-fix est le default
ONLY = None
if "--only" in sys.argv:
    idx = sys.argv.index("--only")
    ONLY = sys.argv[idx + 1] if idx + 1 < len(sys.argv) else None

# Action log — v2: track all corrective actions
ACTIONS_LOG = []

# === HELPERS ===
def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def action_log(action_type, detail):
    """v2: Log every corrective action for traceability."""
    entry = {
        "timestamp": datetime.now().isoformat(),
        "action": action_type,
        "detail": detail,
        "dry_run": DRY_RUN
    }
    ACTIONS_LOG.append(entry)
    log(f"  {'[DRY-RUN] ' if DRY_RUN else ''}ACTION: {action_type} — {json.dumps(detail, ensure_ascii=False)[:120]}")

def sb_get(path):
    r = requests.get(f"{SUPABASE}/{path}", headers=SB_HEADERS_RETURN, timeout=15)
    r.raise_for_status()
    t = r.text.strip()
    return json.loads(t) if t else []

def sb_post(table, body):
    r = requests.post(f"{SUPABASE}/{table}", headers=SB_HEADERS_RETURN, json=body, timeout=15)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"POST {table}: {r.status_code} {r.text[:200]}")
    t = r.text.strip()
    return json.loads(t) if t else {}

def sb_delete(table, filter_str):
    """v2: DELETE via Supabase REST API."""
    if DRY_RUN:
        log(f"  [DRY-RUN] Would DELETE {table}?{filter_str}")
        return True
    r = requests.delete(f"{SUPABASE}/{table}?{filter_str}", headers=SB_HEADERS, timeout=15)
    if r.status_code not in (200, 204):
        raise RuntimeError(f"DELETE {table}?{filter_str}: {r.status_code} {r.text[:200]}")
    return True

def sb_patch(table, filter_str, body):
    """v2: PATCH via Supabase REST API."""
    if DRY_RUN:
        log(f"  [DRY-RUN] Would PATCH {table}?{filter_str}")
        return True
    r = requests.patch(f"{SUPABASE}/{table}?{filter_str}", headers=SB_HEADERS, json=body, timeout=15)
    if r.status_code not in (200, 204):
        raise RuntimeError(f"PATCH {table}?{filter_str}: {r.status_code} {r.text[:200]}")
    return True

def ask_llm(system_prompt, user_prompt, max_tokens=500):
    """Appelle le vLLM local avec un prompt système et utilisateur."""
    try:
        r = requests.post(f"{VLLM_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {VLLM_KEY}", "Content-Type": "application/json"},
            json={
                "model": VLLM_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                "max_tokens": max_tokens,
                "temperature": 0.1
            },
            timeout=60
        )
        r.raise_for_status()
        data = r.json()
        return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        log(f"  LLM ERROR: {e}")
        return None

def push_staging(table, content, author="kb-maintenance-v2"):
    """Push un résultat dans staging_queue."""
    if DRY_RUN:
        log(f"  [DRY-RUN] Would stage to {table}: {json.dumps(content, ensure_ascii=False)[:120]}...")
        return True
    body = {
        "table_cible": table,
        "contenu_json": json.dumps(content, ensure_ascii=False),
        "author_system": author,
        "status": "pending"
    }
    try:
        sb_post("staging_queue", body)
        return True
    except Exception as e:
        log(f"  STAGING ERROR: {e}")
        return False

def validate():
    """Appelle validate_service pour promouvoir les entrées staging."""
    if DRY_RUN:
        log("  [DRY-RUN] Would call validate")
        return
    try:
        r = requests.post(VALIDATE_URL, headers={"X-BRUCE-TOKEN": VALIDATE_TOKEN}, timeout=30)
        data = r.json()
        log(f"  Validate: ok={data.get('ok')}")
    except Exception as e:
        log(f"  Validate error: {e}")

def notify_ntfy(title, message, priority="default"):
    """v2: Envoie une notification ntfy."""
    try:
        # Encode title as ASCII-safe for headers
        safe_title = title.encode("ascii", errors="replace").decode("ascii")
        requests.post(NTFY_URL,
            headers={"Title": safe_title, "Priority": priority, "Tags": "robot"},
            data=message.encode("utf-8"),
            timeout=10
        )
    except Exception as e:
        log(f"  NTFY ERROR: {e}")

def content_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# =============================================================================
# v2: AUTO-CORRECTION — Suppression doublons et nettoyage chunks
# =============================================================================
def delete_lesson_and_chunks(lesson_id, reason):
    """v2: Supprime une leçon ET ses chunks/embeddings associés."""
    action_log("delete_lesson", {"lesson_id": lesson_id, "reason": reason})

    if DRY_RUN:
        return True

    try:
        # 1. Trouver les chunks liés à cette leçon
        chunks = sb_get(f"bruce_chunks?select=chunk_id&anchor->>source_id=eq.{lesson_id}&anchor->>source_table=eq.lessons_learned")
        chunk_ids = [c["chunk_id"] for c in chunks]

        # 2. Supprimer embeddings des chunks trouvés
        for cid in chunk_ids:
            try:
                sb_delete("bruce_embeddings", f"chunk_id=eq.{cid}")
            except Exception as e:
                log(f"    Warning: could not delete embedding for chunk {cid}: {e}")

        # 3. Supprimer les chunks
        for cid in chunk_ids:
            try:
                sb_delete("bruce_chunks", f"chunk_id=eq.{cid}")
            except Exception as e:
                log(f"    Warning: could not delete chunk {cid}: {e}")

        # 4. Supprimer la leçon
        sb_delete("lessons_learned", f"id=eq.{lesson_id}")

        log(f"    ✅ Deleted lesson {lesson_id} + {len(chunk_ids)} chunks + embeddings")
        return True
    except Exception as e:
        log(f"    ❌ Failed to delete lesson {lesson_id}: {e}")
        return False


# =============================================================================
# ANALYSE 1 : DÉTECTION DE CONTRADICTIONS (inchangé + staging auto-fix)
# =============================================================================
def detect_contradictions():
    log("=== ANALYSE 1: CONTRADICTIONS ===")

    lessons = sb_get("lessons_learned?select=id,lesson_text,lesson_type,importance,confidence_score,canonical_lock&validated=eq.true&order=id.desc&limit=300")
    log(f"  {len(lessons)} leçons validées chargées")

    by_type = defaultdict(list)
    for l in lessons:
        by_type[l.get("lesson_type", "unknown")].append(l)

    active_types = {k: v for k, v in by_type.items() if len(v) >= 2}
    log(f"  {len(active_types)} types avec 2+ leçons")

    contradictions_found = []
    pairs_checked = 0

    SYSTEM_PROMPT = """Tu es un analyste de base de connaissances. On te donne deux leçons du même domaine.
Réponds UNIQUEMENT en JSON valide avec cette structure:
{"contradiction": true/false, "severity": "high"/"medium"/"low", "explanation": "...en 1-2 phrases"}

Règles:
- contradiction=true SEULEMENT si les deux leçons affirment des choses incompatibles
- Deux leçons sur le même sujet avec des détails différents ne sont PAS une contradiction
- Une leçon qui COMPLÈTE l'autre n'est PAS une contradiction
- severity=high si suivre les deux simultanément causerait un problème"""

    for ltype, group in active_types.items():
        group = sorted(group, key=lambda x: x.get("confidence_score", 0), reverse=True)[:MAX_LESSONS_PER_TYPE]

        for i in range(len(group)):
            for j in range(i+1, min(len(group), i+10)):
                a, b = group[i], group[j]

                user_prompt = f"""Domaine: {ltype}

LEÇON A (id={a['id']}, confiance={a.get('confidence_score',0)}):
{a['lesson_text'][:500]}

LEÇON B (id={b['id']}, confiance={b.get('confidence_score',0)}):
{b['lesson_text'][:500]}"""

                pairs_checked += 1
                result = ask_llm(SYSTEM_PROMPT, user_prompt, max_tokens=200)
                if not result:
                    continue

                try:
                    clean = result.strip()
                    if clean.startswith("```"):
                        clean = clean.split("\n", 1)[1].rsplit("```", 1)[0]
                    parsed = json.loads(clean)

                    if parsed.get("contradiction"):
                        severity = parsed.get("severity", "medium")
                        explanation = parsed.get("explanation", "")
                        log(f"  ⚠️  CONTRADICTION {severity}: lesson {a['id']} vs {b['id']}: {explanation[:80]}")
                        contradictions_found.append({
                            "lesson_a_id": a["id"],
                            "lesson_b_id": b["id"],
                            "lesson_a_lock": a.get("canonical_lock", False),
                            "lesson_b_lock": b.get("canonical_lock", False),
                            "lesson_type": ltype,
                            "severity": severity,
                            "explanation": explanation,
                            "lesson_a_text": a["lesson_text"][:200],
                            "lesson_b_text": b["lesson_text"][:200]
                        })
                except (json.JSONDecodeError, KeyError) as e:
                    log(f"  Parse error for pair {a['id']}/{b['id']}: {e}")
                    continue

                time.sleep(0.5)

    log(f"  {pairs_checked} paires vérifiées, {len(contradictions_found)} contradictions détectées")

    # v2: Auto-fix contradictions — stage resolution proposals for high severity
    if AUTO_FIX and contradictions_found:
        for c in contradictions_found:
            if c["severity"] == "high":
                # Never touch canonical_lock lessons
                if c.get("lesson_a_lock") or c.get("lesson_b_lock"):
                    action_log("skip_contradiction_locked", {
                        "ids": [c["lesson_a_id"], c["lesson_b_id"]],
                        "reason": "canonical_lock=true on one or both"
                    })
                    continue

                push_staging("knowledge_base", {
                    "question": f"Contradiction à résoudre: lessons {c['lesson_a_id']} vs {c['lesson_b_id']}",
                    "answer": f"CONTRADICTION [{c['severity']}] dans domaine {c['lesson_type']}:\n"
                              f"Lesson A ({c['lesson_a_id']}): {c['lesson_a_text']}\n"
                              f"Lesson B ({c['lesson_b_id']}): {c['lesson_b_text']}\n"
                              f"Explication: {c['explanation']}\n"
                              f"ACTION REQUISE: Yann doit arbitrer laquelle garder ou fusionner.",
                    "category": "maintenance-report",
                    "tags": "contradiction,auto-fix,review-needed",
                    "confidence_score": 0.85
                }, author="kb-maintenance-v2-autofix")
                action_log("stage_contradiction_resolution", {
                    "ids": [c["lesson_a_id"], c["lesson_b_id"]],
                    "severity": c["severity"]
                })

    return contradictions_found


# =============================================================================
# ANALYSE 2 : DOUBLONS SÉMANTIQUES — v2 avec auto-suppression
# =============================================================================
def detect_semantic_duplicates():
    log("=== ANALYSE 2: DOUBLONS SÉMANTIQUES (v2 auto-fix) ===")

    # Charger TOUTES les leçons validées (pas seulement critical/high)
    lessons = sb_get("lessons_learned?select=id,lesson_text,lesson_type,importance,confidence_score,canonical_lock,date_learned&validated=eq.true&order=id.desc&limit=500")
    log(f"  {len(lessons)} leçons validées chargées")

    duplicates_found = []
    auto_deleted = 0
    staged_for_review = 0
    checked = set()

    SYSTEM_PROMPT = """Tu es un analyste de base de connaissances. On te donne deux entrées qui semblent similaires.
Réponds UNIQUEMENT en JSON valide:
{"duplicate": true/false, "overlap": 0.0-1.0, "keep": "A" ou "B", "reason": "...en 1-2 phrases"}

Règles:
- duplicate=true si les deux disent essentiellement la même chose
- overlap: estimation 0.0-1.0 du chevauchement sémantique
- keep = celle qui est la plus complète, précise, et à jour
- Si les deux apportent des infos complémentaires, duplicate=false"""

    # Grouper par lesson_type pour comparaison intra-type
    by_type = defaultdict(list)
    for l in lessons:
        by_type[l.get("lesson_type", "unknown")].append(l)

    for ltype, group in by_type.items():
        if len(group) < 2:
            continue

        for i in range(len(group)):
            for j in range(i+1, len(group)):
                a, b = group[i], group[j]
                pair_key = tuple(sorted([a["id"], b["id"]]))
                if pair_key in checked:
                    continue
                checked.add(pair_key)

                # Quick word overlap check
                words_a = set(a.get("lesson_text", "")[:400].lower().split())
                words_b = set(b.get("lesson_text", "")[:400].lower().split())
                if not words_a or not words_b:
                    continue
                word_overlap = len(words_a & words_b) / max(len(words_a | words_b), 1)

                if word_overlap < LOW_OVERLAP_THRESHOLD:
                    continue

                # Ask LLM to confirm
                user_prompt = f"""ENTRÉE A (id={a['id']}, date={a.get('date_learned','?')}):
{a['lesson_text'][:400]}

ENTRÉE B (id={b['id']}, date={b.get('date_learned','?')}):
{b['lesson_text'][:400]}"""

                result = ask_llm(SYSTEM_PROMPT, user_prompt, max_tokens=200)
                if not result:
                    continue

                try:
                    clean = result.strip()
                    if clean.startswith("```"):
                        clean = clean.split("\n", 1)[1].rsplit("```", 1)[0]
                    parsed = json.loads(clean)

                    if not parsed.get("duplicate"):
                        continue

                    llm_overlap = parsed.get("overlap", word_overlap)
                    keep = parsed.get("keep", "A")
                    reason = parsed.get("reason", "")
                    keep_lesson = a if keep == "A" else b
                    remove_lesson = b if keep == "A" else a

                    dup_entry = {
                        "keep_id": keep_lesson["id"],
                        "remove_id": remove_lesson["id"],
                        "word_overlap": round(word_overlap, 3),
                        "llm_overlap": llm_overlap,
                        "reason": reason,
                        "keep_text": keep_lesson["lesson_text"][:200],
                        "remove_text": remove_lesson["lesson_text"][:200]
                    }
                    duplicates_found.append(dup_entry)

                    # v2: AUTO-FIX logic
                    if AUTO_FIX:
                        # NEVER delete canonical_lock lessons
                        if remove_lesson.get("canonical_lock"):
                            action_log("skip_delete_locked", {
                                "id": remove_lesson["id"],
                                "reason": "canonical_lock=true"
                            })
                            continue

                        effective_overlap = max(word_overlap, llm_overlap if isinstance(llm_overlap, (int, float)) else 0)

                        if effective_overlap >= HIGH_OVERLAP_THRESHOLD:
                            # High overlap → auto-delete
                            log(f"  🗑️  AUTO-DELETE lesson {remove_lesson['id']} (overlap={effective_overlap:.2f}, keep={keep_lesson['id']})")
                            if delete_lesson_and_chunks(remove_lesson["id"], f"doublon overlap={effective_overlap:.2f} de lesson {keep_lesson['id']}"):
                                auto_deleted += 1
                        else:
                            # Medium overlap → stage for review
                            log(f"  📋 STAGE FOR REVIEW: {remove_lesson['id']} ≈ {keep_lesson['id']} (overlap={effective_overlap:.2f})")
                            push_staging("knowledge_base", {
                                "question": f"Doublon potentiel à vérifier: lessons {keep_lesson['id']} vs {remove_lesson['id']}",
                                "answer": f"DOUBLON POTENTIEL (overlap={effective_overlap:.2f}):\n"
                                          f"Garder #{keep_lesson['id']}: {keep_lesson['lesson_text'][:150]}\n"
                                          f"Supprimer? #{remove_lesson['id']}: {remove_lesson['lesson_text'][:150]}\n"
                                          f"Raison LLM: {reason}",
                                "category": "maintenance-report",
                                "tags": "doublon,review-needed",
                                "confidence_score": 0.75
                            }, author="kb-maintenance-v2-autofix")
                            staged_for_review += 1

                except (json.JSONDecodeError, KeyError, TypeError) as e:
                    log(f"  Parse error for pair {a['id']}/{b['id']}: {e}")
                    continue

                time.sleep(0.5)

    log(f"  {len(checked)} paires vérifiées, {len(duplicates_found)} doublons détectés")
    log(f"  v2: {auto_deleted} auto-supprimés, {staged_for_review} en attente de review")
    return duplicates_found, auto_deleted, staged_for_review


# =============================================================================
# ANALYSE 3 : COHÉRENCE ROADMAP (inchangé depuis v1)
# =============================================================================
def check_roadmap_coherence():
    log("=== ANALYSE 3: COHÉRENCE ROADMAP ===")

    roadmap = sb_get("roadmap?select=id,step_name,priority,status,description&status=in.(todo,doing)&order=priority.asc")
    roadmap_done = sb_get("roadmap?select=id,step_name,status&status=eq.done&order=id.desc&limit=20")
    recent_lessons = sb_get("lessons_learned?select=id,lesson_text,lesson_type&validated=eq.true&order=id.desc&limit=50")

    log(f"  {len(roadmap)} tâches todo/doing, {len(roadmap_done)} done récentes, {len(recent_lessons)} leçons récentes")

    roadmap_text = "\n".join([
        f"  [{r['id']}] P{r['priority']} ({r['status']}): {r['step_name']}"
        for r in roadmap
    ])
    done_text = "\n".join([
        f"  [{r['id']}] DONE: {r['step_name']}"
        for r in roadmap_done[:10]
    ])

    action_keywords = ["next", "prochain", "à faire", "todo", "should", "devrait", "faut", "step", "étape", "roadmap", "priorit"]
    action_lessons = [
        l for l in recent_lessons
        if any(kw in l.get("lesson_text", "").lower() for kw in action_keywords)
    ]
    log(f"  {len(action_lessons)} leçons avec mots-clés d'action")

    if not action_lessons:
        log("  Aucune leçon avec suggestions d'action trouvée.")
        return []

    SYSTEM_PROMPT = """Tu es un analyste de roadmap projet. On te donne la roadmap actuelle et des leçons récentes qui suggèrent des actions.
Réponds UNIQUEMENT en JSON valide:
{"issues": [{"type": "doublon"|"déjà_fait"|"contradiction_priorité"|"manquant", "lesson_id": N, "roadmap_id": N|null, "description": "..."}]}

Règles:
- doublon: la leçon suggère une tâche qui existe déjà dans la roadmap
- déjà_fait: la leçon suggère quelque chose qui est marqué DONE
- contradiction_priorité: la leçon dit urgente mais roadmap basse priorité
- manquant: besoin réel absent de la roadmap
- Si aucun problème: {"issues": []}"""

    all_issues = []
    for batch_start in range(0, len(action_lessons), 5):
        batch = action_lessons[batch_start:batch_start+5]

        lessons_text = "\n\n".join([
            f"LEÇON id={l['id']} ({l.get('lesson_type','')}):\n{l['lesson_text'][:400]}"
            for l in batch
        ])

        user_prompt = f"""ROADMAP ACTIVE:
{roadmap_text}

ROADMAP RÉCEMMENT TERMINÉE:
{done_text}

LEÇONS À ANALYSER:
{lessons_text}"""

        result = ask_llm(SYSTEM_PROMPT, user_prompt, max_tokens=500)
        if not result:
            continue

        try:
            clean = result.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[1].rsplit("```", 1)[0]
            parsed = json.loads(clean)
            issues = parsed.get("issues", [])
            for issue in issues:
                log(f"  📋 {issue.get('type','?')}: lesson {issue.get('lesson_id','?')} / roadmap {issue.get('roadmap_id','?')}: {issue.get('description','')[:60]}")
            all_issues.extend(issues)
        except (json.JSONDecodeError, KeyError) as e:
            log(f"  Parse error: {e}")
            continue

        time.sleep(1)

    log(f"  {len(all_issues)} problèmes de cohérence détectés")
    return all_issues


# =============================================================================
# MAIN — v2: Orchestration, rapport, et notification
# =============================================================================
def generate_report(contradictions, duplicates, auto_deleted, staged_review, roadmap_issues, normalize_stats=None):
    """v2: Rapport enrichi avec actions correctives."""

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    mode = "DRY-RUN" if DRY_RUN else "AUTO-FIX"

    report_parts = [f"RAPPORT MAINTENANCE KB v2 — {timestamp} [{mode}]"]
    report_parts.append("")
    if normalize_stats:
        ns = normalize_stats
        report_parts.append(f"NORMALIZE [557]: lesson_type={ns.get('lesson_type_fixed',0)}, null_deleted={ns.get('lesson_deleted_null',0)}, kb_cat={ns.get('kb_category_fixed',0)}")
        report_parts.append("")

    report_parts.append(f"CONTRADICTIONS: {len(contradictions)} détectées")
    for c in contradictions:
        report_parts.append(f"  [{c['severity']}] lesson {c['lesson_a_id']} vs {c['lesson_b_id']} ({c['lesson_type']}): {c['explanation'][:100]}")
    if not contradictions:
        report_parts.append("  Aucune contradiction détectée.")

    report_parts.append("")
    report_parts.append(f"DOUBLONS: {len(duplicates)} détectés | {auto_deleted} auto-supprimés | {staged_review} en review")
    for d in duplicates:
        status = "SUPPRIMÉ" if d.get("word_overlap", 0) >= HIGH_OVERLAP_THRESHOLD or d.get("llm_overlap", 0) >= HIGH_OVERLAP_THRESHOLD else "REVIEW"
        report_parts.append(f"  [{status}] #{d['keep_id']} ← #{d['remove_id']} (overlap={d['word_overlap']}): {d['reason'][:80]}")
    if not duplicates:
        report_parts.append("  Aucun doublon détecté.")

    report_parts.append("")
    report_parts.append(f"COHÉRENCE ROADMAP: {len(roadmap_issues)} problèmes")
    for ri in roadmap_issues:
        report_parts.append(f"  [{ri.get('type','')}] lesson {ri.get('lesson_id','')} / roadmap {ri.get('roadmap_id','')}: {ri.get('description','')[:80]}")
    if not roadmap_issues:
        report_parts.append("  Roadmap cohérente.")

    report_parts.append("")
    report_parts.append(f"ACTIONS CORRECTIVES: {len(ACTIONS_LOG)} actions")
    for a in ACTIONS_LOG:
        report_parts.append(f"  [{a['action']}] {json.dumps(a['detail'], ensure_ascii=False)[:100]}")

    report_text = "\n".join(report_parts)
    log(f"\n{'='*60}")
    log(report_text)
    log(f"{'='*60}\n")

    # Push rapport dans KB
    push_staging("knowledge_base", {
        "question": f"Rapport maintenance KB v2 {timestamp}",
        "answer": report_text,
        "category": "maintenance-report",
        "tags": "maintenance,automatique,llm,rapport,v2",
        "confidence_score": 0.9
    })

    # v2: Notification ntfy
    summary = (
        f"KB Maintenance v2 [{mode}]\n"
        f"Contradictions: {len(contradictions)}\n"
        f"Doublons: {len(duplicates)} ({auto_deleted} supprimés, {staged_review} review)\n"
        f"Roadmap: {len(roadmap_issues)} problèmes\n"
        f"Actions: {len(ACTIONS_LOG)}"
    )
    priority = "high" if auto_deleted > 0 or len(contradictions) > 0 else "default"
    notify_ntfy("🔧 KB Maintenance v2", summary, priority=priority)

    # Validate staging entries
    validate()

    return report_text


# =============================================================================
# MODULE NORMALIZE [557] — Nettoyage déterministe, zero LLM requis
# Règles: (1) lesson_type pipes -> premier type (2) KB catégories hors-canon -> remap
#         (3) lesson_text=null -> supprimer avec chunks/embeddings
# =============================================================================

LESSON_TYPES_CANONICAL = {
    "decision", "diagnostic", "architecture", "solution", "discovery",
    "process", "user_wish", "rule_canon", "warning", "problem",
    "best_practice", "infrastructure", "maintenance", "anti-pattern"
}

KB_CATEGORIES_REMAP = {
    "code-pattern": "tools", "test": "governance", "security": "governance",
    "rules": "governance", "validation": "governance", "efficiency": "governance",
    "decisions-bruce": "governance", "solution-validee": "architecture",
    "discoveries": "session-history", "known_not_working": "debugging",
    "observabilité": "monitoring", "observability": "monitoring",
    "sql": "database", "user_preference": "user_profile",
    "diagnosis": "debugging", "diagnostics": "debugging",
    "tooling": "tools", "interface": "tools", "dashboard": "tools",
    "networking": "infrastructure", "powershell": "tools",
    "documentation": "governance", "checklist": "runbook",
    "music": "session-history", "pipes": "tools", "api": "tools",
    "session": "session-history", "solution": "architecture",
}

KB_CATEGORIES_CANONICAL = {
    "docker", "infrastructure", "architecture", "runbook", "workflow",
    "services", "tools", "ssh", "schema", "mcp", "session-history",
    "configuration", "user_profile", "governance", "debugging", "migration",
    "test", "known_not_working", "validation", "security", "backup",
    "efficiency", "database", "pipeline", "monitoring", "api",
    "maintenance-report",
}


def normalize():
    """[557] Normalisation déterministe kb_maintenance — zero LLM."""
    log("=== MODULE NORMALIZE [557] ===")
    stats = {"lesson_type_fixed": 0, "lesson_deleted_null": 0, "kb_category_fixed": 0}

    # 1. lesson_type avec pipes -> premier type
    log("  [1/3] lesson_type avec pipes...")
    lessons_pipe = sb_get(
        "lessons_learned?lesson_type=like.*|*&select=id,lesson_type,canonical_lock&limit=500"
    )
    log(f"    {len(lessons_pipe)} trouvées")
    for lesson in lessons_pipe:
        if lesson.get("canonical_lock"):
            continue
        first_type = lesson["lesson_type"].split("|")[0].strip()
        action_log("normalize_lesson_type", {"id": lesson["id"], "old": lesson["lesson_type"], "new": first_type})
        sb_patch("lessons_learned", f"id=eq.{lesson['id']}", {"lesson_type": first_type})
        stats["lesson_type_fixed"] += 1
    log(f"    ✅ {stats['lesson_type_fixed']} normalisés")

    # 2. lesson_text=null -> supprimer
    log("  [2/3] Leçons lesson_text=null...")
    lessons_null = sb_get(
        "lessons_learned?lesson_text=is.null&select=id,canonical_lock&limit=200"
    )
    log(f"    {len(lessons_null)} trouvées")
    for lesson in lessons_null:
        if lesson.get("canonical_lock"):
            continue
        delete_lesson_and_chunks(lesson["id"], "lesson_text=null")
        stats["lesson_deleted_null"] += 1
    log(f"    ✅ {stats['lesson_deleted_null']} supprimées")

    # 3. Catégories KB hors-canonique -> remap
    log("  [3/3] Catégories KB hors-mapping...")
    kb_all = sb_get("knowledge_base?select=id,category,canonical_lock&limit=1000")
    for kb in kb_all:
        cat = kb.get("category", "")
        if not cat or kb.get("canonical_lock"):
            continue
        new_cat = KB_CATEGORIES_REMAP.get(cat)
        if new_cat:
            action_log("normalize_kb_category", {"id": kb["id"], "old": cat, "new": new_cat})
            sb_patch("knowledge_base", f"id=eq.{kb['id']}", {"category": new_cat})
            stats["kb_category_fixed"] += 1
        elif cat not in KB_CATEGORIES_CANONICAL:
            action_log("normalize_kb_category_unknown", {"id": kb["id"], "old": cat, "new": "governance"})
            sb_patch("knowledge_base", f"id=eq.{kb['id']}", {"category": "governance"})
            stats["kb_category_fixed"] += 1
    log(f"    ✅ {stats['kb_category_fixed']} catégories KB normalisées")

    total = sum(stats.values())
    log(f"  NORMALIZE DONE: {total} corrections — {stats}")
    return stats


def main():
    log("=== KB MAINTENANCE v2 JOB START ===")
    log(f"Config: DRY_RUN={DRY_RUN}, AUTO_FIX={AUTO_FIX}, ONLY={ONLY}")
    log(f"Seuils: HIGH_OVERLAP={HIGH_OVERLAP_THRESHOLD}, LOW_OVERLAP={LOW_OVERLAP_THRESHOLD}")
    log(f"vLLM: {VLLM_MODEL} @ {VLLM_BASE}")

    # Test vLLM connectivity
    try:
        test = ask_llm("Réponds OK.", "Test de connectivité.", max_tokens=10)
        if not test:
            log("ERREUR: vLLM ne répond pas. Abandon.")
            notify_ntfy("❌ KB Maintenance v2", "vLLM ne répond pas — job abandonné", priority="high")
            sys.exit(1)
        log(f"  vLLM OK: '{test[:30]}'")
    except Exception as e:
        log(f"ERREUR vLLM: {e}")
        sys.exit(1)

    contradictions = []
    duplicates = []
    auto_deleted = 0
    staged_review = 0
    roadmap_issues = []
    normalize_stats = {}

    if ONLY is None or ONLY == "normalize":
        normalize_stats = normalize()

    if ONLY is None or ONLY == "contradictions":
        contradictions = detect_contradictions()

    if ONLY is None or ONLY == "doublons":
        duplicates, auto_deleted, staged_review = detect_semantic_duplicates()

    if ONLY is None or ONLY == "roadmap":
        roadmap_issues = check_roadmap_coherence()

    report = generate_report(contradictions, duplicates, auto_deleted, staged_review, roadmap_issues, normalize_stats)

    log("=== KB MAINTENANCE v2 JOB TERMINÉ ===")
    return report


if __name__ == "__main__":
    main()
