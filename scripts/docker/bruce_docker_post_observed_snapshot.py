#!/usr/bin/env python3
import json
import subprocess
import sys
import uuid
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

MCP_STACK_DIR = "/home/furycom/mcp-stack"
COLLECTOR = "/home/furycom/bruce_docker_collect_local.py"
SNAPSHOT_DIR = "/home/furycom/docker_snapshots"
SUPABASE_URL_DEFAULT = "http://192.168.2.146:3000"

REMOTE_TARGETS = [
    {"hostname": "box2-observability",   "ssh": "yann@192.168.2.154", "connect_timeout": 6},
    {"hostname": "box2-automation",      "ssh": "yann@192.168.2.174", "connect_timeout": 6},
    {"hostname": "box2-edge",            "ssh": "yann@192.168.2.87",  "connect_timeout": 6},
    {"hostname": "box2-secrets",         "ssh": "yann@192.168.2.249", "connect_timeout": 6},
    {"hostname": "box2-docs",            "ssh": "yann@192.168.2.113", "connect_timeout": 6},
    {"hostname": "box2-tube",            "ssh": "yann@192.168.2.173", "connect_timeout": 6},
    {"hostname": "box2-daily",           "ssh": "yann@192.168.2.12",  "connect_timeout": 6},
    {"hostname": "box2-media",           "ssh": "yann@192.168.2.123", "connect_timeout": 6},
]

