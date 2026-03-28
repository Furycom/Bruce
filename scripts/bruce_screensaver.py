#!/usr/bin/env python3
"""
bruce_screensaver.py v5.0-dynamic-context
Hardened multi-job LLM screensaver for BRUCE homelab.
"""

import argparse
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import random
import re
import shutil
import signal
import sys
import time
from typing import Any, Dict, List, Optional

import numpy as np
import requests


VERSION = "v5.1-guardrails"

# -- [1097][1103] Model minimum size guard (Session 1242) --
# Maps model keys to their effective parameter count in billions.
# MoE models use ACTIVE params (e.g. 35B-A3B = 3B active).
MODEL_EFFECTIVE_PARAMS_B = {
    "alpha": 32,        # Qwen3-32B
    "moe35b_triage": 3, # Qwen3.5-35B-A3B MoE -- only 3B active
    "moe_prefilter": 3, # Qwen3-30B-A3B MoE -- only 3B active
    "mid_14b": 14,      # Qwen3-14B
    "fast_9b": 9,       # Qwen3.5-9B
    "mid_27b": 27,      # Qwen3.5-27B
    "valkyrie": 49,     # Valkyrie-49B
}

# Jobs that require >= 32B effective params for quality
JOBS_REQUIRING_32B = {"lesson_review", "kb_audit", "ingestion", "session_summary"}
# Jobs OK on small models (triage work)
JOBS_SMALL_MODEL_OK = {"dedup", "lightrag"}

MIN_MODEL_PARAMS_B = 32


def _model_sufficient_for_job(job_name: str) -> bool:
    """[1097][1103] Check if current model meets minimum size for this job.
    Returns True if job can proceed, False if model is too small."""
    if job_name in JOBS_SMALL_MODEL_OK:
        return True
    if job_name not in JOBS_REQUIRING_32B:
        return True  # unknown jobs pass by default
    current = _get_current_model()
    effective_params = MODEL_EFFECTIVE_PARAMS_B.get(current, 0)
    if effective_params < MIN_MODEL_PARAMS_B:
        log("SYSTEM", logging.WARNING,
            f"[1097] Model \'{current}\' ({effective_params}B) insufficient for job "
            f"\'{job_name}\', minimum {MIN_MODEL_PARAMS_B}B required -- SKIPPING")
        return False
    return True


