#!/usr/bin/env python3
"""
bruce_pipeline.py — Multi-LLM Pipeline Orchestrator for BRUCE homelab.

Manages model routing, swap scheduling, and task execution across multiple
LLM models on a single GPU. Designed to integrate with the existing
bruce_screensaver.py with minimal changes.

Session 1231 — 2026-03-20
[1054] Fix claim logic — TTL expiry + screensaver self-bypass (Session 1237)
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests

# — Imports from existing BRUCE components —
import llm_swapper

LOGGER = logging.getLogger("bruce_pipeline")

# — Configuration —

PROFILES_PATH = "/home/furycom/llm_profiles.json"
PIPELINE_STATE_PATH = "/home/furycom/logs/pipeline_state.json"
LLM_CLAIMED_PATH = "/home/furycom/logs/llm_claimed.json"
LLM_CURRENT_MODEL_PATH = "/home/furycom/logs/llm_current_model.json"

MIN_BATCH_FOR_SWAP = 2
MAX_WAIT_SECONDS = 300
SWAP_COOLDOWN_SECONDS = 30
CLAIM_TTL_DEFAULT = 1800  # [1054] 30 min default TTL for claims

LLM_URL = "http://192.168.2.32:8000/v1/chat/completions"
LLM_HEADERS = {
    "Authorization": "Bearer token-abc123",
    "Content-Type": "application/json",
}
LLM_TIMEOUT = 450

HTTP = requests.Session()


def load_profiles(path=PROFILES_PATH):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        LOGGER.error("Failed loading profiles from %s: %s", path, exc)
        return {}


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    except Exception as exc:
        LOGGER.error("Failed reading %s: %s", path, exc)
        return {}


def _write_json(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as exc:
        LOGGER.error("Failed writing %s: %s", path, exc)


class Router:
    """Maps task_type to optimal model_key using profiles + DSPy benchmarks."""

    def __init__(self, profiles):
        self._models = profiles.get("models", {})
        self._routing = profiles.get("routing", {})
        self._default_model = "alpha"
        self._task_map = {}
        self._rebuild_task_map()

    def _rebuild_task_map(self):
        for task_type, route_config in self._routing.items():
            pipeline = route_config.get("pipeline", [])
            fallback = route_config.get("fallback", self._default_model)
            chosen = fallback
            for model_key in pipeline:
                model = self._models.get(model_key, {})
                if model.get("enabled", False):
                    chosen = model_key
                    break
            self._task_map[task_type] = chosen
        LOGGER.info("Router task map: %s", self._task_map)

    def route(self, task_type):
        return self._task_map.get(task_type, self._default_model)

    def get_model_profile(self, model_key):
        return self._models.get(model_key, {})

    def list_enabled_models(self):
        return [k for k, v in self._models.items() if v.get("enabled", False)]


class Scheduler:
    # NOTE: Scheduler est prévu pour le batching futur mais n'est pas encore branché dans execute()
    """Decides which model to load next based on pending task queues."""

    def __init__(self):
        self._pending = defaultdict(list)
        self._last_swap_time = 0.0

    def record_task(self, model_key):
        self._pending[model_key].append(time.time())

    def clear_model_queue(self, model_key):
        self._pending[model_key] = []

    def pick_next_model(self, current_model):
        now = time.time()
        if now - self._last_swap_time < SWAP_COOLDOWN_SECONDS:
            return None
        if current_model and len(self._pending.get(current_model, [])) > 0:
            return None
        best_model = None
        best_count = 0
        oldest_task_model = None
        oldest_task_age = 0.0
        for model_key, timestamps in self._pending.items():
            if not timestamps:
                continue
            count = len(timestamps)
            age = now - min(timestamps)
            if age > oldest_task_age:
                oldest_task_age = age
                oldest_task_model = model_key
            if count > best_count:
                best_count = count
                best_model = model_key
        if best_model and best_count >= MIN_BATCH_FOR_SWAP:
            return best_model
        if oldest_task_model and oldest_task_age > MAX_WAIT_SECONDS:
            LOGGER.info("Force swap: task for %s waited %.0fs", oldest_task_model, oldest_task_age)
            return oldest_task_model
        return None

    def record_swap(self):
        self._last_swap_time = time.time()


class PipelineState:
    """Persistent pipeline metrics and state."""

    def __init__(self, path=PIPELINE_STATE_PATH):
        self._path = path
        self._data = _read_json(path)
        if not self._data:
            self._data = {
                "current_model": None, "loaded_at": 0, "swap_count": 0,
                "total_tasks_processed": 0, "tasks_per_model": {},
                "last_swap_duration_s": 0, "avg_swap_duration_s": 0, "swaps_avoided": 0,
            }

    def save(self):
        _write_json(self._path, self._data)

    @property
    def current_model(self):
        return self._data.get("current_model")

    @current_model.setter
    def current_model(self, value):
        self._data["current_model"] = value
        self._data["loaded_at"] = int(time.time())
        self.save()

    def record_swap(self, duration_s):
        self._data["swap_count"] = self._data.get("swap_count", 0) + 1
        self._data["last_swap_duration_s"] = round(duration_s, 1)
        n = self._data["swap_count"]
        old_avg = self._data.get("avg_swap_duration_s", 0)
        self._data["avg_swap_duration_s"] = round(((old_avg * (n - 1)) + duration_s) / n, 1)
        self.save()

    def record_task(self, model_key):
        self._data["total_tasks_processed"] = self._data.get("total_tasks_processed", 0) + 1
        tpm = self._data.setdefault("tasks_per_model", {})
        tpm[model_key] = tpm.get(model_key, 0) + 1
        self.save()

    def record_swap_avoided(self):
        self._data["swaps_avoided"] = self._data.get("swaps_avoided", 0) + 1
        self.save()

    def to_dict(self):
        return dict(self._data)


class Pipeline:
    """Multi-LLM pipeline orchestrator."""

    def __init__(self, profiles_path=PROFILES_PATH):
        self._profiles = load_profiles(profiles_path)
        self._router = Router(self._profiles)
        self._scheduler = Scheduler()
        self._state = PipelineState()
        self._swap_config = self._profiles.get("swap_config", {})
        actual = llm_swapper.get_current_model()
        if actual:
            self._state.current_model = actual
            LOGGER.info("Pipeline init: current model = %s", actual)
        elif self._state.current_model:
            LOGGER.info("Pipeline init: persisted model = %s", self._state.current_model)
        else:
            LOGGER.warning("Pipeline init: no current model detected")

    def _is_claimed(self):
        """[1054] Check if LLM is claimed, with TTL expiry and owner awareness."""
        flag = _read_json(LLM_CLAIMED_PATH)
        if not flag.get("claimed", False):
            return False

        # [1054] TTL expiry — stale claims auto-release after 30 min
        claimed_at = flag.get("claimed_at", 0)
        ttl = flag.get("ttl_seconds", CLAIM_TTL_DEFAULT)
        if claimed_at and time.time() - claimed_at > ttl:
            LOGGER.warning("[1054] Stale claim expired (age=%.0fs, ttl=%ds). Auto-releasing.",
                           time.time() - claimed_at, ttl)
            _write_json(LLM_CLAIMED_PATH, {
                "claimed": False,
                "released_at": int(time.time()),
                "released_by": "pipeline_ttl_expiry",
            })
            return False

        # [1054] Allow screensaver to bypass its own claims
        claimed_by = flag.get("claimed_by", "")
        if claimed_by == "llm-screensaver":
            LOGGER.info("[1054] Claim belongs to screensaver itself — bypassing")
            return False

        LOGGER.warning("LLM claimed by '%s' at %s — blocking execution",
                       flag.get("claimed_by", "unknown"),
                       time.strftime("%H:%M:%S", time.localtime(claimed_at)) if claimed_at else "unknown")
        return True

    def _ensure_model(self, model_key):
        current = self._state.current_model
        if current == model_key:
            self._state.record_swap_avoided()
            LOGGER.info("Model %s already loaded", model_key)
            return True
        profile = self._router.get_model_profile(model_key)
        if not profile or not profile.get("enabled", False):
            LOGGER.error("Model %s not available or disabled", model_key)
            return False
        LOGGER.info("Swapping %s -> %s", current, model_key)
        # Claim-check: abort if another process claimed the LLM
        if self._is_claimed():
            LOGGER.warning("[1054] Swap aborted: LLM claimed by external process")
            return False
        start = time.time()
        success = llm_swapper.force_swap(model_key, profile, self._swap_config)
        duration = time.time() - start
        if success:
            self._state.current_model = model_key
            self._state.record_swap(duration)
            self._scheduler.record_swap()
            LOGGER.info("Swap to %s OK in %.1fs", model_key, duration)
            return True
        LOGGER.error("Swap to %s FAILED after %.1fs", model_key, duration)
        return False

    def execute(self, task_type, prompt, *, max_tokens=1200, temperature=0):
        target_model = self._router.route(task_type)
        LOGGER.info("execute: task=%s model=%s current=%s", task_type, target_model, self._state.current_model)
        if self._is_claimed():
            LOGGER.warning("[1054] LLM claimed by external process — cannot execute task=%s", task_type)
            return None
        if not self._ensure_model(target_model):
            current = self._state.current_model
            if current and current != target_model:
                LOGGER.warning("Swap failed; fallback to %s", current)
                target_model = current
            else:
                return None
        result = self._llm_call(task_type, prompt, max_tokens, temperature)
        if result is not None:
            self._state.record_task(target_model)
        return result

    def execute_current(self, task_type, prompt, *, max_tokens=1200, temperature=0):
        if self._is_claimed():
            LOGGER.warning("[1054] LLM claimed by external process — cannot execute_current task=%s", task_type)
            return None
        result = self._llm_call(task_type, prompt, max_tokens, temperature)
        if result is not None:
            self._state.record_task(self._state.current_model or "unknown")
        return result

    def get_jobs_for_current_model(self):
        current = self._state.current_model
        if not current:
            return []
        return [t for t, m in self._router._task_map.items() if m == current]

    def should_swap_for_remaining_jobs(self, remaining_jobs):
        if not remaining_jobs:
            return None
        model_counts = defaultdict(int)
        for job in remaining_jobs:
            model_counts[self._router.route(job)] += 1
        best_model = max(model_counts, key=model_counts.get)
        if best_model == self._state.current_model:
            return None
        if model_counts[best_model] >= MIN_BATCH_FOR_SWAP:
            return best_model
        return None

    def get_current_model(self):
        return self._state.current_model

    def get_stats(self):
        return self._state.to_dict()

    def _llm_call(self, task_type, prompt, max_tokens, temperature):
        payload = {
            "model": self._state.current_model or "alpha",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "reasoning_format": "none",
        }
        LOGGER.info("LLM call: task=%s model=%s prompt_len=%d", task_type, self._state.current_model, len(prompt))
        start = time.time()
        try:
            resp = HTTP.post(LLM_URL, headers=LLM_HEADERS, json=payload, timeout=LLM_TIMEOUT)
        except Exception as exc:
            LOGGER.error("LLM request failed: %s", exc)
            return None
        elapsed = round(time.time() - start, 2)
        if not resp.ok:
            LOGGER.error("LLM HTTP %d: %s", resp.status_code, resp.text[:500])
            return None
        try:
            raw = resp.json()["choices"][0]["message"]["content"]
        except Exception as exc:
            LOGGER.error("Failed parsing LLM envelope: %s", exc)
            return None
        parsed = self._parse_json(raw)
        if parsed is None:
            LOGGER.error("LLM JSON parse failed after %.1fs", elapsed)
            return None
        LOGGER.info("LLM success: task=%s elapsed=%.1fs", task_type, elapsed)
        return parsed

    @staticmethod
    def _parse_json(raw):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            pass
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(raw[start:end + 1])
            except (json.JSONDecodeError, TypeError):
                pass
        return None


_pipeline = None


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline()
    return _pipeline


def execute(task_type, prompt, **kwargs):
    return get_pipeline().execute(task_type, prompt, **kwargs)


if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(name)s] %(message)s", datefmt="%H:%M:%S")
    parser = argparse.ArgumentParser(description="BRUCE Multi-LLM Pipeline")
    parser.add_argument("--status", action="store_true", help="Show pipeline status")
    parser.add_argument("--route", type=str, help="Show routing for a task type")
    parser.add_argument("--jobs-for-current", action="store_true")
    parser.add_argument("--test", type=str, help="Test execute with dummy prompt")
    args = parser.parse_args()
    pipeline = get_pipeline()
    if args.status:
        import pprint
        pprint.pprint(pipeline.get_stats())
        print(f"Current model: {pipeline.get_current_model()}")
        print(f"Task map: {pipeline._router._task_map}")
    elif args.route:
        model = pipeline._router.route(args.route)
        profile = pipeline._router.get_model_profile(model)
        print(f"Task '{args.route}' -> model '{model}' ({profile.get('name')})")
    elif args.jobs_for_current:
        print(f"Current: {pipeline.get_current_model()}, Jobs: {pipeline.get_jobs_for_current_model()}")
    elif args.test:
        result = pipeline.execute(args.test, '/no_think\nTest. Reply: {"test": true}', max_tokens=100)
        print(f"Result: {result}")
    else:
        parser.print_help()
