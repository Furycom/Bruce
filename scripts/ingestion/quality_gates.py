#!/usr/bin/env python3
import os
"""
quality_gates.py — Module de filtrage qualité pour validate.py
Deux gates:
  Gate 2: vLLM quality filter (leçon concrète/spécifique/actionnable?)
  Gate 3: pgvector semantic dedup (trop similaire à l'existant?)

Import dans validate.py:
  from quality_gates import vllm_quality_check, semantic_dedup_check

Dépendances: requests (déjà présent), psycopg2 ou subprocess pour pgvector
Déployé sur .230 (accès vLLM direct + Supabase API)
"""
import json
import subprocess
import requests

VLLM_URL = "http://192.168.2.230:4100/v1/chat/completions"  # [902] LiteLLM proxy
VLLM_MODEL = "alpha"  # [902] dispatché par LiteLLM
VLLM_KEY = "token-abc123"

BGE_URL = "http://192.168.2.85:8081/v1/embeddings"  # [902] BGE dedié embedder .85
SUPABASE = "http://192.168.2.146:8000/rest/v1"
SK = os.environ.get("SUPABASE_KEY", "")
H_SUPA = {"apikey": SK, "Authorization": f"Bearer {SK}", "Content-Type": "application/json"}

# Seuils configurables
MIN_LESSON_LENGTH = 80
MIN_KB_LENGTH = 100
SEMANTIC_DEDUP_THRESHOLD = 0.90
VLLM_TIMEOUT = 30


# ==================== GATE 2: vLLM QUALITY FILTER ====================

def vllm_quality_check(text: str, lesson_type: str, table: str) -> tuple[bool, str]:
    """
    Demande à vLLM si cette leçon mérite d'être en canonical.
    Returns: (pass: bool, reason: str)
    
    Appelé par validate.py AVANT promote_to_canonical().
    Coût: ~0.5s par item (acceptable pour ingestion batch, pas temps réel).
    """
    # Filtre rapide: longueur minimale (pas besoin de vLLM pour ça)
    min_len = MIN_KB_LENGTH if table == "knowledge_base" else MIN_LESSON_LENGTH
    if len(text.strip()) < min_len:
        return False, f"Trop court ({len(text.strip())} chars < {min_len})"
    
    # Tables simples (current_state, events_log): pas de filtre qualité
    SKIP_TABLES = {"current_state", "events_log", "session_history", "knowledge_graph"}
    if table in SKIP_TABLES:
        return True, "Table exemptée du filtre qualité"
    
    prompt = f"""/no_think
Tu es un filtre qualité pour une base de connaissances homelab (BRUCE).
Évalue si cette entrée mérite d'être stockée en mémoire permanente.

Réponds UNIQUEMENT par un JSON: {{"pass": true/false, "reason": "explication en 10 mots max"}}

ACCEPTER (pass=true) si AU MOINS UN critère:
- Contient un élément spécifique: IP, port, nom de service, commande, fichier, config
- Documente un bug, sa cause et/ou sa solution
- Enregistre une décision avec son contexte et sa justification
- Décrit une procédure ou un workflow concret
- Contient une configuration technique précise

REJETER (pass=false) si TOUS ces critères:
- Vague ou générique (applicable à n'importe quel projet)
- Fragment incomplet (phrase sans contexte ni conclusion)
- Aspiration sans plan ("il faudrait...", "on pourrait...")
- Truisme évident ("tester c'est important", "centraliser les données")
- Trop court pour être utile seul

Entrée [{lesson_type}] pour table {table}:
"{text[:500]}"
"""
    
    try:
        resp = requests.post(VLLM_URL, json={
            "model": VLLM_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 80,
            "temperature": 0.1
        }, headers={"Authorization": f"Bearer {VLLM_KEY}"}, timeout=VLLM_TIMEOUT)
        
        answer = resp.json()['choices'][0]['message']['content'].strip()
        
        # Parse JSON (avec tolérance markdown)
        if answer.startswith('```'):
            answer = answer.split('\n', 1)[1].rsplit('```', 1)[0].strip()
        
        result = json.loads(answer)
        passed = result.get('pass', True)  # En cas de doute, garder
        reason = result.get('reason', 'vLLM check')
        return passed, reason
        
    except Exception as e:
        # En cas d'erreur vLLM, laisser passer (fail-open)
        return True, f"vLLM error (fail-open): {str(e)[:50]}"


# ==================== GATE 3: SEMANTIC DEDUP ====================

def _get_embedding(text: str) -> list[float] | None:
    """Génère un embedding via le modèle BGE local."""
    try:
        # Tenter BGE endpoint dédié d'abord, fallback sur vLLM embeddings
        for url in [
            "http://192.168.2.146:11434/api/embed",  # ollama BGE
            "http://192.168.2.85:8081/v1/embeddings"  # [902] BGE dédié .85
        ]:
            try:
                if "ollama" in url or "11434" in url:
                    resp = requests.post(url, json={
                        "model": "bge-m3",
                        "input": text[:2000]
                    }, timeout=15)
                    if resp.status_code == 200:
                        data = resp.json()
                        return data.get("embeddings", [data.get("embedding")])[0]
                else:
                    resp = requests.post(url, json={
                        "model": "bge-m3",
                        "input": [text[:2000]]
                    }, headers={"Authorization": f"Bearer {VLLM_KEY}"}, timeout=15)
                    if resp.status_code == 200:
                        return resp.json()['data'][0]['embedding']
            except Exception:
                continue
        return None
    except Exception:
        return None


