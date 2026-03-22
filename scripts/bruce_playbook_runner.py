#!/usr/bin/env python3
"""
bruce_playbook_runner.py v1.0
Runner autonome de playbooks YAML pour BRUCE homelab.
Charge un playbook, évalue les triggers/conditions, exécute les steps.

Usage:
    python3 bruce_playbook_runner.py --playbook playbooks/kb_health.yaml --once
    python3 bruce_playbook_runner.py --all --loop
    python3 bruce_playbook_runner.py --list
"""

from __future__ import annotations

import argparse
import glob
import json
import logging
import os
import re
import signal
import sys
import time
from datetime import datetime, timedelta, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests
import yaml

# ── Constants ────────────────────────────────────────────────────────

VERSION = "1.0"
BASE_DIR = Path(__file__).resolve().parent
PLAYBOOKS_DIR = BASE_DIR / "playbooks" if (BASE_DIR / "playbooks").is_dir() else BASE_DIR
LOG_DIR = Path("/home/furycom/logs")
LOG_FILE = LOG_DIR / "playbook_runner.log"
STATE_FILE = LOG_DIR / "playbook_runner_state.json"

SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
GATEWAY_TOKEN = os.environ.get("BRUCE_GATEWAY_TOKEN", "bruce-secret-token-01")

SHUTDOWN = False

# ── Logging ──────────────────────────────────────────────────────────

logger = logging.getLogger("playbook_runner")


def setup_logging() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(str(LOG_FILE), maxBytes=5 * 1024 * 1024, backupCount=3)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    logger.addHandler(handler)
    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S"))
    logger.addHandler(console)
    logger.setLevel(logging.INFO)


# ── State Management ─────────────────────────────────────────────────

STATE: Dict[str, Any] = {"runs": {}, "last_trigger": {}}


def load_state() -> None:
    global STATE
    if STATE_FILE.exists():
        try:
            STATE = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed loading state: %s", exc)


def save_state() -> None:
    try:
        STATE_FILE.write_text(json.dumps(STATE, indent=2, default=str), encoding="utf-8")
    except Exception as exc:
        logger.error("Failed saving state: %s", exc)


# ── Helpers ──────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def days_since(datestr: Optional[str]) -> float:
    if not datestr:
        return 9999.0
    try:
        dt = datetime.fromisoformat(datestr.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).total_seconds() / 86400
    except Exception:
        return 9999.0


def count_by(items: list, field: str, value: str) -> int:
    return sum(1 for item in items if isinstance(item, dict) and item.get(field) == value)


def supabase_headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
    }


def safe_request(method: str, url: str, **kwargs) -> Optional[requests.Response]:
    timeout = kwargs.pop("timeout", 30)
    try:
        resp = requests.request(method, url, timeout=timeout, **kwargs)
        resp.raise_for_status()
        return resp
    except requests.RequestException as exc:
        logger.error("HTTP %s %s failed: %s", method, url, exc)
        return None


def resolve_template(template: str, ctx: Dict[str, Any]) -> str:
    """Minimal Jinja-like template resolution for {{ var }} patterns."""
    def replacer(match):
        expr = match.group(1).strip()
        try:
            return str(eval(expr, {"__builtins__": {}}, ctx))  # noqa: S307
        except Exception:
            return match.group(0)
    return re.sub(r"\{\{(.+?)\}\}", replacer, template)


def resolve_value(value: Any, ctx: Dict[str, Any]) -> Any:
    """Recursively resolve templates in strings, dicts, and lists."""
    if isinstance(value, str) and "{{" in value:
        resolved = resolve_template(value, ctx)
        # Try to parse as JSON if it looks like a structure
        if resolved.startswith(("{", "[")):
            try:
                return json.loads(resolved)
            except (json.JSONDecodeError, ValueError):
                pass
        return resolved
    if isinstance(value, dict):
        return {k: resolve_value(v, ctx) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_value(item, ctx) for item in value]
    return value


# ── Playbook Loader ──────────────────────────────────────────────────

