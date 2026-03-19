#!/usr/bin/env python3
"""
bruce_screensaver.py v5.0
Hardened multi-job LLM screensaver for BRUCE homelab.
"""

import argparse
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import random
import shutil
import signal
import sys
import time
from typing import Any, Dict, List, Optional

import numpy as np
import requests

import llm_selector
import llm_swapper


VERSION = "v5.0"

CONFIG: Dict[str, Any] = {
    "author_system": "llm-screensaver",
    "profiles_path": "/home/furycom/llm_profiles.json",
    "timeouts": {
        "default": 30,
        "llm": 450,
        "embedder": 60,
        "lightrag": 60,
        "notification": 10,
    },
    "retries": {
        "count": 2,
        "backoff_seconds": [2, 5],
    },
    "sleep": {
        "busy_retry": 60,
        "busy_jitter": 10,
        "work_done": 300,
        "work_jitter": 30,
        "all_empty": 1800,
        "empty_jitter": 120,
        "disabled_cooldown": 3600,
    },
    "thresholds": {
        "dedup_similarity": 0.85,
        "large_file_bytes": 1024 * 1024,
        "chunk_chars": 4000,
        "disable_after_failures": 3,
        "reject_after_ingest_failures": 3,
    },
    "batch_sizes": {
        "lesson_review": 2,
        "lesson_review_pipeline": 6,
        "kb_audit": 3,
        "kb_audit_pipeline": 6,
        "dedup_fetch": 20,
        "lightrag_fetch": 5,
        "session_fetch": 1,
    },
    "heartbeat_every_cycles": 10,
    "paths": {
        "logs_dir": "/home/furycom/logs",
        "log_file": "/home/furycom/logs/screensaver.log",
        "state_file": "/home/furycom/logs/screensaver_state.json",
        "lock_file": "/home/furycom/logs/screensaver.lock",
        "raw_llm_dir": "/home/furycom/logs/screensaver_raw_llm",
        "inbox_dir": "/home/furycom/inbox",
        "inbox_done_dir": "/home/furycom/inbox/done",
        "inbox_rejected_dir": "/home/furycom/inbox/rejected",
    },
    "llm_status": {
        "url": "http://192.168.2.230:4000/bruce/llm/status",
        "headers": {"Authorization": "Bearer bruce-secret-token-01"},
    },
    "litellm": {
        "url": "http://192.168.2.32:8000/v1/chat/completions",
        "headers": {
            "Authorization": "Bearer token-abc123",
            "Content-Type": "application/json",
        },
        "temperature": 0,
    },
    "supabase": {
        "base_url": "http://192.168.2.146:8000/rest/v1",
        "service_key": (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UtZGVtbyIsImlhdCI6MTc3MTQ3MDcyMSwiZXhwIjoxOTI5MTUwNzIxfQ."
            "cCJJYdmcVWOV-qTZ8EW3NvqJKhAhvJ4GkWZCyfWyYEg"
        ),
    },
    "bruce_write": {
        "url": "http://192.168.2.230:4000/bruce/write",
        "headers": {"Content-Type": "application/json"},
    },
    "lightrag": {
        "login_url": "http://192.168.2.230:9621/login",
        "insert_url": "http://192.168.2.230:9621/documents/text",
        "pipeline_status_url": "http://192.168.2.230:9621/documents/pipeline_status",
        "username": "bruce",
        "password": "bruce-lightrag-2026",
    },
    "embedder": {
        "url": "http://192.168.2.85:8081/embed",
        "headers": {"Content-Type": "application/json"},
    },
    "ntfy": {
        "url": "http://192.168.2.174:8080/bruce-alerts",
        "headers": {
            "Title": "LLM Screensaver",
            "Tags": "robot,bruce",
            "Priority": "2",
        },
    },
}

PROMPTS = {
    "lesson_review": """/no_think
Tu es un auditeur qualite expert pour BRUCE, un systeme de gouvernance technique automatise d'un homelab AI. Ta tache est VITALE: une evaluation incorrecte degraderait la fiabilite de la memoire du systeme.

CONTEXTE ACTUEL (mars 2026):
- BRUCE = homelab: Proxmox (box1 .58, box2 .103), Supabase (.146), MCP Gateway (.230), n8n (.174), Langfuse (.154)
- LLM actuel: Qwen3-32B Q4_K_M via llama.cpp server-cuda sur Dell 7910 (.32). API key token-abc123. Port 8000.
- TECHNOLOGIES OBSOLETES (a archiver si mentionnees): vLLM, Qwen 7B, Qwen 2.5 8B, Qwen2.5-7B-Instruct-AWQ, Ollama sur .32, ancienne commande "vllm serve"
- TECHNOLOGIES ACTUELLES: llama.cpp, Qwen3-32B, LiteLLM proxy .230:4100, BGE-m3 embedder .85

REGLES STRICTES:
1. JAMAIS archiver les lessons de type user_wish. Les souhaits de Yann sont sacres, meme anciens ou pas encore realises. Un souhait ancien n'est PAS un souhait mort.
2. JAMAIS upgrader a critical une lesson qui mentionne une technologie obsolete (vLLM, Qwen 7B, Qwen 2.5). Archiver plutot.
3. Les lessons <80 caracteres sans information actionnable doivent etre archivees.
4. improved_text doit etre concis. Ne PAS recopier le texte original en entier. Reformuler en gardant les infos cles seulement.

LECONS A ANALYSER:
{batch}

CRITERES:
- ARCHIVE: techno obsolete (voir liste ci-dessus), trop vague/generique (<80 chars), doublon, aucune info actionnable
- UPGRADE: decision/regle architecturale importante sous-evaluee, warning critique trop bas. Uniquement pour infos ACTUELLES et valides.
- DOWNGRADE: marquee critical/high mais detail mineur, temporaire, ou historique sans valeur future
- KEEP: correct tel quel
- improved_text: reformule CONCISEMENT si mal ecrit, null sinon. Max 300 chars pour improved_text.

JSON strict sans markdown:
{"reviews": [{"id": N, "verdict": "keep|archive|upgrade|downgrade", "new_importance": "critical|high|normal|low", "reason": "1 phrase", "improved_text": "texte ou null"}]}""",
    "kb_audit": """/no_think
Tu es un auditeur de la base de connaissances BRUCE (homelab AI). Analyse ces entrees.

CONTEXTE: Proxmox, Supabase (.146), MCP Gateway (.230), Qwen3-32B (.32), n8n (.174), BGE-m3 embedder (.85).

ENTREES KB:
{batch}

Pour chaque entree:
- ARCHIVE: obsolete, incorrecte, remplacee
- KEEP: correct et utile
- UPDATE: correct mais texte a ameliorer

JSON strict sans markdown:
{"reviews": [{"id": N, "verdict": "keep|archive|update", "reason": "1 phrase", "improved_text": "texte ou null"}]}""",
    "dedup": """/no_think
Ces deux lecons sont-elles des doublons (meme information, reformulee ou redondante)?

LECON A (ID {id_a}):
{text_a}

LECON B (ID {id_b}):
{text_b}

Reponds en JSON strict:
{"is_duplicate": true/false, "keep_id": N, "archive_id": N, "reason": "explication"}
Si pas doublon: {"is_duplicate": false}""",
    "ingestion": """/no_think
Tu es un extracteur de memoire BRUCE, dans un scenario critique ou la securite et la tracabilite du systeme sont en jeu. Ta tache est d'analyser le texte fourni et d'en extraire de maniere exhaustive TOUTES les informations pertinentes pour un systeme de gouvernance technique automatise. Cela inclut des lecons de diagnostic, des decisions, des souhaits, un profil utilisateur, et un resume. Sois genereux dans ton extraction - mieux vaut trop que trop peu. Garantir une sortie 100% JSON valide.

TEXTE:
{chunk}

JSON strict:
{"lessons": [{"lesson_type": "architecture|decision|diagnostic|warning|solution|process", "lesson_text": "texte complet min 80 chars", "importance": "critical|high|normal"}], "kb_entries": [{"question": "question", "answer": "reponse", "category": "infrastructure|governance|llm|media|architecture"}], "decisions": [{"text": "decision", "importance": "critical|high|normal"}], "wishes": [{"text": "souhait"}], "summary": "resume 2-3 phrases"}""",
    "session_summary": """/no_think
Resume cette session BRUCE en 3-5 phrases. Inclus: taches accomplies, decisions prises, problemes rencontres, prochaines etapes.

LESSONS DE LA SESSION:
{lessons}

JSON strict:
{"summary": "resume concis"}""",
}

