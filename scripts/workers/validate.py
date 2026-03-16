#!/usr/bin/env python3
import os
"""
validate.py v3.4 - [843] Gate-2 vLLM disabled, Gate-1c +4 patterns test-data - [792] Gate roadmap born-done - [677] Checkpoint doc
Ajouts par rapport à v2.8:
  - Gate 1b: subcategory obligatoire pour knowledge_base (non-vide)
  - Gate 1c: détection entrées vagues (blacklist phrases génériques)
"""
import requests, json, sys, hashlib, subprocess, os
from datetime import datetime

# Quality gates (vLLM + semantic dedup) [session-114]
try:
    from quality_gates import run_quality_gates
    QUALITY_GATES_AVAILABLE = True
except ImportError:
    QUALITY_GATES_AVAILABLE = False
    print("[WARN] quality_gates.py non trouvé — gates désactivées")

SUPABASE = "http://192.168.2.146:8000/rest/v1"
SK = os.environ.get("SUPABASE_KEY", "")
H = {"apikey": SK, "Authorization": f"Bearer {SK}",
     "Content-Type": "application/json", "Accept": "application/json"}

DRY_RUN = "--dry-run" in sys.argv
AUTO = "--auto" in sys.argv
AUTO_VOLUME = "--auto-volume" in sys.argv  # [504]

# Tables qui n'ont PAS de colonnes meta (validated, author_system, content_hash)
SIMPLE_TABLES = {
    "current_state": "key",
    "bruce_tools": None,
    "knowledge_graph": None,
    "clarifications_pending": None,
    "events_log": None,
    "session_history": None,
}

# [480] FIX: Mapping alias table_cible -> table reelle
TABLE_ALIASES = {
    "bruce_state": "current_state",
}

# [OPUS-104] FIX: colonnes connues par table
KNOWN_COLUMNS = {
    "lessons_learned": {"lesson_type","lesson_text","importance","date_learned",
        "author_system","content_hash","validated","confidence_score",
        "actor","session_id","intent","data_family","canonical_lock","authority_tier","protection_level","project_scope"},
    "knowledge_base": {"question","answer","category","subcategory","tags","author_system",
        "content_hash","validated","confidence_score","actor","session_id",
        "intent","data_family","canonical_lock","authority_tier","protection_level"},
    "current_state": {"key","value","updated_at","data_family","canonical_lock","authority_tier","protection_level"},
    "session_history": {"session_start","session_end","tasks_completed","notes",
        "author_system","content_hash","validated","data_family"},
    "events_log": {"event_type","source","payload","created_at","project_scope"},
    "roadmap": {"step_name","status","priority","description","model_hint","category",
        "data_family","canonical_lock","actor","author_system","authority_tier","protection_level",
        "verified_at","evidence","acceptance_criteria","project_scope"},
    "bruce_tools": {"name","description","category","status","tool_type","subcategory",
        "when_to_use","when_not_to_use","location","how_to_run","host","ip","port",
        "url","role","notes","trigger_texts","dependencies","inputs","outputs",
        "risks_rollback","vm_parent","data_family","project_scope",
        "author_system","created_at","updated_at"},
}

# ==================== [580] GATE 1: VALIDATION STRUCTURELLE ====================

# Types canoniques valides pour lessons_learned
LESSON_TYPES_CANON = {
    "decision", "diagnostic", "architecture", "solution", "discovery",
    "process", "user_wish", "rule_canon", "warning", "problem",
    "best_practice", "infrastructure", "maintenance"
}

# Types INTERDITS — rapports de tâches/sessions qui ne sont PAS des leçons
LESSON_TYPES_FORBIDDEN = {
    "task_report", "session_report", "rapport", "report",
    "task-report", "session-report", "task_summary", "session_summary"
}

# [602] Scopes de projet valides (registre project_keywords_registry)
VALID_PROJECT_SCOPES = {"homelab", "musique", "domotique", "general"}

# Longueurs minimales par table (sans dépendance à quality_gates.py)
MIN_LENGTHS = {
    "lessons_learned": 80,
    "knowledge_base": 100,
}