class Playbook:
    """Parsed playbook from YAML."""

    def __init__(self, path: str):
        self.path = path
        self.raw: Dict[str, Any] = {}
        self.name = ""
        self.version = ""
        self.description = ""
        self.trigger: Dict[str, Any] = {}
        self.context: Dict[str, Any] = {}
        self.steps: List[Dict[str, Any]] = []
        self.success_criteria: List[Dict[str, Any]] = []
        self.fallback: Dict[str, Any] = {}
        self._load()

    def _load(self) -> None:
        with open(self.path, "r", encoding="utf-8") as f:
            self.raw = yaml.safe_load(f)
        self.name = self.raw.get("name", Path(self.path).stem)
        self.version = str(self.raw.get("version", "0.0"))
        self.description = self.raw.get("description", "")
        self.trigger = self.raw.get("trigger", {})
        self.context = self.raw.get("context", {})
        self.steps = self.raw.get("steps", [])
        self.success_criteria = self.raw.get("success_criteria", [])
        self.fallback = self.raw.get("fallback", {})

    def __repr__(self) -> str:
        return f"Playbook({self.name} v{self.version}, {len(self.steps)} steps)"


# ── Action Executors ─────────────────────────────────────────────────

class PlaybookRunner:
    """Executes a single playbook's steps with context tracking."""

    def __init__(self, playbook: Playbook):
        self.pb = playbook
        self.ctx: Dict[str, Any] = {
            "context": dict(playbook.context),
            "now_iso": now_iso(),
            "today_iso": today_iso(),
            "len": len,
            "count_by": count_by,
            "days_since": days_since,
            "json_dumps": lambda x: json.dumps(x, ensure_ascii=False, indent=2),
        }
        self.errors: List[str] = []
        self.completed_steps: List[str] = []

    def check_trigger(self) -> bool:
        """Evaluate whether the playbook should run now."""
        trigger = self.pb.trigger
        trigger_type = trigger.get("type", "manual")

        if trigger_type == "manual":
            return True

        if trigger_type == "cron":
            # In loop mode, cron is handled by the scheduler wrapper.
            # For --once, always run.
            return True

        if trigger_type == "polling":
            condition = trigger.get("condition", {})
            cond_type = condition.get("type", "")

            if cond_type == "supabase_count":
                table = condition.get("table", "")
                filters = condition.get("filters", {})
                min_count = condition.get("min_count", 1)
                url = f"{self.pb.context.get('supabase_url', '')}/{table}"
                params = {k: v for k, v in filters.items()}
                params["select"] = "id"
                params["limit"] = str(min_count)
                resp = safe_request("GET", url, headers=supabase_headers(), params=params)
                if resp is None:
                    return False
                try:
                    data = resp.json()
                    return isinstance(data, list) and len(data) >= min_count
                except Exception:
                    return False

            if cond_type == "directory_watch":
                path = condition.get("path", "")
                patterns = condition.get("pattern", "*").split(",")
                min_files = condition.get("min_files", 1)
                count = 0
                for pattern in patterns:
                    count += len(glob.glob(os.path.join(path, pattern.strip())))
                return count >= min_files

        return True

    def run(self) -> Dict[str, Any]:
        """Execute all steps in sequence. Returns a result dict."""
        logger.info("▶ Running playbook: %s v%s", self.pb.name, self.pb.version)
        start = time.time()

        for step in self.pb.steps:
            if SHUTDOWN:
                logger.warning("Shutdown requested, aborting playbook %s", self.pb.name)
                break
            result = self._execute_step(step)
            if result == "exit_ok":
                logger.info("⏹ Playbook %s: early exit (OK)", self.pb.name)
                break
            if result == "exit_error":
                logger.error("⏹ Playbook %s: early exit (ERROR)", self.pb.name)
                break

        elapsed = round(time.time() - start, 2)
        success = len(self.errors) == 0
        status = "success" if success else "partial_failure"

        # Record run in state
        STATE.setdefault("runs", {})[self.pb.name] = {
            "last_run": now_iso(),
            "status": status,
            "elapsed_seconds": elapsed,
            "steps_completed": len(self.completed_steps),
            "errors": self.errors[-5:],  # Keep last 5 errors
        }
        save_state()

        logger.info(
            "✅ Playbook %s finished: status=%s elapsed=%.1fs steps=%d errors=%d",
            self.pb.name, status, elapsed, len(self.completed_steps), len(self.errors),
        )
        return {"playbook": self.pb.name, "status": status, "elapsed": elapsed, "errors": self.errors}

    def _execute_step(self, step: Dict[str, Any]) -> Optional[str]:
        """Execute a single step. Returns 'exit_ok', 'exit_error', or None to continue."""
        step_id = step.get("id", "unnamed")
        action = step.get("action", "")
        logger.info("  → Step: %s (action=%s)", step_id, action)

        try:
            handler = getattr(self, f"_action_{action}", None)
            if handler is None:
                logger.warning("  Unknown action '%s' in step %s — skipping", action, step_id)
                return None

            result = handler(step)
            self.completed_steps.append(step_id)

            # Store output in context
            output_key = step.get("output")
            if output_key and result is not None:
                self.ctx[output_key] = result

            return None

        except GuardExit as ge:
            return str(ge)
        except Exception as exc:
            error_msg = f"Step {step_id} failed: {exc}"
            logger.error("  ✗ %s", error_msg)
            self.errors.append(error_msg)

            on_error = step.get("on_error", self.pb.fallback.get("on_error", "log_and_continue"))
            if on_error == "exit_error":
                return "exit_error"
            if on_error == "retry":
                return self._retry_step(step)
            return None  # log_and_continue / log_and_skip

    def _retry_step(self, step: Dict[str, Any]) -> Optional[str]:
        max_retries = self.pb.fallback.get("max_retries", 2)
        delay = self.pb.fallback.get("retry_delay_seconds", 30)
        for attempt in range(1, max_retries + 1):
            logger.info("  ↻ Retry %d/%d for step %s", attempt, max_retries, step.get("id"))
            time.sleep(delay)
            try:
                handler = getattr(self, f"_action_{step.get('action')}")
                result = handler(step)
                output_key = step.get("output")
                if output_key and result is not None:
                    self.ctx[output_key] = result
                self.completed_steps.append(step.get("id", "unnamed"))
                return None
            except Exception as exc:
                logger.error("  ✗ Retry %d failed: %s", attempt, exc)
        return "exit_error"

    # ── Action Implementations ───────────────────────────────────────

    def _action_supabase_get(self, step: Dict[str, Any]) -> Any:
        params = resolve_value(step.get("params", {}), self.ctx)
        table = params.pop("table")
        filters = params.pop("filters", {})
        query_params = dict(filters)
        for key in ("select", "order", "limit", "offset"):
            if key in params:
                query_params[key] = params[key]
        url = f"{self.pb.context.get('supabase_url', '')}/{table}"
        resp = safe_request("GET", url, headers=supabase_headers(), params=query_params)
        if resp is None:
            raise RuntimeError(f"Supabase GET {table} failed")
        return resp.json()

    def _action_supabase_patch(self, step: Dict[str, Any]) -> Any:
        params = resolve_value(step.get("params", {}), self.ctx)
        table = params["table"]
        match = params["match"]
        patch = params["patch"]
        url = f"{self.pb.context.get('supabase_url', '')}/{table}"
        query_params = {k: f"eq.{v}" for k, v in match.items()}
        headers = supabase_headers()
        headers["Prefer"] = "return=minimal"
        resp = safe_request("PATCH", url, headers=headers, params=query_params, json=patch)
        if resp is None:
            raise RuntimeError(f"Supabase PATCH {table} failed")
        return True

    def _action_supabase_insert(self, step: Dict[str, Any]) -> Any:
        params = resolve_value(step.get("params", {}), self.ctx)
        table = params["table"]
        payload = params["payload"]
        url = f"{self.pb.context.get('supabase_url', '')}/{table}"
        headers = supabase_headers()
        headers["Prefer"] = "return=minimal"
        resp = safe_request("POST", url, headers=headers, json=payload)
        if resp is None:
            raise RuntimeError(f"Supabase INSERT {table} failed")
        return True

    def _action_http_get(self, step: Dict[str, Any]) -> Any:
        params = resolve_value(step.get("params", {}), self.ctx)
        url = params["url"]
        headers = params.get("headers", {})
        resp = safe_request("GET", url, headers=headers)
        if resp is None:
            raise RuntimeError(f"HTTP GET {url} failed")
        return resp.json()

    def _action_http_post(self, step: Dict[str, Any]) -> Any:
        params = resolve_value(step.get("params", {}), self.ctx)
        url = params["url"]
        headers = params.get("headers", {})
        body = params.get("body", {})
        resp = safe_request("POST", url, headers=headers, json=body)
        if resp is None:
            raise RuntimeError(f"HTTP POST {url} failed")
        return resp.json()

    def _action_llm_call(self, step: Dict[str, Any]) -> Any:
        params = resolve_value(step.get("params", {}), self.ctx)
        url = params["url"]
        model = params.get("model", "alpha")
        prompt = params["prompt"]
        max_tokens = params.get("max_tokens", 500)

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.3,
            "reasoning_format": "none",
        }
        resp = safe_request("POST", url, json=payload, timeout=450)
        if resp is None:
            raise RuntimeError("LLM call failed")
        raw = resp.json()["choices"][0]["message"]["content"]
        # Parse JSON from LLM response
        # Try to find JSON in the response
        json_match = re.search(r"\{[\s\S]*\}", raw)
        if json_match:
            return json.loads(json_match.group())
        raise RuntimeError(f"LLM returned non-JSON: {raw[:200]}")

    def _action_guard(self, step: Dict[str, Any]) -> Any:
        params = resolve_value(step.get("params", {}), self.ctx)
        condition_str = resolve_template(step.get("condition", "True"), self.ctx)
        try:
            result = eval(condition_str, {"__builtins__": {}}, self.ctx)  # noqa: S307
        except Exception:
            result = False
        if not result:
            on_false = step.get("on_false", "continue")
            if on_false == "exit_ok":
                message = step.get("message", "Guard condition false")
                logger.info("  ⏭ Guard: %s", message)
                raise GuardExit("exit_ok")
            if on_false == "exit_error":
                raise GuardExit("exit_error")
            # Execute nested steps if present
            nested = step.get("steps", [])
            for ns in nested:
                self._execute_step(ns)
        return True

    def _action_filter(self, step: Dict[str, Any]) -> List:
        collection = resolve_value(step.get("collection", []), self.ctx)
        condition = step.get("condition", "True")
        results = []
        for item in (collection if isinstance(collection, list) else []):
            local_ctx = {**self.ctx, "item": item}
            try:
                if eval(condition, {"__builtins__": {}}, local_ctx):  # noqa: S307
                    results.append(item)
            except Exception:
                pass
        return results

    def _action_group_count(self, step: Dict[str, Any]) -> Dict[str, int]:
        collection = resolve_value(step.get("collection", []), self.ctx)
        field = step.get("field", "")
        counts: Dict[str, int] = {}
        for item in (collection if isinstance(collection, list) else []):
            key = str(item.get(field, "unknown")) if isinstance(item, dict) else "unknown"
            counts[key] = counts.get(key, 0) + 1
        return counts

    def _action_template(self, step: Dict[str, Any]) -> str:
        template = step.get("template", "")
        return resolve_template(template, self.ctx)

    def _action_for_each(self, step: Dict[str, Any]) -> None:
        collection = resolve_value(step.get("collection", []), self.ctx)
        as_var = step.get("as", "item")
        nested_steps = step.get("steps", [])
        for item in (collection if isinstance(collection, list) else []):
            self.ctx[as_var] = item
            for ns in nested_steps:
                result = self._execute_step(ns)
                if result in ("exit_ok", "exit_error"):
                    return

    def _action_log(self, step: Dict[str, Any]) -> None:
        params = resolve_value(step.get("params", {}), self.ctx)
        level = params.get("level", "info").lower()
        message = params.get("message", "")
        getattr(logger, level, logger.info)(message)

    def _action_gateway_notify(self, step: Dict[str, Any]) -> Any:
        params = resolve_value(step.get("params", {}), self.ctx)
        url = params.get("url", f"{self.pb.context.get('gateway_url', '')}/bruce/write")
        payload = params.get("payload", {"message": params.get("message", "")})
        headers = {"Authorization": f"Bearer {GATEWAY_TOKEN}", "Content-Type": "application/json"}
        resp = safe_request("POST", url, headers=headers, json=payload)
        return resp is not None

    def _action_gateway_write(self, step: Dict[str, Any]) -> Any:
        return self._action_gateway_notify(step)

    def _action_list_files(self, step: Dict[str, Any]) -> List[Dict[str, str]]:
        params = resolve_value(step.get("params", {}), self.ctx)
        path = params.get("path", ".")
        patterns = params.get("pattern", "*").split(",")
        limit = int(params.get("limit", 100))
        files = []
        for pattern in patterns:
            for fpath in glob.glob(os.path.join(path, pattern.strip())):
                if os.path.isfile(fpath):
                    files.append({"path": fpath, "name": os.path.basename(fpath), "size": os.path.getsize(fpath)})
        files.sort(key=lambda f: f.get("name", ""))
        return files[:limit]

    def _action_read_file(self, step: Dict[str, Any]) -> str:
        params = resolve_value(step.get("params", {}), self.ctx)
        path = params["path"]
        max_bytes = int(params.get("max_bytes", 1048576))
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(max_bytes)

    def _action_move_file(self, step: Dict[str, Any]) -> bool:
        params = resolve_value(step.get("params", {}), self.ctx)
        src = params["source"]
        dst = params["destination"]
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.rename(src, dst)
        return True

    def _action_chunk_text(self, step: Dict[str, Any]) -> List[str]:
        params = resolve_value(step.get("params", {}), self.ctx)
        text = params.get("text", "")
        chunk_size = int(params.get("chunk_size", 4000))
        # Simple sentence-aware chunking
        chunks = []
        current = ""
        for ch in text:
            current += ch
            if ch in ".!?\n" and len(current) >= chunk_size * 0.7:
                chunks.append(current.strip())
                current = ""
        if current.strip():
            chunks.append(current.strip())
        # Merge tiny trailing chunks
        if len(chunks) > 1 and len(chunks[-1]) < chunk_size * 0.3:
            chunks[-2] += " " + chunks[-1]
            chunks.pop()
        return chunks

    def _action_dedup_scan(self, step: Dict[str, Any]) -> List[Dict[str, Any]]:
        params = resolve_value(step.get("params", {}), self.ctx)
        items = params.get("items", [])
        text_field = params.get("text_field", "question")
        embedder_url = params.get("embedder_url", "")
        threshold = float(params.get("threshold", 0.92))

        if len(items) < 2:
            return []

        texts = [item.get(text_field, "") for item in items]
        resp = safe_request("POST", embedder_url, json={"inputs": texts}, timeout=60)
        if resp is None:
            logger.warning("Embedder unavailable for dedup scan")
            return []

        import numpy as np
        embeddings = resp.json()
        pairs = []
        for i in range(len(embeddings)):
            for j in range(i + 1, len(embeddings)):
                a = np.array(embeddings[i], dtype=np.float32)
                b = np.array(embeddings[j], dtype=np.float32)
                denom = float(np.linalg.norm(a) * np.linalg.norm(b))
                sim = float(np.dot(a, b) / denom) if denom > 0 else 0.0
                if sim >= threshold:
                    pairs.append({
                        "id_a": items[i].get("id"),
                        "id_b": items[j].get("id"),
                        "similarity": round(sim, 4),
                    })
        return pairs