LOGGER = logging.getLogger("bruce_screensaver")
HTTP = requests.Session()
STATE: Dict[str, Any] = {}
LOCK_ACQUIRED = False
SELECTOR: Optional[llm_selector.LLMSelector] = None
PROFILES_ENABLED = False


def ensure_dirs() -> None:
    os.makedirs(CONFIG["paths"]["logs_dir"], exist_ok=True)
    os.makedirs(CONFIG["paths"]["raw_llm_dir"], exist_ok=True)
    os.makedirs(CONFIG["paths"]["inbox_done_dir"], exist_ok=True)
    os.makedirs(CONFIG["paths"]["inbox_rejected_dir"], exist_ok=True)


def setup_logging() -> None:
    ensure_dirs()
    LOGGER.setLevel(logging.INFO)
    LOGGER.handlers.clear()
    fmt = logging.Formatter("[%(asctime)s] [%(job)s] [model=%(model_name)s] %(message)s", datefmt="%H:%M:%S")

    class ContextFilter(logging.Filter):
        def filter(self, record):
            if not hasattr(record, "job"):
                record.job = "SYSTEM"
            if not hasattr(record, "model_name"):
                record.model_name = "-"
            return True

    fh = RotatingFileHandler(CONFIG["paths"]["log_file"], maxBytes=5 * 1024 * 1024, backupCount=3)
    fh.setFormatter(fmt)
    fh.addFilter(ContextFilter())
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    sh.addFilter(ContextFilter())
    LOGGER.addHandler(fh)
    LOGGER.addHandler(sh)


def log(job: str, level: int, message: str, model_name: Optional[str] = None) -> None:
    LOGGER.log(level, message, extra={"job": job, "model_name": model_name or "-"})


def load_selector() -> Optional[llm_selector.LLMSelector]:
    global SELECTOR, PROFILES_ENABLED
    if SELECTOR is None:
        SELECTOR = llm_selector.LLMSelector(CONFIG["profiles_path"])
        PROFILES_ENABLED = SELECTOR.is_available()
        if PROFILES_ENABLED:
            models = [item["key"] for item in SELECTOR.list_enabled_models()]
            log("SYSTEM", logging.INFO, f"Loaded LLM routing profiles models={models}")
        else:
            log("SYSTEM", logging.WARNING, f"LLM profiles unavailable, falling back to alpha only path={CONFIG['profiles_path']}")
    return SELECTOR if PROFILES_ENABLED else None


def save_raw_llm(job: str, raw: str) -> None:
    ts = int(time.time())
    path = os.path.join(CONFIG["paths"]["raw_llm_dir"], f"{job}_{ts}.txt")
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(raw)
    except Exception as exc:
        log(job, logging.ERROR, f"Failed saving raw LLM output: {exc}")


def read_json(path: str, default: Any) -> Any:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as exc:
        log("SYSTEM", logging.ERROR, f"Failed reading JSON {path}: {exc}")
        return default


def write_json(path: str, payload: Any) -> None:
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
    except Exception as exc:
        log("SYSTEM", logging.ERROR, f"Failed writing JSON {path}: {exc}")


def load_state() -> None:
    global STATE
    default = {
        "dedup_last_id": 0,
        "lightrag_lessons_last_id": 0,
        "lightrag_kb_last_id": 0,
        "ingestion": {},
        "jobs": {},
        "skip_offset": {"lesson_review": 0, "kb_audit": 0},
        "metrics": {
            "cycles": 0,
            "batches": 0,
            "items_updated": 0,
            "items_archived": 0,
            "duplicates_archived": 0,
            "lightrag_inserts": 0,
            "files_completed": 0,
            "notifications_sent": 0,
        },
    }
    STATE = read_json(CONFIG["paths"]["state_file"], default)
    for key, value in default.items():
        if key not in STATE:
            STATE[key] = value
    save_state()


def save_state() -> None:
    write_json(CONFIG["paths"]["state_file"], STATE)


def metric_inc(name: str, amount: int = 1) -> None:
    STATE.setdefault("metrics", {})
    STATE["metrics"][name] = STATE["metrics"].get(name, 0) + amount
    save_state()


def send_notification(message: str) -> None:
    try:
        resp = HTTP.post(
            CONFIG["ntfy"]["url"],
            headers=CONFIG["ntfy"]["headers"],
            data=message.encode("utf-8"),
            timeout=CONFIG["timeouts"]["notification"],
        )
        if resp.ok:
            metric_inc("notifications_sent")
    except Exception as exc:
        log("SYSTEM", logging.WARNING, f"Notification failed: {exc}")


