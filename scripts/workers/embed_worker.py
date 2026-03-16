import os
import json, time, hashlib, uuid, requests, sys, traceback
from datetime import datetime, timezone

SUPABASE  = "http://192.168.2.146:8000/rest/v1"
SK        = os.environ.get("SUPABASE_KEY", "")
EMBEDDER  = "http://192.168.2.85:8081/embed"
MODEL     = "BAAI/bge-m3"
DIMS      = 1024
CHUNK_MAX = 400
POLL_SEC  = 20

HEADERS = {
    "apikey": SK,
    "Authorization": f"Bearer {SK}",
    "Content-Type": "application/json",
    "Accept": "application/json"
}

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def sb_get(path):
    r = requests.get(f"{SUPABASE}/{path}", headers=HEADERS, timeout=10)
    r.raise_for_status()
    text = r.text.strip()
    if not text:
        return []
    return json.loads(text)

def sb_post(table, body):
    r = requests.post(f"{SUPABASE}/{table}", headers=HEADERS,
                      json=body, timeout=10)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"{table} POST {r.status_code}: {r.text[:200]}")
    text = r.text.strip()
    if not text:
        return {}
    return json.loads(text)

def get_embedding(text):
    text = text[:512]
    r = requests.post(EMBEDDER,
                      json={"inputs": text, "max_length": 512},
                      timeout=15)
    r.raise_for_status()
    vec = r.json()
    return vec[0] if isinstance(vec, list) and isinstance(vec[0], list) else vec

def text_sha(text):
    return hashlib.sha256(text.encode()).hexdigest()

def chunk_text(text, max_chars=CHUNK_MAX):
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]
    chunks = []
    while len(text) > max_chars:
        cut = text.rfind('. ', 0, max_chars)
        if cut < 50:
            cut = text.rfind('\n', 0, max_chars)
        if cut < 50:
            cut = max_chars
        else:
            cut += 1
        chunks.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        chunks.append(text)
    return chunks

def already_indexed(sha256):
    try:
        r = sb_get(f"bruce_chunks?text_sha256=eq.{sha256}&select=chunk_id&limit=1")
        return len(r) > 0
    except:
        return False

def index_text(text, doc_id, source_table, source_id, anchor_extra=None):
    chunks = chunk_text(text)
    indexed = 0
    for i, chunk in enumerate(chunks):
        sha = text_sha(chunk)
        if already_indexed(sha):
            continue
        chunk_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{doc_id}:{i}:{sha}"))
        anchor = {"source": source_table, "source_id": str(source_id), "chunk_index": i}
        if anchor_extra:
            anchor.update(anchor_extra)
        try:
            sb_post("bruce_chunks", {
                "chunk_id":    chunk_id,
                "doc_id":      doc_id,
                "chunk_index": i,
                "text":        chunk,
                "start_char":  0,
                "end_char":    len(chunk),
                "anchor":      anchor,
                "text_sha256": sha
            })
        except RuntimeError as e:
            if "duplicate" in str(e).lower() or "23505" in str(e):
                # [796] Chunk exists - check if embedding also exists
                try:
                    e_check = sb_get(f"bruce_embeddings?chunk_id=eq.{chunk_id}&select=chunk_id&limit=1")
                    if e_check:
                        continue  # Both exist, skip entirely
                    # Embedding missing - fall through to create it
                except:
                    continue
            else:
                raise
        vec = get_embedding(chunk)
        if not vec:
            continue
        vec_str = "[" + ",".join(str(float(x)) for x in vec) + "]"
        sb_post("bruce_embeddings", {
            "chunk_id":  chunk_id,
            "model":     MODEL,
            "dims":      DIMS,
            "embedding": vec_str
        })
        indexed += 1
    return indexed

def process_knowledge_base():
    # [177] Exclusions: conversation-raw, legacy_, inbox-brut, test
    EXCLUDED_CATS = {"conversation-raw", "legacy", "inbox-brut", "test", "bruit"}
    rows = sb_get("knowledge_base?select=id,question,answer,category,tags&validated=eq.true&order=id.desc&limit=100")
    rows = [r for r in rows if r.get("category","").lower() not in EXCLUDED_CATS]
    count = 0
    for row in rows:
        text = f"{row.get('question','')}\n{row.get('answer','')}"
        sha = text_sha(text[:CHUNK_MAX])
        if already_indexed(sha):
            continue
        doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"knowledge_base:{row['id']}"))
        n = index_text(text, doc_id, "knowledge_base", row["id"],
                       {"category": row.get("category",""), "tags": str(row.get("tags",""))})
        if n:
            count += n
            log(f"  knowledge_base id={row['id']} -> {n} chunk(s)")
    return count