# [595] S8 - Gate 1c: Phrases vagues/génériques blacklistées
# Appliquées sur les 120 premiers caractères du texte principal (lowercase)
VAGUE_PATTERNS = [
    "il faudrait",
    "on pourrait",
    "à améliorer",
    "à définir",
    "à implémenter",
    "à faire",
    "tbd",
    "todo",
    "à préciser",
    "en cours",
    "voir plus tard",
    "à compléter",
    "à documenter",
    "à vérifier",
    "placeholder",
    "notes à",
    "idée générale",
    "améliorer la fiabilité",
    "centraliser les données",
    "optimiser le système",
    "tester c'est important",
    "il est important de",
    "il convient de",
    "best practice générale",
    "test checkpoint",
    "audit-test",
    "a supprimer",
    "delete after",
]

def gate1_structural_check(table: str, contenu: dict, item_id: int) -> tuple[bool, str]:
    """
    [580]+[595] Gate 1: validation structurelle AVANT quality_gates.
    v2.9: Ajout Gate 1b (subcategory KB) + Gate 1c (vague detection)
    v3.0: [602] Ajout Gate 1f (project_scope validation) + KNOWN_COLUMNS project_scope
    
    Vérifie:
      1a. lesson_type valide (lessons_learned)
      1b. subcategory non-vide (knowledge_base) [S8]
      1c. Texte non-vague (lessons_learned + knowledge_base) [S8]
      1d. Longueur minimale
      1e. Champs obligatoires KB
      1g. [792] roadmap status=done interdit via staging
    Returns: (pass: bool, reason: str)
    """
    # [792] Gate 1g: roadmap status=done via staging interdit
    if table == "roadmap":
        status = str(contenu.get("status", "")).strip().lower()
        if status == "done":
            return False, "[792] roadmap status=done interdit via staging. Utiliser PATCH sur tache existante."
        return True, "OK"

    # Uniquement pour les tables de connaissance
    if table not in ("lessons_learned", "knowledge_base"):
        return True, "OK"

    # --- 1a. Vérification lesson_type (lessons_learned uniquement) ---
    if table == "lessons_learned":
        lesson_type = str(contenu.get("lesson_type", "")).strip().lower()
        
        if not lesson_type:
            return False, "lesson_type manquant (champ obligatoire)"
        
        if lesson_type in LESSON_TYPES_FORBIDDEN:
            return False, f"lesson_type='{lesson_type}' interdit (rapport de tâche/session, pas une leçon)"
        
        if lesson_type not in LESSON_TYPES_CANON:
            return False, f"lesson_type='{lesson_type}' non-canonique. Types valides: {', '.join(sorted(LESSON_TYPES_CANON))}"

    # --- 1b. [S8] Subcategory obligatoire pour knowledge_base ---
    if table == "knowledge_base":
        subcategory = str(contenu.get("subcategory", "")).strip()
        if not subcategory or len(subcategory) < 2:
            return False, "knowledge_base: champ 'subcategory' manquant ou invalide (obligatoire depuis S8)"

    # --- 1c. [S8] Détection entrées vagues ---
    text_to_check = ""
    for field in ["lesson_text", "answer", "observation", "description", "value"]:
        if field in contenu and contenu[field]:
            text_to_check = str(contenu[field])
            break
    
    if text_to_check:
        text_lower = text_to_check.strip().lower()[:120]
        for pattern in VAGUE_PATTERNS:
            if pattern in text_lower:
                return False, f"Entrée vague détectée: contient '{pattern}' (gate 1c S8)"

    # --- 1d. Vérification longueur minimale ---
    min_len = MIN_LENGTHS.get(table, 0)
    if min_len > 0:
        text = ""
        for field in ["lesson_text", "answer", "observation", "description", "value"]:
            if field in contenu:
                text = str(contenu[field])
                break
        if len(text.strip()) < min_len:
            return False, f"Texte trop court ({len(text.strip())} chars < {min_len} minimum)"

    # --- 1e. Vérification champs obligatoires knowledge_base ---
    if table == "knowledge_base":
        if not contenu.get("question") or len(str(contenu.get("question", "")).strip()) < 10:
            return False, "knowledge_base: champ 'question' manquant ou trop court"
        if not contenu.get("answer") or len(str(contenu.get("answer", "")).strip()) < min_len:
            return False, "knowledge_base: champ 'answer' manquant ou trop court"
        if not contenu.get("category"):
            return False, "knowledge_base: champ 'category' manquant"

    # --- 1f. [602] Validation project_scope ---
    project_scope = str(contenu.get("project_scope", "homelab")).strip().lower()
    if project_scope and project_scope not in VALID_PROJECT_SCOPES:
        return False, f"project_scope='{project_scope}' invalide. Valeurs: {', '.join(sorted(VALID_PROJECT_SCOPES))}"
    # Si absent, on laisse passer (DEFAULT homelab dans la DB)

    return True, "OK"