def normalize_text(text: str) -> str:
    return " ".join((text or "").split()).strip()


def hash_text(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def jitter_sleep(base: int, jitter: int) -> None:
    delay = base + random.randint(-jitter, jitter)
    if delay < 1:
        delay = 1
    time.sleep(delay)


def get_job_state(job: str) -> Dict[str, Any]:
    STATE.setdefault("jobs", {})
    if job not in STATE["jobs"]:
        STATE["jobs"][job] = {"failures": 0, "disabled_until": 0, "last_error": None, "last_failure_ts": 0}
    return STATE["jobs"][job]


def job_disabled(job: str) -> bool:
    js = get_job_state(job)
    if js["disabled_until"] > time.time():
        remaining = int(js["disabled_until"] - time.time())
        log(job, logging.WARNING, f"Job disabled for {remaining}s")
        return True
    return False


def job_success(job: str) -> None:
    js = get_job_state(job)
    js["failures"] = 0
    js["last_error"] = None
    save_state()


def job_failure(job: str, reason: str) -> None:
    js = get_job_state(job)
    js["failures"] += 1
    js["last_error"] = reason
    js["last_failure_ts"] = int(time.time())
    log(job, logging.ERROR, f"Failure count={js['failures']} reason={reason}")
    if js["failures"] >= CONFIG["thresholds"]["disable_after_failures"]:
        js["disabled_until"] = int(time.time()) + CONFIG["sleep"]["disabled_cooldown"]
        js["failures"] = 0
        log(job, logging.WARNING, "Job disabled for 1 hour after repeated failures")
        send_notification(f"Job {job} disabled for 1 hour after repeated failures: {reason}")
    save_state()


def acquire_lock() -> None:
    global LOCK_ACQUIRED
    path = CONFIG["paths"]["lock_file"]
    if os.path.exists(path):
        info = read_json(path, {})
        pid = info.get("pid")
        if pid:
            try:
                os.kill(pid, 0)
                print(f"Another screensaver instance appears to be running with PID {pid}")
                sys.exit(1)
            except OSError:
                pass
    write_json(path, {"pid": os.getpid(), "started_at": int(time.time()), "version": VERSION})
    LOCK_ACQUIRED = True


def release_lock() -> None:
    if LOCK_ACQUIRED:
        try:
            os.remove(CONFIG["paths"]["lock_file"])
        except Exception:
            pass


def shutdown_handler(*_args) -> None:
    release_lock()
    sys.exit(0)


def request_with_retry(method, url, job, *, headers=None, params=None, json_body=None, data=None, timeout=None):
    attempts = CONFIG["retries"]["count"]
    backoff = CONFIG["retries"]["backoff_seconds"]
    for i in range(attempts):
        try:
            resp = HTTP.request(
                method=method,
                url=url,
                headers=headers,
                params=params,
                json=json_body,
                data=data,
                timeout=timeout or CONFIG["timeouts"]["default"],
            )
            if resp.ok:
                return resp
            log(job, logging.WARNING, f"{method} {url} status={resp.status_code} attempt={i + 1}")
        except Exception as exc:
            log(job, logging.WARNING, f"{method} {url} exception={exc} attempt={i + 1}")
        if i < attempts - 1:
            time.sleep(backoff[min(i, len(backoff) - 1)])
    return None


def parse_llm_json(job: str, raw: str) -> Optional[Any]:
    try:
        return json.loads(raw)
    except Exception:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end != -1 and end > start:
        candidate = raw[start : end + 1]
        try:
            return json.loads(candidate)
        except Exception:
            pass
    log(job, logging.ERROR, "Invalid JSON from LLM")
    save_raw_llm(job, raw)
    return None


def check_idle() -> bool:
    resp = request_with_retry(
        "GET",
        CONFIG["llm_status"]["url"],
        "LLM",
        headers=CONFIG["llm_status"]["headers"],
        timeout=CONFIG["timeouts"]["default"],
    )
    if not resp:
        log("LLM", logging.WARNING, "Could not verify LLM status; treating as busy")
        return False
    try:
        payload = resp.json()
        busy = bool(payload.get("llama_server", {}).get("slot_busy", True))
        log("LLM", logging.INFO, f"slot_busy={busy}")
        return not busy
    except Exception as exc:
        log("LLM", logging.WARNING, f"Invalid LLM status JSON: {exc}")
        return False


def resolve_model_profile(job: str, model_key: Optional[str]) -> Optional[Dict[str, Any]]:
    selector = load_selector()
    if not model_key:
        return None
    if not selector:
        if model_key == "alpha":
            return {"key": "alpha", "name": "alpha"}
        log(job, logging.WARNING, f"Profiles unavailable, cannot resolve model {model_key}; falling back to alpha")
        return {"key": "alpha", "name": "alpha"}
    profile = selector.get_model_by_key(model_key)
    if profile:
        return profile
    fallback = selector.get_fallback(job)
    if fallback:
        log(job, logging.WARNING, f"Unknown/disabled model {model_key} for job {job}; using fallback {fallback}")
        return selector.get_model_by_key(fallback)
    return None


def ensure_model_loaded(job: str, model_key: Optional[str]) -> Optional[Dict[str, Any]]:
    profile = resolve_model_profile(job, model_key)
    if not profile:
        return None
    selector = load_selector()
    if not selector or not selector.is_available() or profile.get("key") == "alpha" and profile.get("gguf_dir") is None:
        return profile
    swap_config = selector.get_swap_config()
    if swap_config.get("health_check_url") == "http://localhost:8000/health":
        swap_config["health_check_url"] = "http://192.168.2.32:8000/health"
    if not llm_swapper.ensure_model(profile["key"], profile, swap_config):
        log(job, logging.ERROR, f"Failed ensuring model {profile['key']}", model_name=profile.get("name"))
        return None
    return profile


def llm_call(job: str, prompt: str, max_tokens: int, model_key: Optional[str] = None) -> Optional[Any]:
    if not prompt.startswith("/no_think"):
        log(job, logging.ERROR, "Prompt missing /no_think")
        return None
    model_name = "alpha"
    payload_model = model_key or "alpha"
    if model_key:
        profile = ensure_model_loaded(job, model_key)
        if not profile:
            return None
        payload_model = profile.get("key", model_key)
        model_name = profile.get("name", payload_model)
    started = time.time()
    payload = {
        "model": payload_model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": CONFIG["litellm"]["temperature"],
        "reasoning_format": "none",
    }
    log(job, logging.INFO, f"LLM call prompt_len={len(prompt)} max_tokens={max_tokens}", model_name=model_name)
    resp = request_with_retry(
        "POST",
        CONFIG["litellm"]["url"],
        job,
        headers=CONFIG["litellm"]["headers"],
        json_body=payload,
        timeout=CONFIG["timeouts"]["llm"],
    )
    if not resp:
        log(job, logging.ERROR, "LLM call failed after retries", model_name=model_name)
        return None
    elapsed = round(time.time() - started, 2)
    try:
        raw = resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:
        log(job, logging.ERROR, f"Failed parsing LLM envelope: {exc}", model_name=model_name)
        save_raw_llm(job, resp.text[:20000])
        return None
    parsed = parse_llm_json(job, raw)
    if parsed is None:
        log(job, logging.ERROR, f"LLM JSON parse failed elapsed={elapsed}s", model_name=model_name)
        return None
    log(job, logging.INFO, f"LLM success elapsed={elapsed}s", model_name=model_name)
    return parsed


def supabase_headers(extra=None):
    key = CONFIG["supabase"]["service_key"]
    headers = {"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"}
    if extra:
        headers.update(extra)
    return headers


def supabase_get(job, table, params):
    url = f"{CONFIG['supabase']['base_url']}/{table}"
    resp = request_with_retry("GET", url, job, headers=supabase_headers(), params=params)
    if not resp:
        return None
    try:
        data = resp.json()
        if isinstance(data, list):
            return data
    except Exception as exc:
        log(job, logging.ERROR, f"Supabase JSON parse error table={table}: {exc}")
    return None


def supabase_patch(job, table, match, patch):
    url = f"{CONFIG['supabase']['base_url']}/{table}"
    params = {k: f"eq.{v}" for k, v in match.items()}
    headers = supabase_headers({"Prefer": "return=minimal"})
    resp = request_with_retry("PATCH", url, job, headers=headers, params=params, json_body=patch)
    if not resp:
        log(job, logging.ERROR, f"PATCH failed table={table} match={match}")
        return False
    return True


def bruce_write(job, payload):
    resp = request_with_retry("POST", CONFIG["bruce_write"]["url"], job, headers=CONFIG["bruce_write"]["headers"], json_body=payload)
    if not resp:
        log(job, logging.ERROR, "BRUCE write failed")
        return False
    return True


def get_embeddings(job, texts):
    resp = request_with_retry(
        "POST",
        CONFIG["embedder"]["url"],
        job,
        headers=CONFIG["embedder"]["headers"],
        json_body={"inputs": texts},
        timeout=CONFIG["timeouts"]["embedder"],
    )
    if not resp:
        log(job, logging.ERROR, "Embedder unavailable")
        return None
    try:
        data = resp.json()
        if isinstance(data, list):
            return data
    except Exception as exc:
        log(job, logging.ERROR, f"Embedder JSON parse error: {exc}")
    return None


def cosine_similarity(vec_a, vec_b):
    a = np.array(vec_a, dtype=np.float32)
    b = np.array(vec_b, dtype=np.float32)
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0.0:
        return 0.0
    return float(np.dot(a, b) / denom)


def chunk_text(text, chunk_chars):
    text = text.strip()
    if not text:
        return []
    parts = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in ".!?\n":
            if buf.strip():
                parts.append(buf.strip())
            buf = ""
    if buf.strip():
        parts.append(buf.strip())
    chunks = []
    current = ""
    for part in parts:
        if len(current) + len(part) + 1 <= chunk_chars:
            current = f"{current} {part}".strip()
        else:
            if current:
                chunks.append(current)
            if len(part) <= chunk_chars:
                current = part
            else:
                for i in range(0, len(part), chunk_chars):
                    chunks.append(part[i : i + chunk_chars])
                current = ""
    if current:
        chunks.append(current)
    return chunks


def format_lessons_batch(rows):
    return json.dumps(rows, ensure_ascii=False, indent=2)


def format_kb_batch(rows):
    return json.dumps(rows, ensure_ascii=False, indent=2)


def lightrag_login(job):
    resp = request_with_retry(
        "POST",
        CONFIG["lightrag"]["login_url"],
        job,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"username": CONFIG["lightrag"]["username"], "password": CONFIG["lightrag"]["password"]},
        timeout=CONFIG["timeouts"]["lightrag"],
    )
    if not resp:
        return None
    try:
        return resp.json().get("access_token")
    except Exception as exc:
        log(job, logging.ERROR, f"LightRAG login parse error: {exc}")
        return None


