#!/usr/bin/env python3
"""Insert gateway-first canonical KB entry via staging_queue."""

import json
import urllib.request
from datetime import datetime, timezone

GATEWAY = "http://192.168.2.230:4000"
TOKEN = "bruce-secret-token-01"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}


def fetch_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def main():
    # 1. Get all endpoints from OpenAPI
    spec = fetch_json(f"{GATEWAY}/openapi.json")
    paths = spec.get("paths", {})

    endpoint_lines = []
    for path in sorted(paths.keys()):
        methods = [m.upper() for m in paths[path] if m in ("get", "post", "put", "patch", "delete")]
        endpoint_lines.append(f"{'|'.join(methods)} {path}")

    endpoint_count = len(endpoint_lines)
    endpoint_list = "\n".join(endpoint_lines)

    # 2. Build KB entry
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

Generated: {datetime.now(timezone.utc).isoformat()}"""

    # 3. Submit via staging_queue through /bruce/write
    payload = {
        "table_cible": "staging_queue",
        "contenu_json": {
            "table_cible": "knowledge_base",
            "contenu_json": json.dumps({
                "question": question,
                "answer": answer,
                "category": "governance",
                "subcategory": "architecture-rules",
                "tags": ["gateway-first", "architecture", "multi-client", "canonical"],
                "confidence_score": 1.0,
                "author_system": "claude",
                "project_scope": "homelab",
                "tag_domain": "bruce",
            }),
            "author_system": "claude",
            "notes": f"[998] Gateway-first canonical KB entry with {endpoint_count} endpoint mapping",
        },
        "author_system": "claude",
        "notes": "[998] Gateway-first canonical KB entry",
    }

    data = json.dumps(payload).encode()
    req = urllib.request.Request(f"{GATEWAY}/bruce/write", data=data, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        result = json.loads(resp.read())
        print(json.dumps(result, indent=2))

    print(f"\nSubmitted gateway-first KB entry ({endpoint_count} endpoints) to staging_queue.")
    print("Next step: run staging validation to promote to knowledge_base.")


if __name__ == "__main__":
    main()