class GuardExit(Exception):
    """Raised by guard actions for flow control."""
    pass


# ── Discovery & Scheduling ──────────────────────────────────────────

def discover_playbooks(directory: str) -> List[Playbook]:
    """Find all .yaml playbook files in the given directory."""
    playbooks = []
    for path in sorted(glob.glob(os.path.join(directory, "*.yaml"))):
        try:
            pb = Playbook(path)
            playbooks.append(pb)
            logger.info("Discovered playbook: %s (%s)", pb.name, path)
        except Exception as exc:
            logger.error("Failed loading playbook %s: %s", path, exc)
    return playbooks


def should_run_now(pb: Playbook) -> bool:
    """Check if a cron-triggered playbook should run based on last execution."""
    trigger = pb.trigger
    if trigger.get("type") != "cron":
        return True  # Polling and manual always check their own conditions

    schedule = trigger.get("schedule", "")
    last_run = STATE.get("runs", {}).get(pb.name, {}).get("last_run")
    if not last_run:
        return True  # Never run before

    # Simple interval check: at least 23h since last run for daily
    try:
        last_dt = datetime.fromisoformat(last_run.replace("Z", "+00:00"))
        hours_since = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600
    except Exception:
        return True

    # Parse simple cron patterns for min interval
    parts = schedule.split()
    if len(parts) >= 5:
        if parts[2] != "*":  # Monthly
            return hours_since >= 24 * 28
        if parts[4] != "*":  # Weekly
            return hours_since >= 24 * 6
        return hours_since >= 23  # Daily

    return hours_since >= 23