def lightrag_pipeline_busy(job, token):
    resp = request_with_retry(
        "GET",
        CONFIG["lightrag"]["pipeline_status_url"],
        job,
        headers={"Authorization": f"Bearer {token}"},
        timeout=CONFIG["timeouts"]["lightrag"],
    )
    if not resp:
        return None
    try:
        return bool(resp.json().get("pipeline_busy", False))
    except Exception as exc:
        log(job, logging.ERROR, f"LightRAG status parse error: {exc}")
        return None


def lightrag_insert(job, token, text, file_source):
    resp = request_with_retry(
        "POST",
        CONFIG["lightrag"]["insert_url"],
        job,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json_body={"text": text, "file_source": file_source},
        timeout=CONFIG["timeouts"]["lightrag"],
    )
    if not resp:
        log(job, logging.ERROR, "LightRAG insert failed")
        return False
    metric_inc("lightrag_inserts")
    return True


def get_pipeline_for_job(job: str) -> List[str]:
    selector = load_selector()
    if selector and selector.is_available():
        pipeline = selector.get_pipeline(job)
        if pipeline:
            return pipeline
        fallback = selector.get_fallback(job)
        return [fallback] if fallback else []
    return ["alpha"]


def get_review_confidence(review: Dict[str, Any]) -> float:
    value = review.get("confidence", review.get("confidence_score"))
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def make_triage_prompt(rows: List[Dict[str, Any]]) -> str:
    batch = format_lessons_batch(rows)
    return (
        "/no_think\n"
        "Tu es un pre-filtre rapide BRUCE. Pour chaque lecon, decide si elle peut etre archivee immediatement "
        "(trop vague, obsolete, doublon probable, sans valeur) ou si elle doit passer a une revue detaillee.\n\n"
        f"LECONS:\n{batch}\n\n"
        'JSON strict sans markdown: {"reviews": [{"id": N, "verdict": "archive|review", '
        '"reason": "1 phrase", "confidence": 0.0}]}'
    )