# ==================== FIN GATE 1 ====================

def filter_columns(table, obj):
    """Filtre un dict pour ne garder que les colonnes connues de la table."""
    cols = KNOWN_COLUMNS.get(table)
    if not cols:
        return obj
    filtered = {k: v for k, v in obj.items() if k in cols}
    dropped = set(obj.keys()) - cols
    if dropped:
        print(f"    [FILTER] Champs ignorés pour {table}: {dropped}")
    return filtered

def get(path, limit=500):
    r = requests.get(f"{SUPABASE}/{path}&limit={limit}", headers=H, timeout=15)
    return r.json() if r.status_code == 200 and r.text.strip() else []

def post(table, obj, upsert_on=None):
    if DRY_RUN:
        print(f"    [DRY] POST {table}: {str(obj)[:80]}")
        return True
    headers = dict(H)
    if upsert_on:
        headers["Prefer"] = f"resolution=merge-duplicates,return=representation"
    r = requests.post(f"{SUPABASE}/{table}", headers=headers, json=obj, timeout=10)
    if r.status_code not in (200, 201):
        print(f"    [HTTP {r.status_code}] {r.text[:200]}")
    return r.status_code in (200, 201)

def patch(table, filter_, obj):
    if DRY_RUN:
        print(f"    [DRY] PATCH {table}?{filter_}: {obj}")
        return True
    r = requests.patch(f"{SUPABASE}/{table}?{filter_}", headers=H, json=obj, timeout=10)
    return r.status_code in (200, 204)

def mk_hash(text):
    return hashlib.sha256(str(text).encode()).hexdigest()[:16]

def check_contradiction(table, new_text, new_hash):
    if table in SIMPLE_TABLES:
        return "OK", None
    existing = get(f"{table}?content_hash=eq.{new_hash}&select=id,content_hash")
    if existing:
        return "DUPLICATE", existing[0]["id"]
    field_map = {
        "lessons_learned": "lesson_text",
        "knowledge_base": "answer",
        "user_profile": "observation",
        "next_steps": "description",
        "system_rules": "rule_text",
        "discoveries": "discovery",
    }
    field = field_map.get(table, "id")
    if field == "id":
        return "OK", None
    prefix = new_text[:30].replace("'", "''")
    similar = get(f"{table}?{field}=ilike.*{requests.utils.quote(prefix)}*&select=id,{field}&limit=3")
    if similar:
        return "SIMILAR", similar[0]["id"]
    return "OK", None

def auto_decide(new_text, existing_id, table):
    field_map = {
        "lessons_learned": "lesson_text",
        "knowledge_base": "answer",
        "user_profile": "observation",
        "next_steps": "description",
        "discoveries": "discovery",
    }
    field = field_map.get(table, "answer")
    try:
        existing = get(f"{table}?id=eq.{existing_id}&select=id,{field}&limit=1")
        if not existing:
            return "A"
        existing_text = str(existing[0].get(field, ""))
    except Exception:
        return "BOTH"
    new_len = len(new_text.strip())
    exist_len = len(existing_text.strip())
    if new_text.strip()[:50] == existing_text.strip()[:50] and abs(new_len - exist_len) < 30:
        return "B"
    if new_len > exist_len * 1.3:
        return "A"
    if exist_len > new_len * 1.3:
        return "B"
    return "BOTH"