# ── Signal handling ──────────────────────────────────────────────────

def shutdown_handler(*_args):
    global SHUTDOWN
    SHUTDOWN = True
    logger.info("Shutdown signal received")


# ── Main ─────────────────────────────────────────────────────────────

def run_one(playbook_path: str) -> Dict[str, Any]:
    """Load and execute a single playbook."""
    pb = Playbook(playbook_path)
    runner = PlaybookRunner(pb)
    if not runner.check_trigger():
        logger.info("⏭ Trigger condition not met for %s — skipping", pb.name)
        return {"playbook": pb.name, "status": "skipped", "reason": "trigger_not_met"}
    return runner.run()


def run_all(directory: str) -> List[Dict[str, Any]]:
    """Discover and run all playbooks whose triggers are met."""
    playbooks = discover_playbooks(directory)
    results = []
    for pb in playbooks:
        if SHUTDOWN:
            break
        if not should_run_now(pb):
            logger.info("⏭ %s: not scheduled yet — skipping", pb.name)
            continue
        runner = PlaybookRunner(pb)
        if not runner.check_trigger():
            logger.info("⏭ %s: trigger not met — skipping", pb.name)
            continue
        results.append(runner.run())
    return results


def run_loop(directory: str, cycle_seconds: int = 300) -> None:
    """Continuously run all playbooks on a cycle."""
    logger.info("Starting playbook loop (cycle=%ds)", cycle_seconds)
    while not SHUTDOWN:
        results = run_all(directory)
        executed = [r for r in results if r.get("status") != "skipped"]
        logger.info("Cycle complete: %d playbooks executed", len(executed))
        for remaining in range(cycle_seconds):
            if SHUTDOWN:
                break
            time.sleep(1)
    logger.info("Loop stopped")