def make_lesson_verify_prompt(rows: List[Dict[str, Any]], prior_reviews: List[Dict[str, Any]]) -> str:
    return (
        "/no_think\n"
        "Verifie ces lecons avec autorite finale. Confirme ou corrige le verdict precedent et fournis une confiance explicite.\n\n"
        f"LECONS:\n{format_lessons_batch(rows)}\n\n"
        f"REVUES PRECEDENTES:\n{json.dumps(prior_reviews, ensure_ascii=False, indent=2)}\n\n"
        'JSON strict sans markdown: {"reviews": [{"id": N, "verdict": "keep|archive|upgrade|downgrade", '
        '"new_importance": "critical|high|normal|low", "reason": "1 phrase", '
        '"improved_text": "texte ou null", "confidence": 0.0}]}'
    )


def make_kb_verify_prompt(rows: List[Dict[str, Any]], prior_reviews: List[Dict[str, Any]]) -> str:
    return (
        "/no_think\n"
        "Verifie ces entrees KB avec autorite finale. Confirme ou corrige le verdict precedent et fournis une confiance explicite.\n\n"
        f"ENTREES KB:\n{format_kb_batch(rows)}\n\n"
        f"REVUES PRECEDENTES:\n{json.dumps(prior_reviews, ensure_ascii=False, indent=2)}\n\n"
        'JSON strict sans markdown: {"reviews": [{"id": N, "verdict": "keep|archive|update", '
        '"reason": "1 phrase", "improved_text": "texte ou null", "confidence": 0.0}]}'
    )


def patch_lesson_review(job: str, review: Dict[str, Any]) -> Dict[str, Any]:
    lesson_id = review.get("id")
    verdict = review.get("verdict")
    patch = {"author_system": CONFIG["author_system"]}
    if verdict == "archive":
        patch["archived"] = True
        metric_inc("items_archived")
    elif verdict in ("keep", "upgrade", "downgrade"):
        if review.get("new_importance"):
            patch["importance"] = review["new_importance"]
    if review.get("improved_text"):
        patch["lesson_text"] = review["improved_text"]
        patch["content_hash"] = hash_text(review["improved_text"])
    ok = supabase_patch(job, "lessons_learned", {"id": lesson_id}, patch)
    if ok:
        metric_inc("items_updated")
    return {"id": lesson_id, "verdict": verdict, "ok": ok, "model_name": review.get("model_name")}


def patch_kb_review(job: str, review: Dict[str, Any]) -> Dict[str, Any]:
    entry_id = review.get("id")
    verdict = review.get("verdict")
    patch = {"author_system": CONFIG["author_system"]}
    if verdict == "archive":
        patch["archived"] = True
        metric_inc("items_archived")
    elif verdict == "update" and review.get("improved_text"):
        patch["answer"] = review["improved_text"]
        patch["content_hash"] = hash_text(review["improved_text"])
    ok = supabase_patch(job, "knowledge_base", {"id": entry_id}, patch)
    if ok:
        metric_inc("items_updated")
    return {"id": entry_id, "verdict": verdict, "ok": ok, "model_name": review.get("model_name")}


def job_lesson_review():
    job = "lesson_review"
    if job_disabled(job):
        return "empty"
    if not check_idle():
        return "busy"
    pipeline = get_pipeline_for_job(job)
    selector = load_selector()
    pipeline_enabled = bool(selector and selector.is_available() and len(pipeline) > 1)
    params = {
        "select": "id,lesson_type,lesson_text,importance,created_at",
        "archived": "eq.false",
        "lesson_type": "neq.rule_canon",
        "author_system": f"neq.{CONFIG['author_system']}",
        "order": "created_at.asc",
        "limit": CONFIG["batch_sizes"]["lesson_review_pipeline"] if pipeline_enabled else CONFIG["batch_sizes"]["lesson_review"],
    }
    offset = STATE.get("skip_offset", {}).get(job, 0)
    if offset > 0:
        params["offset"] = offset
        log(job, logging.INFO, f"Skipping {offset} rows from previous failures")
    rows = supabase_get(job, "lessons_learned", params)
    if rows is None:
        job_failure(job, "fetch failed")
        return "error"
    if not rows:
        STATE.setdefault("skip_offset", {})[job] = 0
        save_state()
        job_success(job)
        return "empty"
    if not check_idle():
        return "busy"
    if not pipeline_enabled:
        result = llm_call(job, PROMPTS["lesson_review"].replace("{batch}", format_lessons_batch(rows)), 1200, model_key="alpha")
        if not result or "reviews" not in result:
            STATE.setdefault("skip_offset", {})[job] = STATE.get("skip_offset", {}).get(job, 0) + CONFIG["batch_sizes"]["lesson_review"]
            log(job, logging.WARNING, f"Skip offset now {STATE['skip_offset'][job]}")
            save_state()
            job_failure(job, "invalid review payload")
            return "error"
        processed = []
        for review in result.get("reviews", []):
            review["model_name"] = "alpha"
            processed.append(patch_lesson_review(job, review))
        metric_inc("batches")
        log(job, logging.INFO, f"Processed lesson batch={processed}", model_name="alpha")
        STATE.setdefault("skip_offset", {})[job] = 0
        save_state()
        job_success(job)
        return "done"

    threshold = selector.get_confidence_threshold(job)
    triage_model = pipeline[0]
    triage_result = llm_call(job, make_triage_prompt(rows), 1000, model_key=triage_model)
    if not triage_result or "reviews" not in triage_result:
        STATE.setdefault("skip_offset", {})[job] = STATE.get("skip_offset", {}).get(job, 0) + CONFIG["batch_sizes"]["lesson_review_pipeline"]
        save_state()
        job_failure(job, "invalid triage payload")
        return "error"
    row_map = {row["id"]: row for row in rows}
    triage_by_id = {item.get("id"): item for item in triage_result.get("reviews", []) if item.get("id") in row_map}
    final_reviews: Dict[int, Dict[str, Any]] = {}
    pass_rows: List[Dict[str, Any]] = []
    verify_candidates: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        triage_review = triage_by_id.get(row["id"], {"id": row["id"], "verdict": "review", "reason": "missing triage", "confidence": 0.0})
        triage_review["model_name"] = triage_model
        if triage_review.get("verdict") == "archive" and not selector.needs_verification(get_review_confidence(triage_review), job):
            final_reviews[row["id"]] = {
                "id": row["id"],
                "verdict": "archive",
                "reason": triage_review.get("reason", "triage archive"),
                "improved_text": None,
                "model_name": triage_model,
                "confidence": get_review_confidence(triage_review),
            }
        else:
            pass_rows.append(row)
            if selector.needs_verification(get_review_confidence(triage_review), job):
                verify_candidates[row["id"]] = triage_review
    if pass_rows and len(pipeline) > 1:
        review_model = pipeline[1]
        review_result = llm_call(job, PROMPTS["lesson_review"].replace("{batch}", format_lessons_batch(pass_rows)), 1600, model_key=review_model)
        if not review_result or "reviews" not in review_result:
            job_failure(job, "invalid review payload")
            return "error"
        review_by_id = {item.get("id"): item for item in review_result.get("reviews", [])}
        for row in pass_rows:
            review = review_by_id.get(row["id"], {"id": row["id"], "verdict": "keep", "reason": "missing review", "confidence": 0.0})
            review["model_name"] = review_model
            final_reviews[row["id"]] = review
            if selector.needs_verification(get_review_confidence(review), job):
                verify_candidates[row["id"]] = review
    verifier_model = pipeline[2] if len(pipeline) > 2 else selector.get_fallback(job)
    if verify_candidates and verifier_model:
        verify_rows = [row_map[row_id] for row_id in verify_candidates if row_id in row_map]
        prior_reviews = list(verify_candidates.values())
        verify_result = llm_call(job, make_lesson_verify_prompt(verify_rows, prior_reviews), 1800, model_key=verifier_model)
        if not verify_result or "reviews" not in verify_result:
            job_failure(job, f"invalid verification payload threshold={threshold}")
            return "error"
        for review in verify_result.get("reviews", []):
            review["model_name"] = verifier_model
            final_reviews[review.get("id")] = review
    processed = []
    for lesson_id in [row["id"] for row in rows]:
        review = final_reviews.get(lesson_id)
        if not review:
            continue
        processed.append(patch_lesson_review(job, review))
    metric_inc("batches")
    log(job, logging.INFO, f"Processed lesson batch={processed}")
    STATE.setdefault("skip_offset", {})[job] = 0
    save_state()
    job_success(job)
    return "done"