CONFIG: Dict[str, Any] = {
    "author_system": "llm-screensaver",
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
        "busy_backoff_multiplier": 2,
        "busy_backoff_max": 600,
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
        "kb_audit": 3,
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
        "stop_flag_file": "/home/furycom/mcp-stack/screensaver_stop.flag",
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
        "model": "alpha",
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

{dynamic_context}

LECONS A ANALYSER:
{batch}

CRITERES:
- ARCHIVE: techno obsolete (voir contexte ci-dessus), trop vague/generique (<80 chars), doublon, aucune info actionnable
- UPGRADE: decision/regle architecturale importante sous-evaluee, warning critique trop bas. Uniquement pour infos ACTUELLES et valides.
- DOWNGRADE: marquee critical/high mais detail mineur, temporaire, ou historique sans valeur future
- KEEP: correct tel quel
- improved_text: reformule CONCISEMENT si mal ecrit, null sinon. Max 300 chars pour improved_text.

JSON strict sans markdown:
{"reviews": [{"id": N, "verdict": "keep|archive|upgrade|downgrade", "new_importance": "critical|high|normal|low", "reason": "1 phrase", "improved_text": "texte ou null"}]}""",
    "kb_audit": """/no_think
Tu es un auditeur de la base de connaissances BRUCE (homelab AI). Analyse ces entrees.

{dynamic_context}

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

# -- [1231] Multi-LLM Pipeline support --
PIPELINE_ENABLED = False
_pipeline = None
_last_llm_raw: Optional[str] = None

def _init_pipeline():
    global PIPELINE_ENABLED, _pipeline
    try:
        import bruce_pipeline
        _pipeline = bruce_pipeline.get_pipeline()
        PIPELINE_ENABLED = True
        log("SYSTEM", logging.INFO, "[1231] Multi-LLM pipeline ENABLED. Model: %s" % _pipeline.get_current_model())
    except ImportError:
        log("SYSTEM", logging.INFO, "[1231] bruce_pipeline.py not found - single-model mode")
    except Exception as exc:
        log("SYSTEM", logging.WARNING, "[1231] Pipeline init failed: %s" % exc)


# ── [1036] Dynamic context from gateway ──
GATEWAY_CONTEXT_URL = "http://192.168.2.230:4000/bruce/screensaver/context"
GATEWAY_CONTEXT_HEADERS = {"Authorization": "Bearer bruce-secret-token-01", "Content-Type": "application/json"}
_context_cache = {}
_context_cache_ts = {}
CONTEXT_CACHE_TTL = 300  # 5 min cache


def fetch_dynamic_context(job_type: str) -> str:
    """Fetch dynamic context from gateway for screensaver prompts. Cached 5 min."""
    import time as _time
    now = _time.time()
    if job_type in _context_cache and (now - _context_cache_ts.get(job_type, 0)) < CONTEXT_CACHE_TTL:
        return _context_cache[job_type]
    try:
        resp = HTTP.post(GATEWAY_CONTEXT_URL, json={"job_type": job_type}, headers=GATEWAY_CONTEXT_HEADERS, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            ctx = data.get("context", "")
            _context_cache[job_type] = ctx
            _context_cache_ts[job_type] = now
            log("SYSTEM", logging.INFO, f"Dynamic context fetched for {job_type}: {len(ctx)} chars")
            return ctx
        else:
            log("SYSTEM", logging.WARNING, f"Context endpoint returned {resp.status_code}")
    except Exception as e:
        log("SYSTEM", logging.WARNING, f"Context fetch failed: {e}")
    return _context_cache.get(job_type, "ERREUR: Contexte dynamique non disponible.")

STATE: Dict[str, Any] = {}
LOCK_ACQUIRED = False


def ensure_dirs() -> None:
    os.makedirs(CONFIG["paths"]["logs_dir"], exist_ok=True)
    os.makedirs(CONFIG["paths"]["raw_llm_dir"], exist_ok=True)
    os.makedirs(CONFIG["paths"]["inbox_done_dir"], exist_ok=True)
    os.makedirs(CONFIG["paths"]["inbox_rejected_dir"], exist_ok=True)


def setup_logging() -> None:
    ensure_dirs()
    LOGGER.setLevel(logging.INFO)
    LOGGER.handlers.clear()

    fmt = logging.Formatter("[%(asctime)s] [%(job)s] %(message)s", datefmt="%H:%M:%S")

    class JobFilter(logging.Filter):
        def filter(self, record):
            if not hasattr(record, "job"):
                record.job = "SYSTEM"
            return True

    fh = RotatingFileHandler(
        CONFIG["paths"]["log_file"],
        maxBytes=5 * 1024 * 1024,
        backupCount=3,
    )
    fh.setFormatter(fmt)
    fh.addFilter(JobFilter())

    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    sh.addFilter(JobFilter())

    LOGGER.addHandler(fh)
    LOGGER.addHandler(sh)


def log(job: str, level: int, message: str) -> None:
    LOGGER.log(level, message, extra={"job": job})


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
        STATE["jobs"][job] = {
            "failures": 0,
            "disabled_until": 0,
            "last_error": None,
            "last_failure_ts": 0,
        }
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


def request_with_retry(
    method: str,
    url: str,
    job: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    params: Optional[Dict[str, Any]] = None,
    json_body: Optional[Any] = None,
    data: Optional[Any] = None,
    timeout: Optional[int] = None,
) -> Optional[requests.Response]:
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
            log(job, logging.WARNING, f"{method} {url} status={resp.status_code} attempt={i+1}")
        except Exception as exc:
            log(job, logging.WARNING, f"{method} {url} exception={exc} attempt={i+1}")

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
        candidate = raw[start:end + 1]
        try:
            return json.loads(candidate)
        except Exception:
            pass

    log(job, logging.ERROR, "Invalid JSON from LLM")
    save_raw_llm(job, raw)
    return None


def _get_current_model() -> str:
    """Return the current LLM model name."""
    if PIPELINE_ENABLED and _pipeline is not None:
        return _pipeline.get_current_model()
    return CONFIG["litellm"]["model"]


def audit_log(job: str, item_type: str, item_id: int, action: str,
              old_values: Optional[Dict] = None,
              new_values: Optional[Dict] = None) -> None:
    """[1044] Insert an entry into screensaver_audit_log before any modification."""
    payload = {
        "item_type": item_type,
        "item_id": item_id,
        "action": action,
        "old_values": json.dumps(old_values, ensure_ascii=False) if old_values else None,
        "new_values": json.dumps(new_values, ensure_ascii=False) if new_values else None,
        "llm_model": _get_current_model(),
        "job_type": job,
        "script_version": VERSION,
    }
    url = f"{CONFIG['supabase']['base_url']}/screensaver_audit_log"
    resp = request_with_retry(
        "POST", url, job,
        headers=supabase_headers({"Prefer": "return=representation"}),
        json_body=payload,
    )
    if not resp:
        log(job, logging.WARNING, f"[1044] audit_log INSERT failed: {item_type} id={item_id} action={action}")
    else:
        log(job, logging.INFO, f"[1044] audit_log: {item_type} id={item_id} action={action}")


def _robust_parse_kb_reviews(job: str, raw: str) -> Optional[Dict]:
    """[1045] Robust JSON parser for kb_audit with regex fallback."""
    # Standard parse first
    parsed = parse_llm_json(job, raw)
    if parsed and isinstance(parsed, dict) and "reviews" in parsed:
        return parsed

    log(job, logging.WARNING,
        f"[1045] Standard JSON parse failed, trying regex fallback. "
        f"Raw text ({len(raw)} chars): {raw[:500]}")

    # Regex fallback: extract individual review objects
    try:
        pattern = r'\{[^{}]*"id"\s*:\s*\d+[^{}]*"verdict"\s*:\s*"(?:keep|archive|update)"[^{}]*\}'
        reviews = []
        for m in re.finditer(pattern, raw):
            try:
                obj = json.loads(m.group())
                reviews.append(obj)
            except json.JSONDecodeError:
                continue
        if reviews:
            log(job, logging.WARNING,
                f"[1045] Regex fallback recovered {len(reviews)} reviews")
            return {"reviews": reviews}
    except Exception as exc:
        log(job, logging.WARNING, f"[1045] Regex fallback error: {exc}")

    return None

# -- [1104] Quality validation: protect canonical/recent lessons (Session 1242) --
import datetime as _dt


def _lesson_protected(lesson_row: dict, verdict: str) -> str:
    """[1104] Check if a lesson is protected from archive/downgrade.
    Returns empty string if OK to proceed, or a reason string to skip."""
    if verdict not in ("archive", "downgrade"):
        return ""
    # Check canonical_lock
    if lesson_row.get("canonical_lock") is True:
        return f"canonical_lock=true for lesson id={lesson_row.get('id')}"
    # Check if created in last 24h
    created_at = lesson_row.get("created_at")
    if created_at:
        try:
            if isinstance(created_at, str):
                created = _dt.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            else:
                created = created_at
            now = _dt.datetime.now(_dt.timezone.utc)
            if (now - created).total_seconds() < 86400:
                return f"lesson id={lesson_row.get('id')} created <24h ago ({created_at})"
        except Exception:
            pass  # If we can't parse, don't block
    return ""


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
        # [1054] Fix: slot_busy=None means status unknown - treat as idle
        raw_busy = payload.get("llama_server", {}).get("slot_busy")
        if raw_busy is None:
            log("LLM", logging.WARNING, "[1054] slot_busy=None - treating as idle")
            return True
        busy = bool(raw_busy)
        log("LLM", logging.INFO, f"slot_busy={busy}")
        return not busy
    except Exception as exc:
        log("LLM", logging.WARNING, f"Invalid LLM status JSON: {exc}")
        return False


def llm_call(job: str, prompt: str, max_tokens: int, context: Optional[str] = None) -> Optional[Any]:
    if not prompt.startswith("/no_think"):
        log(job, logging.ERROR, "Prompt missing /no_think")
        return None
    # [1231] Pipeline path
    if PIPELINE_ENABLED and _pipeline is not None:
        started = time.time()
        log(job, logging.INFO, f"[PIPELINE] Routing task_type={job} prompt_len={len(prompt)}")
        result = _pipeline.execute(job, prompt, max_tokens=max_tokens, context=context)
        elapsed = round(time.time() - started, 2)
        if result is not None:
            log(job, logging.INFO, f"[PIPELINE] Success model={_pipeline.get_current_model()} elapsed={elapsed}s")
        else:
            log(job, logging.ERROR, f"[PIPELINE] Failed after {elapsed}s")
        return result
    # Original direct-call path (fallback)
    started = time.time()
    payload = {
        "model": CONFIG["litellm"]["model"],
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": CONFIG["litellm"]["temperature"],
        "reasoning_format": "none",
    }
    log(job, logging.INFO, f"LLM call prompt_len={len(prompt)} max_tokens={max_tokens}")
    resp = request_with_retry(
        "POST", CONFIG["litellm"]["url"], job,
        headers=CONFIG["litellm"]["headers"], json_body=payload,
        timeout=CONFIG["timeouts"]["llm"],
    )
    if not resp:
        log(job, logging.ERROR, "LLM call failed after retries")
        return None
    elapsed = round(time.time() - started, 2)
    try:
        raw = resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:
        log(job, logging.ERROR, f"Failed parsing LLM envelope: {exc}")
        save_raw_llm(job, resp.text[:20000])
        return None
    global _last_llm_raw
    _last_llm_raw = raw
    parsed = parse_llm_json(job, raw)
    if parsed is None:
        log(job, logging.ERROR, f"LLM JSON parse failed elapsed={elapsed}s")
        return None
    log(job, logging.INFO, f"LLM success elapsed={elapsed}s")
    return parsed


def supabase_headers(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    key = CONFIG["supabase"]["service_key"]
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def supabase_get(job: str, table: str, params: Dict[str, Any]) -> Optional[List[Dict[str, Any]]]:
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


def supabase_patch(job: str, table: str, match: Dict[str, Any], patch: Dict[str, Any]) -> bool:
    url = f"{CONFIG['supabase']['base_url']}/{table}"
    params = {k: f"eq.{v}" for k, v in match.items()}
    headers = supabase_headers({"Prefer": "return=representation"})

    resp = request_with_retry(
        "PATCH",
        url,
        job,
        headers=headers,
        params=params,
        json_body=patch,
    )
    if not resp:
        log(job, logging.ERROR, f"PATCH failed table={table} match={match}")
        return False

    # Verify that PATCH actually modified rows
    try:
        data = resp.json()
        if not isinstance(data, list) or len(data) == 0:
            log(job, logging.WARNING, f"PATCH returned 0 rows table={table} match={match} — no row modified")
            return False
    except Exception as exc:
        log(job, logging.ERROR, f"PATCH response parse error table={table}: {exc}")
        return False

    return True


def bruce_write(job: str, payload: Dict[str, Any]) -> bool:
    resp = request_with_retry(
        "POST",
        CONFIG["bruce_write"]["url"],
        job,
        headers=CONFIG["bruce_write"]["headers"],
        json_body=payload,
    )
    if not resp:
        log(job, logging.ERROR, "BRUCE write failed")
        return False
    return True


def get_embeddings(job: str, texts: List[str]) -> Optional[List[List[float]]]:
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


def cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
    a = np.array(vec_a, dtype=np.float32)
    b = np.array(vec_b, dtype=np.float32)
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0.0:
        return 0.0
    return float(np.dot(a, b) / denom)


def chunk_text(text: str, chunk_chars: int) -> List[str]:
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
                    chunks.append(part[i:i + chunk_chars])
                current = ""
    if current:
        chunks.append(current)
    return chunks


def format_lessons_batch(rows: List[Dict[str, Any]]) -> str:
    return json.dumps(rows, ensure_ascii=False, indent=2)


def format_kb_batch(rows: List[Dict[str, Any]]) -> str:
    return json.dumps(rows, ensure_ascii=False, indent=2)


def lightrag_login(job: str) -> Optional[str]:
    resp = request_with_retry(
        "POST",
        CONFIG["lightrag"]["login_url"],
        job,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "username": CONFIG["lightrag"]["username"],
            "password": CONFIG["lightrag"]["password"],
        },
        timeout=CONFIG["timeouts"]["lightrag"],
    )
    if not resp:
        return None
    try:
        return resp.json().get("access_token")
    except Exception as exc:
        log(job, logging.ERROR, f"LightRAG login parse error: {exc}")
        return None


def lightrag_pipeline_busy(job: str, token: str) -> Optional[bool]:
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


def lightrag_insert(job: str, token: str, text: str, file_source: str) -> bool:
    resp = request_with_retry(
        "POST",
        CONFIG["lightrag"]["insert_url"],
        job,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json_body={"text": text, "file_source": file_source},
        timeout=CONFIG["timeouts"]["lightrag"],
    )
    if not resp:
        log(job, logging.ERROR, "LightRAG insert failed")
        return False
    metric_inc("lightrag_inserts")
    return True


def job_lesson_review() -> str:
    job = "lesson_review"
    if job_disabled(job):
        return "empty"
    if not _model_sufficient_for_job(job):
        return "empty"
    if not check_idle():
        return "busy"

    params = {
            "select": "id,lesson_type,lesson_text,importance,created_at,canonical_lock",
            "archived": "eq.false",
            "lesson_type": "neq.rule_canon",
            "author_system": f"neq.{CONFIG['author_system']}",
            "order": "created_at.asc",
            "limit": CONFIG["batch_sizes"]["lesson_review"],
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
        # Reset offset if we ran out of rows
        STATE.setdefault("skip_offset", {})[job] = 0
        save_state()
        job_success(job)
        return "empty"

    if not check_idle():
        return "busy"

    rows_by_id = {r["id"]: r for r in rows}
    ctx = fetch_dynamic_context("lesson_review")
    result = llm_call(job, PROMPTS["lesson_review"].replace("{dynamic_context}", ctx).replace("{batch}", format_lessons_batch(rows)), 1200, context=ctx)
    if not result or "reviews" not in result:
        STATE.setdefault("skip_offset", {})[job] = STATE.get("skip_offset", {}).get(job, 0) + CONFIG["batch_sizes"]["lesson_review"]
        log(job, logging.WARNING, f"Skip offset now {STATE['skip_offset'][job]}")
        save_state()
        job_failure(job, "invalid review payload")
        return "error"

    processed = []
    batch_kept = 0
    batch_modified = 0
    batch_errored = 0
    for review in result.get("reviews", []):
        lesson_id = review.get("id")
        verdict = review.get("verdict")

        # [1040] Skip PATCH entirely for keep items with no changes
        has_importance_change = bool(review.get("new_importance"))
        has_text_change = bool(review.get("improved_text"))
        if verdict == "keep" and not has_importance_change and not has_text_change:
            # [1044] Audit log for keep
            audit_log(job, "lesson", lesson_id, "keep",
                      old_values=rows_by_id.get(lesson_id), new_values=None)
            log(job, logging.INFO, f"KEEP id={lesson_id}, no action")
            processed.append({"id": lesson_id, "verdict": "keep", "ok": True})
            batch_kept += 1
            continue

        # [1104] Quality validation: protect canonical/recent lessons
        protection_reason = _lesson_protected(rows_by_id.get(lesson_id, {}), verdict)
        if protection_reason:
            log(job, logging.WARNING,
                f"[1104] Protection: {protection_reason} -- skipping {verdict}")
            audit_log(job, "lesson", lesson_id, f"protected_{verdict}",
                      old_values=rows_by_id.get(lesson_id),
                      new_values={"blocked_reason": protection_reason})
            processed.append({"id": lesson_id, "verdict": f"protected_{verdict}", "ok": True})
            batch_kept += 1
            continue

        patch: Dict[str, Any] = {"author_system": CONFIG["author_system"]}

        if verdict == "archive":
            patch["archived"] = True
            metric_inc("items_archived")
        elif verdict in ("keep", "upgrade", "downgrade"):
            if has_importance_change:
                patch["importance"] = review["new_importance"]

        if has_text_change:
            patch["lesson_text"] = review["improved_text"]
            patch["content_hash"] = hash_text(review["improved_text"])

        # [1044] Audit log before PATCH
        audit_log(job, "lesson", lesson_id, verdict,
                  old_values=rows_by_id.get(lesson_id), new_values=patch)
        ok = supabase_patch(job, "lessons_learned", {"id": lesson_id}, patch)
        processed.append({"id": lesson_id, "verdict": verdict, "ok": ok})
        if ok:
            metric_inc("items_updated")
            batch_modified += 1
        else:
            batch_errored += 1

    metric_inc("batches")
    items_processed = len(processed)
    log(job, logging.INFO, f"Batch summary: processed={items_processed} modified={batch_modified} kept={batch_kept} errored={batch_errored}")
    log(job, logging.INFO, f"Processed lesson batch={processed}")
    STATE.setdefault("skip_offset", {})[job] = 0
    save_state()
    job_success(job)
    return "done"


def job_kb_audit() -> str:
    job = "kb_audit"
    if job_disabled(job):
        return "empty"
    if not _model_sufficient_for_job(job):
        return "empty"
    if not check_idle():
        return "busy"

    rows = supabase_get(
        job,
        "knowledge_base",
        {
            "select": "id,question,answer,category,subcategory,tags,created_at",
            "archived": "eq.false",
            "author_system": f"neq.{CONFIG['author_system']}",
            "order": "created_at.asc",
            "limit": CONFIG["batch_sizes"]["kb_audit"],
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

    rows_by_id = {r["id"]: r for r in rows}
    ctx = fetch_dynamic_context("kb_audit")
    prompt = PROMPTS["kb_audit"].replace("{dynamic_context}", ctx).replace("{batch}", format_kb_batch(rows))
    result = llm_call(job, prompt, 800, context=ctx)

    # [1045] Robust parsing with regex fallback and retry
    if not result or "reviews" not in result:
        # Try regex recovery on raw LLM output
        if _last_llm_raw:
            log(job, logging.WARNING, "[1045] Attempting regex recovery on raw LLM output")
            result = _robust_parse_kb_reviews(job, _last_llm_raw)

        # Retry once with shorter prompt (half the batch)
        if not result or "reviews" not in result:
            short_rows = rows[:max(1, len(rows) // 2)]
            if len(short_rows) < len(rows):
                log(job, logging.WARNING,
                    f"[1045] Retrying kb_audit with shorter batch: {len(short_rows)}/{len(rows)} items")
                short_prompt = PROMPTS["kb_audit"].replace("{dynamic_context}", ctx).replace("{batch}", format_kb_batch(short_rows))
                result = llm_call(job, short_prompt, 800, context=ctx)
                if result and "reviews" in result:
                    rows = short_rows
                    rows_by_id = {r["id"]: r for r in rows}
                elif _last_llm_raw:
                    result = _robust_parse_kb_reviews(job, _last_llm_raw)

        if not result or "reviews" not in result:
            job_failure(job, "invalid kb audit payload after retry")
            return "error"

    processed = []
    batch_kept = 0
    batch_modified = 0
    batch_errored = 0
    for review in result.get("reviews", []):
        entry_id = review.get("id")
        verdict = review.get("verdict")

        # [1040] Skip PATCH entirely for keep items with no changes
        has_text_change = bool(review.get("improved_text"))
        if verdict == "keep" and not has_text_change:
            # [1044] Audit log for keep
            audit_log(job, "kb", entry_id, "keep",
                      old_values=rows_by_id.get(entry_id), new_values=None)
            log(job, logging.INFO, f"KEEP id={entry_id}, no action")
            processed.append({"id": entry_id, "verdict": "keep", "ok": True})
            batch_kept += 1
            continue

        patch: Dict[str, Any] = {"author_system": CONFIG["author_system"]}

        if verdict == "archive":
            patch["archived"] = True
            metric_inc("items_archived")
        elif verdict == "update" and has_text_change:
            patch["answer"] = review["improved_text"]
            patch["content_hash"] = hash_text(review["improved_text"])

        # [1044] Audit log before PATCH
        audit_log(job, "kb", entry_id, verdict,
                  old_values=rows_by_id.get(entry_id), new_values=patch)
        ok = supabase_patch(job, "knowledge_base", {"id": entry_id}, patch)
        processed.append({"id": entry_id, "verdict": verdict, "ok": ok})
        if ok:
            metric_inc("items_updated")
            batch_modified += 1
        else:
            batch_errored += 1

    metric_inc("batches")
    items_processed = len(processed)
    log(job, logging.INFO, f"Batch summary: processed={items_processed} modified={batch_modified} kept={batch_kept} errored={batch_errored}")
    log(job, logging.INFO, f"Processed KB batch={processed}")
    job_success(job)
    return "done"


def job_dedup() -> str:
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
            result = llm_call(
                job,
                PROMPTS["dedup"].format(
                    id_a=a["id"],
                    text_a=a["lesson_text"],
                    id_b=b["id"],
                    text_b=b["lesson_text"],
                ),
                400,
            )
            if not result:
                job_failure(job, "invalid dedup payload")
                return "error"

            if result.get("is_duplicate") is True:
                archive_id = result.get("archive_id")
                keep_id = result.get("keep_id")
                ok = supabase_patch(job, "lessons_learned", {"id": archive_id}, {"archived": True})
                log(job, logging.INFO, f"Duplicate keep={keep_id} archive={archive_id} ok={ok}")
                if ok:
                    metric_inc("duplicates_archived")
                    metric_inc("items_archived")

        STATE["dedup_last_id"] = b["id"]
        save_state()
        did_work = True

    job_success(job)
    return "done" if did_work else "empty"


def job_lightrag() -> str:
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


def list_inbox_files() -> List[str]:
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


def read_text_file(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception as exc:
        log("ingestion", logging.ERROR, f"Failed reading {path}: {exc}")
        return None


def move_to_rejected(path: str, reason: str) -> None:
    dst = os.path.join(CONFIG["paths"]["inbox_rejected_dir"], os.path.basename(path))
    try:
        shutil.move(path, dst)
        log("ingestion", logging.WARNING, f"Moved file to rejected path={dst} reason={reason}")
    except Exception as exc:
        log("ingestion", logging.ERROR, f"Failed moving rejected file {path}: {exc}")


def move_to_done(path: str) -> bool:
    dst = os.path.join(CONFIG["paths"]["inbox_done_dir"], os.path.basename(path))
    try:
        shutil.move(path, dst)
        log("ingestion", logging.INFO, f"Moved file to done path={dst}")
        return True
    except Exception as exc:
        log("ingestion", logging.ERROR, f"Failed moving file to done {path}: {exc}")
        return False


def post_ingested_data(job: str, extracted: Dict[str, Any], source_file: str) -> int:
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


def job_ingestion() -> str:
    job = "ingestion"
    if job_disabled(job):
        return "empty"
    if not _model_sufficient_for_job(job):
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
        extracted = llm_call(job, prompt, 2200)
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
        log(job, logging.INFO, f"Ingested path={path} chunk={chunk_index+1}/{len(chunks)} created={created}")

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


def job_session_summary() -> str:
    job = "session_summary"
    if job_disabled(job):
        return "empty"
    if not _model_sufficient_for_job(job):
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

    result = llm_call(
        job,
        PROMPTS["session_summary"].replace("{lessons}", json.dumps(lessons, ensure_ascii=False, indent=2)),
        500,
    )
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


def startup_log() -> None:
    log("SYSTEM", logging.INFO, f"Starting {VERSION}")
    log("SYSTEM", logging.INFO, f"Cursors dedup={STATE.get('dedup_last_id', 0)} "
                                f"lightrag_lessons={STATE.get('lightrag_lessons_last_id', 0)} "
                                f"lightrag_kb={STATE.get('lightrag_kb_last_id', 0)}")
    log("SYSTEM", logging.INFO, f"Metrics={STATE.get('metrics', {})}")


def heartbeat() -> None:
    metrics = STATE.get("metrics", {})
    log("SYSTEM", logging.INFO, f"Heartbeat metrics={metrics}")
    if PIPELINE_ENABLED and _pipeline is not None:
        stats = _pipeline.get_stats()
        log("SYSTEM", logging.INFO, f"[PIPELINE] model={stats.get('current_model')} swaps={stats.get('swap_count',0)} avoided={stats.get('swaps_avoided',0)} tasks={stats.get('total_tasks_processed',0)}")


def run_cycle() -> str:
    metric_inc("cycles")
    if STATE["metrics"]["cycles"] % CONFIG["heartbeat_every_cycles"] == 0:
        heartbeat()
    if not check_idle():
        log("SYSTEM", logging.INFO, "LLM busy at cycle start")
        return "busy"
    # [1231] Pipeline-aware: run jobs matching current model first
    if PIPELINE_ENABLED and _pipeline is not None:
        current_model_jobs = set(_pipeline.get_jobs_for_current_model())
        current_model = _pipeline.get_current_model()
        log("SYSTEM", logging.INFO, f"[PIPELINE] model={current_model}, optimal_jobs={current_model_jobs}")
        remaining_jobs = []
        for job_name, job_fn in JOBS:
            if job_name in current_model_jobs:
                log("SYSTEM", logging.INFO, f"[PIPELINE] {job_name} (current model)")
                try:
                    result = job_fn()
                    log("SYSTEM", logging.INFO, f"Job={job_name} result={result}")
                    if result == "done":
                        return "done"
                    if result == "busy":
                        return "busy"
                except Exception as exc:
                    log(job_name, logging.ERROR, f"Unhandled exception: {exc}")
                    job_failure(job_name, str(exc))
            else:
                remaining_jobs.append((job_name, job_fn))
        for job_name, job_fn in remaining_jobs:
            log("SYSTEM", logging.INFO, f"[PIPELINE] {job_name} (may swap)")
            try:
                result = job_fn()
                log("SYSTEM", logging.INFO, f"Job={job_name} result={result}")
                if result == "done":
                    return "done"
                if result == "busy":
                    return "busy"
            except Exception as exc:
                log(job_name, logging.ERROR, f"Unhandled exception: {exc}")
                job_failure(job_name, str(exc))
        return "empty"
    # Original path (pipeline unavailable)
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


def main_loop() -> None:
    busy_backoff = CONFIG["sleep"]["busy_retry"]  # [1039] starts at base 60s
    while True:
        # [1242] Stop-flag: if file exists, exit gracefully
        if os.path.exists(CONFIG["paths"]["stop_flag_file"]):
            log("SYSTEM", logging.WARNING,
                "[1242] Stop flag detected — exiting gracefully")
            try:
                os.remove(CONFIG["paths"]["stop_flag_file"])
            except OSError:
                pass
            release_lock()
            sys.exit(0)
        result = run_cycle()
        if result == "done":
            if busy_backoff != CONFIG["sleep"]["busy_retry"]:
                log("SYSTEM", logging.INFO,
                    f"[1039] Backoff reset (was {busy_backoff}s) — LLM available, work done")
            busy_backoff = CONFIG["sleep"]["busy_retry"]  # [1039] reset on success
            jitter_sleep(CONFIG["sleep"]["work_done"], CONFIG["sleep"]["work_jitter"])
            continue

        if check_idle():
            if busy_backoff != CONFIG["sleep"]["busy_retry"]:
                log("SYSTEM", logging.INFO,
                    f"[1039] Backoff reset (was {busy_backoff}s) — LLM idle, queues empty")
            busy_backoff = CONFIG["sleep"]["busy_retry"]  # [1039] reset when idle
            jitter_sleep(CONFIG["sleep"]["all_empty"], CONFIG["sleep"]["empty_jitter"])
        else:
            # [1039] Exponential backoff when LLM is busy
            log("SYSTEM", logging.INFO,
                f"[1039] LLM busy — sleeping {busy_backoff}s (base={CONFIG['sleep']['busy_retry']}s, max={CONFIG['sleep']['busy_backoff_max']}s)")
            jitter_sleep(busy_backoff, CONFIG["sleep"]["busy_jitter"])
            busy_backoff = min(
                busy_backoff * CONFIG["sleep"]["busy_backoff_multiplier"],
                CONFIG["sleep"]["busy_backoff_max"],
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="BRUCE multi-job LLM screensaver")
    parser.add_argument("--loop", action="store_true", help="Run forever")
    parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
    parser.add_argument(
        "--test-job",
        choices=[name for name, _ in JOBS],
        help="Run only one job once and exit",
    )
    return parser.parse_args()


def main() -> int:
    setup_logging()
    load_state()
    acquire_lock()

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGHUP, shutdown_handler)

    _init_pipeline()  # [1231] Multi-LLM pipeline
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

    print("Use --loop, --once, or --test-job <name>")
    release_lock()
    return 1


if __name__ == "__main__":
    sys.exit(main())
