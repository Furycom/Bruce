#!/usr/bin/env python3
"""Swap the remote llama.cpp Docker container between LLM profiles."""

from __future__ import annotations

import json
import logging
import os
import shlex
import subprocess
import time
from typing import Any, Dict, Optional

import requests

STATE_FILE = "/home/furycom/logs/llm_current_model.json"
LOGGER = logging.getLogger("llm_swapper")
HTTP = requests.Session()


def _ensure_state_dir(state_file: str) -> None:
    directory = os.path.dirname(state_file)
    if directory:
        os.makedirs(directory, exist_ok=True)


def _read_state(state_file: str) -> Dict[str, Any]:
    try:
        with open(state_file, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
            if isinstance(payload, dict):
                return payload
    except FileNotFoundError:
        return {}
    except Exception as exc:
        LOGGER.error("Failed reading swapper state %s: %s", state_file, exc)
    return {}


def _write_state(state_file: str, payload: Dict[str, Any]) -> None:
    try:
        _ensure_state_dir(state_file)
        with open(state_file, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
    except Exception as exc:
        LOGGER.error("Failed writing swapper state %s: %s", state_file, exc)


def get_current_model(state_file: str = STATE_FILE) -> Optional[str]:
    return _read_state(state_file).get("model_key")


def health_check(url: str, timeout: int) -> bool:
    try:
        resp = HTTP.get(url, timeout=timeout)
        return resp.ok
    except Exception as exc:
        LOGGER.warning("Health check failed for %s: %s", url, exc)
        return False


def _run_ssh(cmd: str, ssh_alias: str, timeout: int = 120) -> subprocess.CompletedProcess:
    LOGGER.info("SSH %s: %s", ssh_alias, cmd)
    return subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ssh_alias, cmd],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _detect_gguf_path(profile: Dict[str, Any], swap_config: Dict[str, Any]) -> Optional[str]:
    models_base_dir = swap_config.get("models_base_dir", "/srv/models")
    gguf_dir = profile.get("gguf_dir")
    if not gguf_dir:
        LOGGER.error("Profile missing gguf_dir: %s", profile)
        return None
    remote_cmd = (
        "find "
        f"{shlex.quote(os.path.join(models_base_dir, gguf_dir))} "
        "-name '*.gguf' -type f | head -1"
    )
    result = _run_ssh(remote_cmd, swap_config.get("ssh_alias", "furycomai"), timeout=30)
    if result.returncode != 0:
        LOGGER.error("Failed detecting GGUF for %s: %s", gguf_dir, result.stderr.strip())
        return None
    gguf_path = (result.stdout or "").strip()
    if not gguf_path:
        LOGGER.error("No GGUF file found in %s", gguf_dir)
        return None
    return gguf_path


def _stop_container(swap_config: Dict[str, Any]) -> bool:
    container_name = swap_config.get("docker_container_name", "llama-server")
    cmd = f"docker stop {shlex.quote(container_name)} >/dev/null 2>&1 || true && docker rm {shlex.quote(container_name)} >/dev/null 2>&1 || true"
    result = _run_ssh(cmd, swap_config.get("ssh_alias", "furycomai"), timeout=60)
    if result.returncode != 0:
        LOGGER.error("Failed stopping container %s: %s", container_name, result.stderr.strip())
        return False
    return True


def _start_container(profile: Dict[str, Any], swap_config: Dict[str, Any], gguf_path: str) -> bool:
    container_name = swap_config.get("docker_container_name", "llama-server")
    docker_image = swap_config.get("docker_image", "ghcr.io/ggml-org/llama.cpp:server-cuda")
    base_args = swap_config.get("base_docker_args", "--gpus all -p 8000:8080 --restart unless-stopped")
    gpu_layers_raw = swap_config.get("gpu_layers", "auto")
    gpu_layers = "auto" if str(gpu_layers_raw).lower() == "auto" else int(gpu_layers_raw)
    ctx_size = int(profile.get("context_length") or swap_config.get("default_ctx_size", 16384))
    threads = int(swap_config.get("default_threads", 24))
    extra_args = (profile.get("docker_extra_args") or "").strip()
    remote_cmd = " ".join(
        part
        for part in [
            "docker run -d",
            f"--name {shlex.quote(container_name)}",
            base_args,
            "-v /srv/models:/models:ro",
            shlex.quote(docker_image),
            f"--model {shlex.quote(gguf_path.replace('/srv/models', '/models', 1))}",
            "--host 0.0.0.0 --port 8080",
            f"--n-gpu-layers {gpu_layers}",
            f"--ctx-size {ctx_size}",
            f"--threads {threads}",
            "--parallel 1 --cont-batching --flash-attn auto",
            "--api-key token-abc123",
            extra_args,
        ]
        if part
    )
    result = _run_ssh(remote_cmd, swap_config.get("ssh_alias", "furycomai"), timeout=120)
    if result.returncode != 0:
        LOGGER.error("Failed starting container for %s: %s", profile.get("key"), result.stderr.strip())
        return False
    return True


def _wait_for_health(swap_config: Dict[str, Any]) -> bool:
    url = swap_config.get("health_check_url", "http://192.168.2.32:8000/health")
    timeout_window = int(swap_config.get("health_check_timeout", 120))
    interval = int(swap_config.get("health_check_interval", 5))
    deadline = time.time() + timeout_window
    while time.time() < deadline:
        if health_check(url, min(interval, 10)):
            return True
        time.sleep(interval)
    LOGGER.error("Timed out waiting for health check at %s", url)
    return False


def force_swap(
    model_key: str,
    profile: Dict[str, Any],
    swap_config: Dict[str, Any],
    *,
    state_file: str = STATE_FILE,
) -> bool:
    if not profile:
        LOGGER.error("Cannot swap without model profile for %s", model_key)
        return False
    gguf_path = _detect_gguf_path(profile, swap_config)
    if not gguf_path:
        return False
    if not _stop_container(swap_config):
        return False
    if not _start_container(profile, swap_config, gguf_path):
        return False
    if not _wait_for_health(swap_config):
        return False
    _write_state(
        state_file,
        {
            "model_key": model_key,
            "model_name": profile.get("name"),
            "gguf_path": gguf_path,
            "loaded_at": int(time.time()),
        },
    )
    LOGGER.info("Swapped active model to %s", model_key)
    return True


def ensure_model(
    model_key: str,
    profile: Dict[str, Any],
    swap_config: Dict[str, Any],
    *,
    state_file: str = STATE_FILE,
) -> bool:
    current = get_current_model(state_file=state_file)
    if current == model_key:
        LOGGER.info("Model %s already active; no swap required", model_key)
        return True
    return force_swap(model_key, profile, swap_config, state_file=state_file)