def job_kb_audit():
    job = "kb_audit"
    if job_disabled(job):
        return "empty"
    if not check_idle():
        return "busy"
    pipeline = get_pipeline_for_job(job)
    selector = load_selector()
    pipeline_enabled = bool(selector and selector.is_available() and len(pipeline) > 1)
    rows = supabase_get(
        job,
        "knowledge_base",
        {
            "select": "id,question,answer,category,subcategory,tags,created_at",
            "archived": "eq.false",
            "author_system": f"neq.{CONFIG['author_system']}",
            "order": "created_at.asc",
            "limit": CONFIG["batch_sizes"]["kb_audit_pipeline"] if pipeline_enabled else CONFIG["batch_sizes"]["kb_audit"],
        },
    )
    if rows is None:
        job_failure(job, "fetch failed")
        return "error"
    if not rows:
        job_success(job)
        return "empty"
    if not check_idle():
        return "busy"
    if not pipeline_enabled:
        result = llm_call(job, PROMPTS["kb_audit"].replace("{batch}", format_kb_batch(rows)), 800, model_key="alpha")
        if not result or "reviews" not in result:
            job_failure(job, "invalid kb audit payload")
            return "error"
        processed = []
        for review in result.get("reviews", []):
            review["model_name"] = "alpha"
            processed.append(patch_kb_review(job, review))
        metric_inc("batches")
        log(job, logging.INFO, f"Processed KB batch={processed}", model_name="alpha")
        job_success(job)
        return "done"

    review_model = pipeline[0]
    initial = llm_call(job, PROMPTS["kb_audit"].replace("{batch}", format_kb_batch(rows)), 1000, model_key=review_model)
    if not initial or "reviews" not in initial:
        job_failure(job, "invalid kb audit payload")
        return "error"
    row_map = {row["id"]: row for row in rows}
    final_reviews: Dict[int, Dict[str, Any]] = {}
    verify_candidates: Dict[int, Dict[str, Any]] = {}
    for review in initial.get("reviews", []):
        review["model_name"] = review_model
        final_reviews[review.get("id")] = review
        if selector.needs_verification(get_review_confidence(review), job):
            verify_candidates[review.get("id")] = review
    verifier_model = pipeline[1] if len(pipeline) > 1 else selector.get_fallback(job)
    if verify_candidates and verifier_model:
        verify_rows = [row_map[row_id] for row_id in verify_candidates if row_id in row_map]
        prior_reviews = list(verify_candidates.values())
        verified = llm_call(job, make_kb_verify_prompt(verify_rows, prior_reviews), 1200, model_key=verifier_model)
        if not verified or "reviews" not in verified:
            job_failure(job, "invalid kb verification payload")
            return "error"
        for review in verified.get("reviews", []):
            review["model_name"] = verifier_model
            final_reviews[review.get("id")] = review
    processed = []
    for entry_id in [row["id"] for row in rows]:
        review = final_reviews.get(entry_id)
        if not review:
            continue
        processed.append(patch_kb_review(job, review))
    metric_inc("batches")
    log(job, logging.INFO, f"Processed KB batch={processed}")
    job_success(job)
    return "done"


def job_dedup():
    job = "dedup"
    if job_disabled(job):
        return "empty"
    last_id = int(STATE.get("dedup_last_id", 0))
    rows = supabase_get(
        job,
        "lessons_learned",
        {
            "select": "id,lesson_text",
            "archived": "eq.false",
            "author_system": f"eq.{CONFIG['author_system']}",
            "id": f"gt.{last_id}",
            "order": "id.asc",
            "limit": CONFIG["batch_sizes"]["dedup_fetch"],
        },
    )
    if rows is None:
        job_failure(job, "fetch failed")
        return "error"
    if len(rows) < 2:
        job_success(job)
        return "empty"
    did_work = False
    for idx in range(len(rows) - 1):
        a = rows[idx]
        b = rows[idx + 1]
        embeddings = get_embeddings(job, [a.get("lesson_text", ""), b.get("lesson_text", "")])
        if embeddings is None or len(embeddings) != 2:
            job_failure(job, "embedder unavailable")
            return "error"
        sim = cosine_similarity(embeddings[0], embeddings[1])
        log(job, logging.INFO, f"Compared ids={[a['id'], b['id']]} similarity={sim:.4f}")
        if sim > CONFIG["thresholds"]["dedup_similarity"]:
            if not check_idle():
                return "busy"
            result = llm_call(job, PROMPTS["dedup"].format(id_a=a["id"], text_a=a["lesson_text"], id_b=b["id"], text_b=b["lesson_text"]), 400, model_key="alpha")
            if not result:
                job_failure(job, "invalid dedup payload")
                return "error"
            if result.get("is_duplicate") is True:
                archive_id = result.get("archive_id")
                keep_id = result.get("keep_id")
                ok = supabase_patch(job, "lessons_learned", {"id": archive_id}, {"archived": True})
                log(job, logging.INFO, f"Duplicate keep={keep_id} archive={archive_id} ok={ok}", model_name="alpha")
                if ok:
                    metric_inc("duplicates_archived")
                    metric_inc("items_archived")
        STATE["dedup_last_id"] = b["id"]
        save_state()
        did_work = True
    job_success(job)
    return "done" if did_work else "empty"