def die(msg: str, rc: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(rc)

def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def run(cmd, timeout=None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True, timeout=timeout)

def tail(s: str, n: int = 800) -> str:
    s = s or ""
    return s if len(s) <= n else s[-n:]

def load_env_from_file(env_path: str) -> dict:
    p = Path(env_path)
    if not p.exists():
        return {}
    out = {}
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out

def get_supabase_cfg():
    env = load_env_from_file(f"{MCP_STACK_DIR}/.env")
    supabase_url = env.get("SUPABASE_URL", "").strip().rstrip("/") or SUPABASE_URL_DEFAULT.rstrip("/")
    supabase_key = env.get("SUPABASE_KEY", "").strip()
    if not supabase_key:
        die(f"SUPABASE_KEY not found in {MCP_STACK_DIR}/.env")
    return supabase_url, supabase_key

def post_snapshot(supabase_url: str, supabase_key: str, hostname: str, ts_iso: str, snapshot: dict) -> None:
    url = f"{supabase_url}/observed_snapshots"
    payload = {
        "id": str(uuid.uuid4()),
        "source_id": "docker",
        "hostname": hostname,
        "ts": ts_iso,
        "payload": {
            "source": "docker",
            "hostname": hostname,
            "snapshot": snapshot,
        },
    }
    data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = {
        "Authorization": "Bearer " + supabase_key,
        "apikey": supabase_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", "replace")
            if resp.status < 200 or resp.status >= 300:
                die(f"post failed host={hostname} http={resp.status} body_tail={tail(body, 1200)}")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        die(f"post failed host={hostname} http={getattr(e, 'code', 'NA')} body_tail={tail(body, 1200)}")
    except Exception as e:
        die(f"post failed host={hostname} exc={type(e).__name__}: {e}")

def _extract_docker_ps_list(obj) -> tuple:
    """
    Retourne (docker_ps_list, err_string_or_None)
    Supporte deux formats:
      A) {"docker_ps":[...], ...}
      B) {"snapshot":{"docker_ps":[...]}, ...}   <-- ton format actuel
    """
    if not isinstance(obj, dict):
        return None, f"payload_not_dict:{type(obj).__name__}"

    # A
    v = obj.get("docker_ps")
    if isinstance(v, list):
        return v, None

    # B
    snap = obj.get("snapshot")
    if isinstance(snap, dict) and isinstance(snap.get("docker_ps"), list):
        return snap["docker_ps"], None

    # Sinon
    return None, f"docker_ps_not_found_or_not_list:{type(v).__name__}"

def load_local_snapshot(local_host: str) -> dict:
    observed_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat() + "Z"
    out = {
        "observed_at": observed_at,
        "collect_ok": False,
        "collect_error": None,
        "stderr_tail": "",
        "stdout_tail": "",
        "docker_ps": None,
    }

    if not Path(COLLECTOR).exists():
        out["collect_error"] = f"collector_not_found:{COLLECTOR}"
        return out

    try:
        cp = run(["python3", COLLECTOR], timeout=90)
    except Exception as e:
        out["collect_error"] = f"collector_exec_failed:{type(e).__name__}:{e}"
        return out

    out["stdout_tail"] = tail(cp.stdout, 1200)
    out["stderr_tail"] = tail(cp.stderr, 1200)

    if cp.returncode != 0:
        out["collect_error"] = f"collector_rc={cp.returncode}"
        return out

    snap_path = Path(SNAPSHOT_DIR) / f"docker_ps_{local_host}.json"
    if not snap_path.exists():
        out["collect_error"] = f"snapshot_file_missing:{snap_path}"
        return out

    try:
        payload = json.loads(snap_path.read_text(encoding="utf-8", errors="replace"))
    except Exception as e:
        out["collect_error"] = f"snapshot_json_parse_failed:{type(e).__name__}:{e}"
        return out

    docker_ps, err = _extract_docker_ps_list(payload)
    if err:
        out["collect_error"] = f"local_{err}"
        out["docker_ps"] = None
        return out

    out["docker_ps"] = docker_ps
    out["collect_ok"] = True
    return out

def remote_docker_ps(ssh_target: str, connect_timeout: int) -> dict:
    observed_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat() + "Z"
    out = {
        "observed_at": observed_at,
        "collect_ok": False,
        "collect_error": None,
        "ssh_target": ssh_target,
        "stderr_tail": "",
        "stdout_tail": "",
        "docker_ps": None,
    }

    # IMPORTANT: format QUOTE pour éviter l’interprétation côté shell distant
    remote_cmd = "docker ps --format '{{json .}}'"

    cmd = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", f"ConnectTimeout={int(connect_timeout)}",
        ssh_target,
        remote_cmd,
    ]

    try:
        cp = run(cmd, timeout=max(30, int(connect_timeout) + 20))
    except Exception as e:
        out["collect_error"] = f"ssh_exec_failed:{type(e).__name__}:{e}"
        return out

    out["stdout_tail"] = tail(cp.stdout, 1200)
    out["stderr_tail"] = tail(cp.stderr, 1200)

    if cp.returncode != 0:
        out["collect_error"] = f"remote_docker_ps_rc={cp.returncode}"
        return out

    lines = [x for x in cp.stdout.splitlines() if x.strip()]
    items = []
    for ln in lines:
        try:
            items.append(json.loads(ln))
        except Exception:
            out["collect_error"] = "remote_json_parse_failed"
            return out

    out["docker_ps"] = items
    out["collect_ok"] = True
    return out

def main() -> None:
    supabase_url, supabase_key = get_supabase_cfg()
    ts_iso = now_utc_iso()

    local_host = "furymcp"
    local_snapshot = load_local_snapshot(local_host)
    post_snapshot(supabase_url, supabase_key, local_host, ts_iso, local_snapshot)
    print(f"OK: posted docker observed_snapshot host={local_host} ts={ts_iso}")

    for t in REMOTE_TARGETS:
        r_host = t["hostname"]
        ssh_target = t["ssh"]
        ct = int(t.get("connect_timeout", 6))
        remote_snapshot = remote_docker_ps(ssh_target, ct)
        post_snapshot(supabase_url, supabase_key, r_host, ts_iso, remote_snapshot)
        print(f"OK: posted docker observed_snapshot host={r_host} ts={ts_iso}")

if __name__ == "__main__":
    main()
