#!/usr/bin/env python3
"""Routing helpers for BRUCE multi-LLM model selection."""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

DEFAULT_PROFILES_PATH = "/home/furycom/llm_profiles.json"
LOGGER = logging.getLogger("llm_selector")


class LLMSelector:
    """Load, validate, and expose routing information for LLM jobs."""

    def __init__(self, profiles_path: str = DEFAULT_PROFILES_PATH):
        self.profiles_path = profiles_path
        self._profiles: Dict[str, Any] = {}
        self._loaded = False
        self.reload()

    def reload(self) -> bool:
        """Reload profiles from disk. Returns True when valid profiles are active."""
        self._loaded = False
        self._profiles = {}
        if not os.path.exists(self.profiles_path):
            LOGGER.warning("Profiles file missing: %s", self.profiles_path)
            return False
        try:
            with open(self.profiles_path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        except Exception as exc:
            LOGGER.error("Failed reading profiles file %s: %s", self.profiles_path, exc)
            return False
        if not self._validate_profiles(payload):
            return False
        self._profiles = payload
        self._loaded = True
        LOGGER.info("Loaded LLM profiles from %s", self.profiles_path)
        return True

    def is_available(self) -> bool:
        return self._loaded

    def get_pipeline(self, job_name: str) -> List[str]:
        route = self._profiles.get("routing", {}).get(job_name, {})
        pipeline = route.get("pipeline") or []
        enabled = []
        for key in pipeline:
            model = self.get_model_by_key(key)
            if model:
                enabled.append(key)
            else:
                LOGGER.warning("Skipping unavailable model %s in pipeline for job %s", key, job_name)
        return enabled

    def select_model(self, job_name: str, layer: Optional[int] = None) -> Optional[Dict[str, Any]]:
        pipeline = self.get_pipeline(job_name)
        if not pipeline:
            fallback = self.get_fallback(job_name)
            return self.get_model_by_key(fallback) if fallback else None
        candidates = []
        for key in pipeline:
            profile = self.get_model_by_key(key)
            if not profile:
                continue
            if layer is None or profile.get("layer") == layer:
                candidates.append(profile)
        if not candidates:
            return None
        candidates.sort(
            key=lambda item: (
                float(item.get("bench_score", 0.0)),
                float(item.get("speed_tps", 0.0)),
            ),
            reverse=True,
        )
        return candidates[0]

    def needs_verification(self, confidence: float, job_name: str) -> bool:
        try:
            score = float(confidence)
        except (TypeError, ValueError):
            return True
        threshold = self.get_confidence_threshold(job_name)
        return score < threshold

    def get_model_by_key(self, key: Optional[str]) -> Optional[Dict[str, Any]]:
        if not key:
            return None
        models = self._profiles.get("models", {})
        profile = models.get(key)
        if not isinstance(profile, dict):
            return None
        if not profile.get("enabled", False):
            return None
        merged = dict(profile)
        merged["key"] = key
        return merged

    def list_enabled_models(self) -> List[Dict[str, Any]]:
        enabled: List[Dict[str, Any]] = []
        for key in self._profiles.get("models", {}):
            profile = self.get_model_by_key(key)
            if profile:
                enabled.append(profile)
        enabled.sort(key=lambda item: (int(item.get("layer", 99)), item.get("key", "")))
        return enabled

    def get_swap_config(self) -> Dict[str, Any]:
        raw = dict(self._profiles.get("swap_config") or {})
        if not raw:
            return {}
        raw.setdefault("health_check_url", "http://192.168.2.32:8000/health")
        raw.setdefault("health_check_timeout", 120)
        raw.setdefault("health_check_interval", 5)
        raw.setdefault("models_base_dir", "/srv/models")
        raw.setdefault("ssh_alias", "furycomai")
        raw.setdefault("gpu_layers", 99)
        raw.setdefault("default_ctx_size", 16384)
        raw.setdefault("default_threads", 24)
        return raw

    def get_confidence_threshold(self, job_name: str) -> float:
        route = self._profiles.get("routing", {}).get(job_name, {})
        try:
            return float(route.get("confidence_threshold", 1.0))
        except (TypeError, ValueError):
            LOGGER.warning("Invalid confidence threshold for %s; defaulting to 1.0", job_name)
            return 1.0

    def get_fallback(self, job_name: str) -> Optional[str]:
        route = self._profiles.get("routing", {}).get(job_name, {})
        fallback = route.get("fallback")
        if fallback and self.get_model_by_key(fallback):
            return fallback
        return None

    def _validate_profiles(self, payload: Dict[str, Any]) -> bool:
        if not isinstance(payload, dict):
            LOGGER.error("Profiles payload must be an object")
            return False
        models = payload.get("models")
        routing = payload.get("routing")
        swap_config = payload.get("swap_config")
        if not isinstance(models, dict) or not isinstance(routing, dict) or not isinstance(swap_config, dict):
            LOGGER.error("Profiles payload requires models, routing, and swap_config objects")
            return False
        for key, profile in models.items():
            if not isinstance(profile, dict):
                LOGGER.error("Model %s profile must be an object", key)
                return False
            required = ["name", "gguf_dir", "capabilities", "layer", "enabled"]
            missing = [field for field in required if field not in profile]
            if missing:
                LOGGER.error("Model %s missing required fields: %s", key, ", ".join(missing))
                return False
            if not isinstance(profile.get("capabilities"), list):
                LOGGER.error("Model %s capabilities must be a list", key)
                return False
        for job_name, route in routing.items():
            if not isinstance(route, dict):
                LOGGER.error("Routing for %s must be an object", job_name)
                return False
            pipeline = route.get("pipeline", [])
            if not isinstance(pipeline, list):
                LOGGER.error("Routing pipeline for %s must be a list", job_name)
                return False
            for key in pipeline:
                if key not in models:
                    LOGGER.error("Routing for %s references unknown model %s", job_name, key)
                    return False
        return True


_DEFAULT_SELECTOR: Optional[LLMSelector] = None


def get_selector(profiles_path: str = DEFAULT_PROFILES_PATH) -> LLMSelector:
    global _DEFAULT_SELECTOR
    if _DEFAULT_SELECTOR is None or _DEFAULT_SELECTOR.profiles_path != profiles_path:
        _DEFAULT_SELECTOR = LLMSelector(profiles_path=profiles_path)
    return _DEFAULT_SELECTOR


def get_pipeline(job_name: str, profiles_path: str = DEFAULT_PROFILES_PATH) -> List[str]:
    return get_selector(profiles_path).get_pipeline(job_name)


def select_model(job_name: str, layer: Optional[int] = None, profiles_path: str = DEFAULT_PROFILES_PATH) -> Optional[Dict[str, Any]]:
    return get_selector(profiles_path).select_model(job_name, layer=layer)


def needs_verification(confidence: float, job_name: str, profiles_path: str = DEFAULT_PROFILES_PATH) -> bool:
    return get_selector(profiles_path).needs_verification(confidence, job_name)


def get_model_by_key(key: Optional[str], profiles_path: str = DEFAULT_PROFILES_PATH) -> Optional[Dict[str, Any]]:
    return get_selector(profiles_path).get_model_by_key(key)


def list_enabled_models(profiles_path: str = DEFAULT_PROFILES_PATH) -> List[Dict[str, Any]]:
    return get_selector(profiles_path).list_enabled_models()


def get_swap_config(profiles_path: str = DEFAULT_PROFILES_PATH) -> Dict[str, Any]:
    return get_selector(profiles_path).get_swap_config()


def reload(profiles_path: str = DEFAULT_PROFILES_PATH) -> bool:
    return get_selector(profiles_path).reload()