def promote_to_canonical(staging_item):
    raw_table = staging_item["table_cible"]
    table = TABLE_ALIASES.get(raw_table, raw_table)
    if table != raw_table:
        print(f"    [ALIAS] {raw_table} -> {table}")
    contenu = staging_item["contenu_json"]
    if isinstance(contenu, str):
        import json as _j
        contenu = _j.loads(contenu)
    contenu = dict(contenu)
    item_id = staging_item["id"]
    
    if table in SIMPLE_TABLES:
        upsert_key = SIMPLE_TABLES[table]
        contenu = filter_columns(table, contenu)
        ok = post(table, contenu, upsert_on=upsert_key)
    else:
        if "author_system" not in contenu:
            contenu["author_system"] = staging_item.get("author_system", "staged")
        if "content_hash" not in contenu:
            _hash_text = ""
            for _f in ["lesson_text", "answer", "observation", "description", "rule_text", "discovery", "value"]:
                if _f in contenu:
                    _hash_text = str(contenu[_f])
                    break
            if not _hash_text:
                _hash_text = str(contenu)
            contenu["content_hash"] = mk_hash(_hash_text)
        contenu["validated"] = True
        if "authority_tier" not in contenu:
            author = contenu.get("author_system", staging_item.get("author_system", ""))
            if any(x in str(author).lower() for x in ["opus", "yann"]):
                contenu["authority_tier"] = "session"
            elif any(x in str(author).lower() for x in ["sonnet", "claude", "session"]):
                contenu["authority_tier"] = "session"
            else:
                contenu["authority_tier"] = "auto"
        if contenu.get("authority_tier") == "authoritative":
            author = contenu.get("author_system", staging_item.get("author_system", ""))
            if not any(x in str(author).lower() for x in ["opus", "yann"]):
                print(f"    [GUARD] authority_tier=authoritative refusé pour author={author} -> session")
                contenu["authority_tier"] = "session"
        TABLES_WITH_SESSION_ID = {"lessons_learned", "knowledge_base"}
        if table in TABLES_WITH_SESSION_ID and "session_id" not in contenu:
            try:
                r = requests.get(f"{SUPABASE}/session_history?order=id.desc&limit=1&select=id",
                                 headers=H, timeout=5)
                if r.status_code == 200 and r.json():
                    contenu["session_id"] = r.json()[0]["id"]
            except Exception:
                pass
        if table == "lessons_learned" and "date_learned" not in contenu:
            from datetime import timezone
            contenu["date_learned"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        contenu = filter_columns(table, contenu)
        ok = post(table, contenu)

    if ok:
        patch("staging_queue", f"id=eq.{item_id}", {
            "status": "validated",
            "validated_by": "validate.py",
            "validated_at": datetime.now().isoformat()
        })
        try:
            post("events_log", {
                "event_type": "staging_promoted",
                "source": table,
                "payload": {"staging_id": item_id, "table": table, "alias_from": raw_table if raw_table != table else None}
            })
        except Exception:
            pass
        return True

    patch("staging_queue", f"id=eq.{item_id}", {
        "status": "rejected",
        "rejection_reason": "POST canonical failed (HTTP error)"
    })
    try:
        post("events_log", {
            "event_type": "staging_failed",
            "source": table,
            "payload": {"staging_id": item_id}
        })
    except Exception:
        pass
    return False

print(f"=== VALIDATE.PY v3.0 - {'DRY RUN' if DRY_RUN else 'EXECUTION'} ===")
print(f"[580] Gate 1a ACTIVE: lesson_type strict ({len(LESSON_TYPES_CANON)} types valides, {len(LESSON_TYPES_FORBIDDEN)} interdits)")
print(f"[S8]  Gate 1b ACTIVE: subcategory obligatoire pour knowledge_base")
print(f"[S8]  Gate 1c ACTIVE: détection entrées vagues ({len(VAGUE_PATTERNS)} patterns)")
print(f"[602] Gate 1f ACTIVE: project_scope validation ({len(VALID_PROJECT_SCOPES)} scopes)\n")

pending = get("staging_queue?status=eq.pending&order=id.asc")
print(f"Items en attente: {len(pending)}")

stats = {"validated": 0, "duplicate": 0, "similar": 0, "error": 0, "auto_volume": 0,
         "gate1_rejected": 0}

# [677] Checkpoint documentaire: tracker les bruce_tools validés et les lessons/KB du batch
_batch_bruce_tools_validated = []
_batch_doc_tables = set()  # tables de documentation vues dans ce batch

if not pending:
    print("Rien à traiter.")
else:
    for item in pending:
        raw_table = item["table_cible"]
        table = TABLE_ALIASES.get(raw_table, raw_table)
        contenu = item.get("contenu_json", {})
        if isinstance(contenu, str):
            import json as _j
            contenu = _j.loads(contenu)
        item_id = item["id"]
        
        main_text = ""
        for field in ["lesson_text", "answer", "observation", "description", "rule_text", "discovery", "value"]:
            if field in contenu:
                main_text = str(contenu[field])
                break
        if not main_text:
            main_text = str(contenu)
        
        item_hash = item.get("content_hash") or mk_hash(main_text)

        # ========== [580] GATE 1: STRUCTURAL CHECK (AVANT TOUT) ==========
        # Bypass Gate 1 pour les décisions explicites de Yann
        _actor = str(contenu.get("actor", item.get("author_system", ""))).lower()
        _is_yann = "yann" in _actor
        
        if not _is_yann:
            g1_pass, g1_reason = gate1_structural_check(table, contenu, item_id)
            if not g1_pass:
                print(f"  [GATE-1 REJECT] id={item_id} -> {table}: {g1_reason}")
                patch("staging_queue", f"id=eq.{item_id}", {
                    "status": "rejected",
                    "rejection_reason": f"[GATE-1] {g1_reason}"
                })
                stats["gate1_rejected"] += 1
                continue
        # =================================================================

        status, conflict_id = check_contradiction(table, main_text, item_hash)
        
        if status == "DUPLICATE":
            print(f"  [DUPLICATE] id={item_id} -> {table} (conflit avec id={conflict_id})")
            patch("staging_queue", f"id=eq.{item_id}", {
                "status": "rejected",
                "rejection_reason": f"Doublon exact de {table}#{conflict_id}",
                "contradiction_with": conflict_id
            })
            stats["duplicate"] += 1
            
        elif status == "SIMILAR":
            print(f"  [SIMILAR] id={item_id} -> {table} (similaire à id={conflict_id})")
            if AUTO_VOLUME:
                ok = promote_to_canonical(item)
                if ok:
                    stats["auto_volume"] += 1
                    print(f"    -> [AUTO-VOLUME] Promu direct")
                else:
                    stats["error"] += 1
            elif AUTO:
                decision = auto_decide(main_text, conflict_id, table)
                if decision == "A":
                    ok = promote_to_canonical(item)
                    if ok:
                        stats["similar"] += 1
                        print(f"    -> [AUTO-DECIDE A] Nouvelle promue")
                    else:
                        stats["error"] += 1
                elif decision == "B":
                    patch("staging_queue", f"id=eq.{item_id}", {
                        "status": "rejected",
                        "rejection_reason": f"[AUTO-DECIDE B] Existante #{conflict_id} plus complète"
                    })
                    stats["duplicate"] += 1
                    print(f"    -> [AUTO-DECIDE B] Rejeté")
                else:
                    ok = promote_to_canonical(item)
                    if ok:
                        stats["similar"] += 1
                        print(f"    -> [AUTO-DECIDE BOTH] Deux entrées conservées")
                    else:
                        stats["error"] += 1
            else:
                print(f"    -> En attente (utiliser --auto ou --auto-volume)")
                stats["similar"] += 1
                
        else:  # OK
            if QUALITY_GATES_AVAILABLE and table in ("lessons_learned", "knowledge_base") and not _is_yann:
                passed, gate_reason = run_quality_gates(main_text, contenu.get("lesson_type", "unknown"), table)
                if not passed:
                    print(f"  [QUALITY-GATE] id={item_id} -> {table}: {gate_reason}")
                    patch("staging_queue", f"id=eq.{item_id}", {
                        "status": "rejected",
                        "rejection_reason": f"[QUALITY-GATE] {gate_reason}"
                    })
                    stats["quality_rejected"] = stats.get("quality_rejected", 0) + 1
                    continue
            
            # [566] Guard protection_level
            if "id" in contenu and table in ("lessons_learned", "knowledge_base", "current_state"):
                try:
                    _rc = requests.get(f"{SUPABASE}/{table}?id=eq.{contenu['id']}&select=protection_level", headers=H, timeout=5)
                    if _rc.status_code == 200 and _rc.json():
                        _pl = _rc.json()[0].get("protection_level") or "none"
                        _auth = str(contenu.get("author_system", item.get("author_system", "")))
                        if _pl == "yann_only" and "yann" not in _auth.lower():
                            print(f"    [GUARD-PL] yann_only bloqué pour author={_auth}")
                            patch("staging_queue", f"id=eq.{item_id}", {"status": "rejected", "rejection_reason": "[GUARD-PL] yann_only protection"})
                            stats["error"] += 1
                            continue
                        elif _pl == "session_only" and _auth.lower() in ("auto", "system", ""):
                            print(f"    [GUARD-PL] session_only bloqué pour author={_auth}")
                            patch("staging_queue", f"id=eq.{item_id}", {"status": "rejected", "rejection_reason": "[GUARD-PL] session_only protection"})
                            stats["error"] += 1
                            continue
                except Exception as _e:
                    print(f"    [WARN] Check protection_level: {_e}")

            ok = promote_to_canonical(item)
            if ok:
                print(f"  [OK] id={item_id} -> {table}: {main_text[:70]}")
                stats["validated"] += 1
                # [677] Track pour checkpoint documentaire
                if table == "bruce_tools":
                    _batch_bruce_tools_validated.append({"id": item_id, "name": contenu.get("name", "?")})
                elif table in ("lessons_learned", "knowledge_base"):
                    _batch_doc_tables.add(table)
            else:
                print(f"  [ERREUR] id={item_id} -> {table}")
                stats["error"] += 1
    
    print(f"\n=== RESULTAT ===")
    print(f"  Valides:          {stats['validated']}")
    print(f"  Doublons:         {stats['duplicate']}")
    print(f"  Similaires:       {stats['similar']}")
    print(f"  Erreurs:          {stats['error']}")
    print(f"  Gate-1 rejetés:   {stats['gate1_rejected']}")
    if stats.get("quality_rejected", 0) > 0:
        print(f"  Quality rejetés:  {stats['quality_rejected']}")
    if stats.get("auto_volume", 0) > 0:
        print(f"  Auto-volume:      {stats['auto_volume']}")

    # ==================== [677] CHECKPOINT DOCUMENTAIRE ====================
    if _batch_bruce_tools_validated and not _batch_doc_tables:
        tools_names = ", ".join(t["name"] for t in _batch_bruce_tools_validated)
        print(f"\n⚠️  [CHECKPOINT-677] {len(_batch_bruce_tools_validated)} bruce_tools validé(s) SANS lesson/KB dans ce batch!")
        print(f"    Outils: {tools_names}")
        print(f"    RAPPEL: Documenter chaque action avec une lesson (staging_queue table_cible=lessons_learned).")
        print(f"    La prochaine session risque de manquer de contexte sans documentation.")
        stats["checkpoint_warning"] = len(_batch_bruce_tools_validated)
    elif _batch_bruce_tools_validated and _batch_doc_tables:
        print(f"\n✅  [CHECKPOINT-677] Documentation OK: {len(_batch_bruce_tools_validated)} bruce_tools + {', '.join(_batch_doc_tables)} dans le batch.")
    # ==================== FIN CHECKPOINT 677 ====================

pending_clarif = get("clarifications_pending?status=eq.pending&select=id,question_text,option_a,option_b")
if pending_clarif:
    print(f"\n=== {len(pending_clarif)} CLARIFICATIONS EN ATTENTE POUR YANN ===")
    for i, c in enumerate(pending_clarif, 1):
        print(f"\n  Q{i} (id={c['id']}): {c.get('question_text','')}")
        print(f"    A) {c.get('option_a','')[:80]}")
        print(f"    B) {c.get('option_b','')[:80]}")