def process_session_history():
    # [177] Limiter aux 10 sessions les plus récentes - l'historique ancien est redondant
    rows = sb_get("session_history?select=id,tasks_completed,notes,session_start&order=id.desc&limit=10")
    count = 0
    for row in rows:
        text = f"{row.get('notes','')}\n{row.get('tasks_completed','')}"
        if not text.strip() or text.strip() == "\n":
            continue
        sha = text_sha(text[:CHUNK_MAX])
        if already_indexed(sha):
            continue
        doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"session_history:{row['id']}"))
        n = index_text(text, doc_id, "session_history", row["id"],
                       {"session_start": str(row.get("session_start",""))})
        if n:
            count += n
            log(f"  session_history id={row['id']} -> {n} chunk(s)")
    return count

def process_user_profile():
    """Indexe les observations user_profile non encore vectorisees."""
    try:
        rows = sb_get("user_profile?select=id,category,subcategory,observation,source,confidence&order=id.desc&limit=100")
    except Exception as e:
        log(f"  user_profile inaccessible: {e}")
        return 0
    count = 0
    for row in rows:
        text = f"[{row.get('category','')} / {row.get('subcategory','')}] {row.get('observation','')}"
        if not text.strip():
            continue
        sha = text_sha(text[:CHUNK_MAX])
        if already_indexed(sha):
            continue
        doc_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"user_profile:{row['id']}"))
        n = index_text(text, doc_id, "user_profile", row["id"],
                       {"category": row.get("category",""), "confidence": row.get("confidence","")})
        if n:
            count += n
            log(f"  user_profile id={row['id']} [{row.get('category','')}] -> {n} chunk(s)")
    return count


def process_lessons_learned():
    """Indexe les lessons_learned non encore dans bruce_chunks. [177] Exclusions appliquées."""
    # [177] Exclure: non validées, data_family=proposals, intent=SUPERSEDED
    try:
        rows = sb_get("lessons_learned?select=id,lesson_text,lesson_type,importance,intent,data_family,validated&validated=eq.true&order=id.desc&limit=300")
        rows = [r for r in rows
                if r.get("intent","") not in ("SUPERSEDED", "superseded")
                and r.get("data_family","") != "proposals"]
    except Exception as e:
        log(f"  lessons_learned err: {e}")
        return 0
    n_total = 0
    for row in rows:
        text = row.get("lesson_text", "").strip()
        if not text:
            continue
        doc_id = str(__import__("uuid").uuid5(__import__("uuid").NAMESPACE_URL, f"lessons_learned:{row['id']}"))
        n = index_text(text, doc_id, "lessons_learned", row["id"],
                       anchor_extra={"lesson_type": row.get("lesson_type"), "importance": row.get("importance")})
        n_total += n
        if n:
            log(f"  lessons_learned id={row['id']} -> {n} chunk(s)")
    return n_total



def process_roadmap():
    """Indexe les entrées roadmap non encore dans bruce_chunks."""
    try:
        rows = sb_get("roadmap?select=id,step_name,description,status,priority,model_hint&order=id.desc&limit=300")
    except Exception as e:
        log(f"  roadmap err: {e}")
        return 0
    n_total = 0
    for row in rows:
        name = row.get("step_name", "").strip()
        desc = row.get("description", "") or ""
        text = f"[ROADMAP] [{row['id']}] {name}\n{desc}".strip()
        if not text:
            continue
        doc_id = str(__import__("uuid").uuid5(__import__("uuid").NAMESPACE_URL, f"roadmap:{row['id']}"))
        n = index_text(text, doc_id, "roadmap", row["id"],
                       anchor_extra={
                           "category": "roadmap",
                           "status": row.get("status", ""),
                           "priority": str(row.get("priority", "")),
                           "model_hint": row.get("model_hint", "")
                       })
        n_total += n
        if n:
            log(f"  roadmap id={row['id']} [{name[:40]}] -> {n} chunk(s)")
    return n_total