def job_lightrag():
    job = "lightrag"
    if job_disabled(job):
        return "empty"
    token = lightrag_login(job)
    if not token:
        job_failure(job, "login failed")
        return "error"
    busy = lightrag_pipeline_busy(job, token)
    if busy is None:
        job_failure(job, "pipeline status failed")
        return "error"
    if busy:
        log(job, logging.WARNING, "LightRAG pipeline busy")
        return "busy"
    lessons_last = int(STATE.get("lightrag_lessons_last_id", 0))
    kb_last = int(STATE.get("lightrag_kb_last_id", 0))
    lessons = supabase_get(
        job,
        "lessons_learned",
        {
            "select": "id,lesson_text",
            "id": f"gt.{lessons_last}",
            "author_system": f"eq.{CONFIG['author_system']}",
            "archived": "eq.false",
            "order": "id.asc",
            "limit": CONFIG["batch_sizes"]["lightrag_fetch"],
        },
    )
    if lessons is None:
        job_failure(job, "lesson fetch failed")
        return "error"
    if lessons:
        row = lessons[0]
        ok = lightrag_insert(job, token, row["lesson_text"], "screensaver_lessons")
        if ok:
            STATE["lightrag_lessons_last_id"] = row["id"]
            save_state()
            job_success(job)
            return "done"
    kb = supabase_get(
        job,
        "knowledge_base",
        {
            "select": "id,question,answer",
            "id": f"gt.{kb_last}",
            "author_system": f"eq.{CONFIG['author_system']}",
            "archived": "eq.false",
            "order": "id.asc",
            "limit": CONFIG["batch_sizes"]["lightrag_fetch"],
        },
    )
    if kb is None:
        job_failure(job, "kb fetch failed")
        return "error"
    if kb:
        row = kb[0]
        text = f"Q: {row.get('question', '')}\nA: {row.get('answer', '')}"
        ok = lightrag_insert(job, token, text, "screensaver_kb")
        if ok:
            STATE["lightrag_kb_last_id"] = row["id"]
            save_state()
            job_success(job)
            return "done"
    job_success(job)
    return "empty"


def list_inbox_files():
    inbox = CONFIG["paths"]["inbox_dir"]
    if not os.path.isdir(inbox):
        return []
    files = []
    for name in sorted(os.listdir(inbox)):
        if name.startswith(".") or name.endswith((".tmp", ".part", ".swp")):
            continue
        full = os.path.join(inbox, name)
        if os.path.isfile(full):
            files.append(full)
    return files


def read_text_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception as exc:
        log("ingestion", logging.ERROR, f"Failed reading {path}: {exc}")
        return None


def move_to_rejected(path, reason):
    dst = os.path.join(CONFIG["paths"]["inbox_rejected_dir"], os.path.basename(path))
    try:
        shutil.move(path, dst)
        log("ingestion", logging.WARNING, f"Moved file to rejected path={dst} reason={reason}")
    except Exception as exc:
        log("ingestion", logging.ERROR, f"Failed moving rejected file {path}: {exc}")


def move_to_done(path):
    dst = os.path.join(CONFIG["paths"]["inbox_done_dir"], os.path.basename(path))
    try:
        shutil.move(path, dst)
        log("ingestion", logging.INFO, f"Moved file to done path={dst}")
        return True
    except Exception as exc:
        log("ingestion", logging.ERROR, f"Failed moving file to done {path}: {exc}")
        return False


def post_ingested_data(job, extracted, source_file):
    created = 0
    for lesson in extracted.get("lessons", []):
        txt = lesson.get("lesson_text", "")
        payload = {
            "type": "lesson",
            "data": {
                "lesson_type": lesson.get("lesson_type"),
                "lesson_text": txt,
                "importance": lesson.get("importance", "normal"),
                "author_system": CONFIG["author_system"],
                "content_hash": hash_text(txt),
                "validated": False,
                "confidence_score": 0.7,
                "project_scope": source_file,
                "data_family": "screensaver_ingestion",
            },
        }
        if bruce_write(job, payload):
            created += 1
    for kb in extracted.get("kb_entries", []):
        q = kb.get("question", "")
        a = kb.get("answer", "")
        payload = {
            "type": "knowledge_base",
            "data": {
                "question": q,
                "answer": a,
                "category": kb.get("category"),
                "author_system": CONFIG["author_system"],
                "content_hash": hash_text(f"{q}|{a}"),
                "validated": False,
                "confidence_score": 0.7,
                "project_scope": source_file,
                "data_family": "screensaver_ingestion",
            },
        }
        if bruce_write(job, payload):
            created += 1
    for decision in extracted.get("decisions", []):
        txt = decision.get("text", "")
        payload = {
            "type": "lesson",
            "data": {
                "lesson_type": "decision",
                "lesson_text": txt,
                "importance": decision.get("importance", "normal"),
                "author_system": CONFIG["author_system"],
                "content_hash": hash_text(txt),
                "validated": False,
                "confidence_score": 0.75,
                "project_scope": source_file,
                "data_family": "screensaver_ingestion",
            },
        }
        if bruce_write(job, payload):
            created += 1
    return created