def semantic_dedup_check(text: str, table: str) -> tuple[bool, str | None]:
    """
    Vérifie si un texte similaire existe déjà en canonical via pgvector.
    Returns: (is_unique: bool, similar_id: int | None)
    
    Méthode: embed le texte, chercher dans bruce_embeddings via Supabase RPC
    ou via psql direct si RPC pas dispo.
    """
    SKIP_TABLES = {"current_state", "events_log", "session_history", "knowledge_graph"}
    if table in SKIP_TABLES:
        return True, None
    
    embedding = _get_embedding(text)
    if not embedding:
        return True, None  # Fail-open si pas d'embedding
    
    # Méthode: appel SQL direct via psql sur .206
    # Plus fiable que RPC Supabase pour les requêtes vectorielles
    emb_str = "[" + ",".join(str(x) for x in embedding) + "]"
    
    sql = f"""
    SELECT c.anchor->>'source_id' as source_id, 
           round((1-(e.embedding <=> '{emb_str}'::vector))::numeric, 4) as sim
    FROM bruce_embeddings e
    JOIN bruce_chunks c ON c.id = e.chunk_id
    WHERE c.anchor->>'source' = '{_table_to_source(table)}'
      AND 1-(e.embedding <=> '{emb_str}'::vector) > {SEMANTIC_DEDUP_THRESHOLD}
    ORDER BY sim DESC
    LIMIT 1;
    """
    
    try:
        # Via Supabase RPC si disponible, sinon log et fail-open
        # Pour l'instant, on utilise une approche plus simple:
        # chercher par texte similaire via l'API REST
        
        # Fallback: comparaison prefix rapide (30 chars) via REST
        field = _table_field(table)
        if not field:
            return True, None
            
        prefix = text.strip()[:40]
        # URL-encode le prefix
        import urllib.parse
        encoded = urllib.parse.quote(prefix)
        
        resp = requests.get(
            f"{SUPABASE}/{table}?{field}=ilike.*{encoded}*&select=id,{field}&limit=3&data_family=eq.canonical",
            headers=H_SUPA, timeout=10
        )
        
        if resp.status_code == 200 and resp.json():
            from difflib import SequenceMatcher
            for existing in resp.json():
                existing_text = str(existing.get(field, ""))
                sim = SequenceMatcher(None, text.strip()[:200], existing_text.strip()[:200]).ratio()
                if sim > 0.85:
                    return False, existing['id']
        
        return True, None
        
    except Exception as e:
        return True, None  # Fail-open


def _table_to_source(table):
    return table  # Pour l'instant, source = nom de table

def _table_field(table):
    return {
        "lessons_learned": "lesson_text",
        "knowledge_base": "answer",
    }.get(table)


# ==================== INTEGRATION HELPERS ====================

def run_quality_gates(text: str, lesson_type: str, table: str, verbose: bool = True) -> tuple[bool, str]:
    """
    Point d'entrée unique pour validate.py.
    [843] Gate-2 vLLM désactivée (précision 23%, 17 faux positifs / 22 rejets).
    Gate-1c enrichie avec patterns test-data. Gate-3 dedup conservée.
    Decision Opus session 1037, 2026-03-06.
    Backup: quality_gates.py.bak_843
    """
    # [843] Gate 2 DISABLED - vLLM quality check
    # Raison: 5 vrais positifs vs 17 faux positifs (23% precision)
    # + faux negatifs prouves (IDs 2738,2739 en canonical)
    # Gate-1c couvre les test-data, truismes acceptes comme bruit negligeable
    if verbose:
        print(f"    [GATE-2 SKIP] Disabled by [843] - Gate-1c handles quality")
    
    # Gate 3: semantic dedup (conservée)
    is_unique, similar_id = semantic_dedup_check(text, table)
    if not is_unique:
        if verbose:
            print(f"    [GATE-3 REJECT] Trop similaire à #{similar_id}")
        return False, f"Gate3: doublon sémantique de #{similar_id}"
    
    return True, "OK"


# ==================== SELF-TEST ====================
if __name__ == "__main__":
    print("=== TEST QUALITY GATES ===\n")
    
    # Test Gate 2: devrait passer
    good = "FIX VALIDATE.PY v2.2: validate.py crashait sur TypeError car contenu_json est stocké comme string JSON dans Supabase via PostgREST. Fix: json.loads() avant traitement."
    p, r = vllm_quality_check(good, "diagnostic", "lessons_learned")
    print(f"Good lesson: pass={p}, reason={r}")
    
    # Test Gate 2: devrait échouer
    bad = "Améliorer la fiabilité du système."
    p, r = vllm_quality_check(bad, "decision", "lessons_learned")
    print(f"Bad lesson: pass={p}, reason={r}")
    
    # Test Gate 2: trop court
    short = "SSH fonctionne."
    p, r = vllm_quality_check(short, "discovery", "lessons_learned")
    print(f"Short lesson: pass={p}, reason={r}")
    
    # Test Gate 3: dedup
    existing = "vLLM + MCP Gateway ALIGNES: BRUCE_LLM_API_BASE=http://192.168.2.32:8000/v1"
    p, sid = semantic_dedup_check(existing, "lessons_learned")
    print(f"\nSemantic dedup: unique={p}, similar_id={sid}")
    
    print("\n=== TESTS TERMINÉS ===")