def process_bruce_tools():
    """Indexe les outils bruce_tools (schema 12 champs Yann, Opus 142)."""
    try:
        rows = sb_get("bruce_tools?select=id,name,description,trigger_texts,category,tool_type,status,when_to_use,when_not_to_use,location,how_to_run&status=neq.deprecated&order=id.asc")
    except Exception as e:
        log(f"  bruce_tools err: {e}")
        return 0
    n_total = 0
    for row in rows:
        name = row.get("name", "").strip()
        desc = row.get("description", "") or ""
        trigger_texts = row.get("trigger_texts") or []
        if isinstance(trigger_texts, str):
            import json as _json
            try: trigger_texts = _json.loads(trigger_texts)
            except: trigger_texts = []
        trigger = " ".join(trigger_texts) if isinstance(trigger_texts, list) else str(trigger_texts)
        when_use = row.get("when_to_use", "") or ""
        when_not = row.get("when_not_to_use", "") or ""
        location = row.get("location", "") or ""
        how_run = row.get("how_to_run", "") or ""
        # Texte riche pour embedding: nom + type + trigger + description + quand utiliser
        text = f"[TOOL] {name} ({row.get('tool_type', '')})"
        text += f"\n{trigger}"
        text += f"\n{desc}"
        if when_use:
            text += f"\nQuand utiliser: {when_use}"
        if when_not:
            text += f"\nNe pas utiliser: {when_not}"
        if location:
            text += f"\nLocalisation: {location}"
        text = text.strip()
        if not text:
            continue
        doc_id = str(__import__("uuid").uuid5(__import__("uuid").NAMESPACE_URL, f"bruce_tools:{row['id']}"))
        n = index_text(text, doc_id, "bruce_tools", row["id"],
                       anchor_extra={
                           "category": row.get("category", ""),
                           "tool_type": row.get("tool_type", ""),
                           "status": row.get("status", "")
                       })
        n_total += n
        if n:
            log(f"  tool id={row['id']} [{name[:40]}] -> {n} chunk(s)")
    return n_total


def process_projects():
    """Indexe les projets de la table projects non encore dans bruce_chunks."""
    try:
        rows = sb_get("projects?select=id,slug,name,summary,state,priority_score,tags,owner,project_scope&order=priority_score.desc.nullslast&limit=200")
    except Exception as e:
        log(f"  projects err: {e}")
        return 0
    n_total = 0
    for row in rows:
        name = row.get("name", "").strip()
        slug = row.get("slug", "") or ""
        summary = row.get("summary", "") or ""
        state = row.get("state", "") or ""
        tags = row.get("tags") or []
        if isinstance(tags, list):
            tags_str = " ".join(str(t) for t in tags)
        else:
            tags_str = str(tags)
        owner = row.get("owner", "") or ""
        scope = row.get("project_scope", "") or ""
        text = f"[PROJECT] {name} ({slug})"
        if state:
            text += f" state={state}"
        if summary:
            text += f"\n{summary}"
        if tags_str:
            text += f"\ntags: {tags_str}"
        if owner:
            text += f"\nowner: {owner}"
        text = text.strip()
        if not text or not name:
            continue
        doc_id = str(__import__("uuid").uuid5(__import__("uuid").NAMESPACE_URL, f"projects:{row['id']}"))
        n = index_text(text, doc_id, "projects", row["id"],
                       anchor_extra={
                           "category": "project",
                           "state": state,
                           "project_scope": scope,
                           "slug": slug
                       })
        n_total += n
        if n:
            log(f"  project id={row['id']} [{name[:40]}] -> {n} chunk(s)")
    return n_total

if __name__ == "__main__":
    once = "--once" in sys.argv
    log("=== EMBED WORKER DEMARRE ===")
    log(f"Mode: {'once' if once else f'continu ({POLL_SEC}s)'}")

    cycle = 0
    while True:
        cycle += 1
        total = 0
        try:
            total += process_lessons_learned()
            total += process_knowledge_base()
            total += process_session_history()
            total += process_user_profile()
            total += process_roadmap()
            total += process_projects()
            total += process_bruce_tools()
            if total:
                log(f"Cycle {cycle}: {total} nouveaux chunk(s) indexes")
            else:
                print(f"  ... cycle {cycle}, rien de nouveau", end="\r", flush=True)
        except Exception as e:
            log(f"ERREUR cycle {cycle}: {e}")
            traceback.print_exc()

        if once:
            log(f"=== TERMINE: {total} chunks ===")
            break
        time.sleep(POLL_SEC)
