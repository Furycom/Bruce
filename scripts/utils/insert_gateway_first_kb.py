#!/usr/bin/env python3
"""Insert gateway-first canonical KB entry via staging_queue.

This script keeps the endpoint list dynamic by reading the live OpenAPI document,
then writes through the staging pipeline only (never direct knowledge_base insert).
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

DEFAULT_GATEWAY = "http://192.168.2.230:4000"
DEFAULT_TOKEN = os.environ.get("BRUCE_AUTH_TOKEN", "")
DEFAULT_SUPABASE_URL = "http://192.168.2.146:8000"
DEFAULT_SUPABASE_KEY_PATH = "/home/furycom/bruce-config/supabase_key_local.txt"
HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def env(name: str, default: str) -> str:
    value = os.getenv(name, default).strip()
    return value or default


def build_headers(token: str, content_type: bool = True) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    if content_type:
        headers["Content-Type"] = "application/json"
    return headers


def http_json(url: str, *, token: str, method: str = "GET", payload: dict[str, Any] | None = None, timeout: int = 15) -> Any:
    data = None
    headers = build_headers(token, content_type=payload is not None)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} on {method} {url}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error on {method} {url}: {exc}") from exc


def fetch_endpoint_lines(gateway: str, token: str) -> list[str]:
    spec = http_json(f"{gateway}/openapi.json", token=token, timeout=15)
    paths = spec.get("paths", {})
    if not isinstance(paths, dict):
        raise RuntimeError("OpenAPI response did not include a valid 'paths' object.")

    endpoint_lines: list[str] = []
    for path in sorted(paths.keys()):
        operation_obj = paths.get(path, {})
        methods = [m.upper() for m in operation_obj if m in HTTP_METHODS]
        if not methods:
            continue
        endpoint_lines.append(f"{'|'.join(methods)} {path}")

    if not endpoint_lines:
        raise RuntimeError("No endpoints were discovered from /openapi.json.")
    return endpoint_lines


def build_kb_payload(endpoint_lines: list[str]) -> dict[str, Any]:
    endpoint_count = len(endpoint_lines)
    endpoint_list = "\n".join(endpoint_lines)
    generated_at = datetime.now(timezone.utc).isoformat()

    question = "What is the gateway-first architecture rule and what endpoints are available?"
    answer = f"""## Gateway-First Architecture Rule

**RULE: All homelab interaction MUST go through the gateway at 192.168.2.230:4000.**

Native MCP tools (Prometheus MCP, Grafana MCP, Docker MCP, Proxmox MCP, Desktop Commander SSH) are debug-only fallbacks. They should ONLY be used when:
1. The gateway is DOWN
2. Deep investigation requires raw access (e.g., PromQL ad-hoc queries, Loki log streaming)
3. A specific capability does not exist in the gateway yet

### Why gateway-first?
- Single auth layer (bruce_api_tokens with scopes + rate limiting)
- Command security (exec-security.js whitelist/blacklist for all shell commands)
- Multi-client (same API for Claude Desktop, OpenWebUI, n8n, Codex, future clients)
- Cacheable (health/full cached 30s, topology cached, etc.)
- Audit trail (all actions logged when audit table is active)

### {endpoint_count} Gateway Endpoints

{endpoint_list}

### MCP to Gateway replacement mapping
| Instead of... | Use gateway endpoint |
|---|---|
| SSH to check process | POST /bruce/exec or GET /bruce/process/status |
| SSH to remote machine | POST /bruce/ssh/exec |
| Prometheus MCP | GET /bruce/health/full or /bruce/integrity |
| Docker MCP | GET /bruce/docker/ps, /docker/logs/{{c}}, /docker/stats/{{c}} |
| Direct Supabase REST | POST /bruce/read, /bruce/write, /tools/supabase/exec-sql |
| Pulse API | GET /bruce/health/full (includes Pulse) |

Generated: {generated_at}"""

    return {
        "table_cible": "staging_queue",
        "contenu_json": {
            "table_cible": "knowledge_base",
            "contenu_json": json.dumps(
                {
                    "question": question,
                    "answer": answer,
                    "category": "governance",
                    "subcategory": "architecture-rules",
                    "tags": ["gateway-first", "architecture", "multi-client", "canonical"],
                    "confidence_score": 1.0,
                    "author_system": "claude",
                    "project_scope": "homelab",
                    "tag_domain": "bruce",
                }
            ),
            "author_system": "claude",
            "notes": f"[998] Gateway-first canonical KB entry with {endpoint_count} endpoint mapping",
        },
        "author_system": "claude",
        "notes": "[998] Gateway-first canonical KB entry",
    }


def show_staging_status(gateway: str, token: str) -> None:
    status = http_json(f"{gateway}/bruce/staging/status", token=token, timeout=15)
    print("\nStaging status:")
    print(json.dumps(status, indent=2))


def validate_staging(gateway: str, token: str) -> None:
    result = http_json(
        f"{gateway}/bruce/staging/validate",
        token=token,
        method="POST",
        payload={},
        timeout=30,
    )
    print("\nValidation result:")
    print(json.dumps(result, indent=2))


def check_kb(supabase_url: str, key: str) -> None:
    params = urllib.parse.urlencode(
        {
            "category": "eq.governance",
            "subcategory": "eq.architecture-rules",
            "select": "id,question,category,subcategory,tags",
        }
    )
    url = f"{supabase_url}/rest/v1/knowledge_base?{params}"
    req = urllib.request.Request(url, headers={"apikey": key})
    with urllib.request.urlopen(req, timeout=15) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    print("\nKnowledge base check:")
    print(json.dumps(payload, indent=2))


def load_supabase_key(path: str) -> str | None:
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        key = fh.read().strip()
    return key or None


def main() -> int:
    gateway = env("BRUCE_GATEWAY_URL", DEFAULT_GATEWAY).rstrip("/")
    token = env("BRUCE_GATEWAY_TOKEN", DEFAULT_TOKEN)
    supabase_url = env("BRUCE_SUPABASE_URL", DEFAULT_SUPABASE_URL).rstrip("/")
    supabase_key = os.getenv("BRUCE_SUPABASE_KEY")
    supabase_key_path = env("BRUCE_SUPABASE_KEY_PATH", DEFAULT_SUPABASE_KEY_PATH)

    print(f"Using gateway: {gateway}")
    try:
        endpoint_lines = fetch_endpoint_lines(gateway, token)
        payload = build_kb_payload(endpoint_lines)

        write_result = http_json(
            f"{gateway}/bruce/write",
            token=token,
            method="POST",
            payload=payload,
            timeout=20,
        )
        print("\nWrite result:")
        print(json.dumps(write_result, indent=2))
        print(f"\nSubmitted gateway-first KB entry ({len(endpoint_lines)} endpoints) to staging_queue.")

        show_staging_status(gateway, token)
        validate_staging(gateway, token)

        if not supabase_key:
            supabase_key = load_supabase_key(supabase_key_path)

        if supabase_key:
            check_kb(supabase_url, supabase_key)
        else:
            print(
                "\nSkipped knowledge_base verification: no Supabase key found. "
                "Set BRUCE_SUPABASE_KEY or BRUCE_SUPABASE_KEY_PATH."
            )
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