def job_ingestion():
    job = "ingestion"
    if job_disabled(job):
        return "empty"
    files = list_inbox_files()
    if not files:
        job_success(job)
        return "empty"
    if not check_idle():
        return "busy"
    progress = STATE.setdefault("ingestion", {})
    for path in files:
        text = read_text_file(path)
        if text is None:
            continue
        chunks = chunk_text(text, CONFIG["thresholds"]["chunk_chars"])
        if not chunks:
            move_to_rejected(path, "empty_or_unreadable")
            return "done"
        item_state = progress.setdefault(path, {"chunk_index": 0, "failures": 0, "chunks_total": len(chunks)})
        chunk_index = int(item_state.get("chunk_index", 0))
        size = os.path.getsize(path)
        is_large = size > CONFIG["thresholds"]["large_file_bytes"]
        if chunk_index >= len(chunks):
            if move_to_done(path):
                progress.pop(path, None)
                save_state()
                metric_inc("files_completed")
                job_success(job)
                return "done"
        if not check_idle():
            return "busy"
        prompt = PROMPTS["ingestion"].replace("{chunk}", chunks[chunk_index])
        extracted = llm_call(job, prompt, 2200, model_key="alpha")
        if not extracted:
            item_state["failures"] = item_state.get("failures", 0) + 1
            save_state()
            if item_state["failures"] >= CONFIG["thresholds"]["reject_after_ingest_failures"]:
                progress.pop(path, None)
                save_state()
                move_to_rejected(path, "repeated_invalid_llm_json")
                job_failure(job, f"rejected file after repeated failures path={path}")
                return "done"
            job_failure(job, f"invalid extraction JSON path={path} chunk={chunk_index}")
            return "error"
        created = post_ingested_data(job, extracted, os.path.basename(path))
        log(job, logging.INFO, f"Ingested path={path} chunk={chunk_index + 1}/{len(chunks)} created={created}", model_name="alpha")
        item_state["chunk_index"] = chunk_index + 1
        item_state["chunks_total"] = len(chunks)
        item_state["failures"] = 0
        save_state()
        if is_large:
            job_success(job)
            return "done"
        if item_state["chunk_index"] >= len(chunks):
            if move_to_done(path):
                progress.pop(path, None)
                save_state()
                metric_inc("files_completed")
                job_success(job)
                return "done"
        job_success(job)
        return "done"
    job_success(job)
    return "empty"


def job_session_summary():
    job = "session_summary"
    if job_disabled(job):
        return "empty"
    if not check_idle():
        return "busy"
    sessions = supabase_get(
        job,
        "session_history",
        {
            "select": "id,session_id,created_at,summary",
            "summary": "is.null",
            "order": "created_at.asc",
            "limit": CONFIG["batch_sizes"]["session_fetch"],
        },
    )
    if sessions is None:
        job_failure(job, "session fetch failed")
        return "error"
    if not sessions:
        job_success(job)
        return "empty"
    session = sessions[0]
    session_key = session.get("session_id") or session.get("id")
    lessons = supabase_get(
        job,
        "lessons_learned",
        {
            "select": "id,lesson_text,importance,created_at",
            "session_id": f"eq.{session_key}",
            "order": "created_at.asc",
            "limit": 500,
        },
    )
    if lessons is None:
        job_failure(job, "session lessons fetch failed")
        return "error"
    if not check_idle():
        return "busy"
    result = llm_call(job, PROMPTS["session_summary"].replace("{lessons}", json.dumps(lessons, ensure_ascii=False, indent=2)), 500, model_key="alpha")
    if not result or "summary" not in result:
        job_failure(job, "invalid session summary payload")
        return "error"
    ok = supabase_patch(job, "session_history", {"id": session["id"]}, {"summary": result["summary"]})
    if not ok:
        job_failure(job, "session summary patch failed")
        return "error"
    metric_inc("items_updated")
    job_success(job)
    return "done"


JOBS = [
    ("lesson_review", job_lesson_review),
    ("kb_audit", job_kb_audit),
    ("dedup", job_dedup),
    ("lightrag", job_lightrag),
    ("ingestion", job_ingestion),
    ("session_summary", job_session_summary),
]


def startup_log():
    log("SYSTEM", logging.INFO, f"Starting {VERSION}")
    log(
        "SYSTEM",
        logging.INFO,
        f"Cursors dedup={STATE.get('dedup_last_id', 0)} lightrag_lessons={STATE.get('lightrag_lessons_last_id', 0)} lightrag_kb={STATE.get('lightrag_kb_last_id', 0)}",
    )
    log("SYSTEM", logging.INFO, f"Metrics={STATE.get('metrics', {})}")


def heartbeat():
    metrics = STATE.get("metrics", {})
    log("SYSTEM", logging.INFO, f"Heartbeat metrics={metrics}")


def run_cycle():
    metric_inc("cycles")
    if STATE["metrics"]["cycles"] % CONFIG["heartbeat_every_cycles"] == 0:
        heartbeat()
    if not check_idle():
        log("SYSTEM", logging.INFO, "LLM busy at cycle start")
        return "busy"
    job_executed = False
    for job_name, job_fn in JOBS:
        log("SYSTEM", logging.INFO, f"Considering job={job_name}")
        try:
            result = job_fn()
            log("SYSTEM", logging.INFO, f"Job={job_name} result={result}")
            if result == "done":
                job_executed = True
                break
            if result == "empty":
                continue
            if result == "busy":
                break
            if result == "error":
                continue
        except Exception as exc:
            log(job_name, logging.ERROR, f"Unhandled exception: {exc}")
            job_failure(job_name, str(exc))
            continue
    return "done" if job_executed else "empty"


def main_loop():
    while True:
        result = run_cycle()
        if result == "done":
            jitter_sleep(CONFIG["sleep"]["work_done"], CONFIG["sleep"]["work_jitter"])
            continue
        if check_idle():
            jitter_sleep(CONFIG["sleep"]["all_empty"], CONFIG["sleep"]["empty_jitter"])
        else:
            jitter_sleep(CONFIG["sleep"]["busy_retry"], CONFIG["sleep"]["busy_jitter"])


def parse_args():
    parser = argparse.ArgumentParser(description="BRUCE multi-job LLM screensaver")
    parser.add_argument("--loop", action="store_true", help="Run forever")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    parser.add_argument("--test-job", choices=[name for name, _ in JOBS], help="Run only one job once and exit")
    return parser.parse_args()


def main():
    setup_logging()
    load_state()
    load_selector()
    acquire_lock()
    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGHUP, shutdown_handler)
    startup_log()
    args = parse_args()
    if args.test_job:
        mapping = dict(JOBS)
        result = mapping[args.test_job]()
        log("SYSTEM", logging.INFO, f"Test job {args.test_job} -> {result}")
        release_lock()
        return 0
    if args.once:
        result = run_cycle()
        log("SYSTEM", logging.INFO, f"Single cycle result={result}")
        release_lock()
        return 0
    if args.loop:
        try:
            main_loop()
        finally:
            release_lock()
        return 0
    print("Use --loop, --once, or --test-job <n>")
    release_lock()
    return 1


if __name__ == "__main__":
    sys.exit(main())