def list_playbooks(directory: str) -> None:
    """Print discovered playbooks."""
    playbooks = discover_playbooks(directory)
    print(f"\n{'Name':<25} {'Version':<10} {'Trigger':<15} {'Steps':<8} {'Path'}")
    print("-" * 90)
    for pb in playbooks:
        trigger_type = pb.trigger.get("type", "manual")
        schedule = pb.trigger.get("schedule", pb.trigger.get("interval_seconds", ""))
        trigger_str = f"{trigger_type}"
        if schedule:
            trigger_str += f" ({schedule})"
        print(f"{pb.name:<25} {pb.version:<10} {trigger_str:<15} {len(pb.steps):<8} {pb.path}")
    print()


def parse_args():
    parser = argparse.ArgumentParser(description=f"BRUCE Playbook Runner v{VERSION}")
    parser.add_argument("--playbook", "-p", help="Path to a specific playbook YAML")
    parser.add_argument("--dir", "-d", default=str(PLAYBOOKS_DIR), help="Directory of playbooks")
    parser.add_argument("--once", action="store_true", help="Run once and exit")
    parser.add_argument("--all", action="store_true", help="Run all discovered playbooks")
    parser.add_argument("--loop", action="store_true", help="Run all playbooks in a loop")
    parser.add_argument("--cycle", type=int, default=300, help="Seconds between loop cycles (default: 300)")
    parser.add_argument("--list", action="store_true", help="List discovered playbooks and exit")
    return parser.parse_args()


def main() -> int:
    setup_logging()
    load_state()
    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    args = parse_args()

    if args.list:
        list_playbooks(args.dir)
        return 0

    if args.playbook:
        if not os.path.exists(args.playbook):
            logger.error("Playbook not found: %s", args.playbook)
            return 1
        result = run_one(args.playbook)
        print(json.dumps(result, indent=2, default=str))
        return 0 if result.get("status") == "success" else 1

    if args.all and args.loop:
        run_loop(args.dir, cycle_seconds=args.cycle)
        return 0

    if args.all or args.once:
        results = run_all(args.dir)
        for r in results:
            print(json.dumps(r, indent=2, default=str))
        failures = sum(1 for r in results if r.get("status") not in ("success", "skipped"))
        return 1 if failures > 0 else 0

    print(f"BRUCE Playbook Runner v{VERSION}")
    print("Use --playbook <path>, --all, --all --loop, or --list")
    return 0


if __name__ == "__main__":
    sys.exit(main())
