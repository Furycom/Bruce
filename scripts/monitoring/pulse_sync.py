#!/usr/bin/env python3
import os
"""
pulse_sync.py — Infrastructure Self-Knowledge synchronisation
Interroge Pulse API + bruce_tools Supabase, produit un diff, pousse dans staging_queue.

Usage:
    python3 pulse_sync.py [--dry-run] [--verbose] [--json]

Deployed on: .230 (/home/furycom/pulse_sync.py)
Author: claude-opus-session-153 (ISK Phase 5 [666])
"""

import argparse
import json
import logging
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any

try:
    import requests
except ImportError:
    print("ERREUR: pip install requests")
    sys.exit(1)

# ─── Configuration ───────────────────────────────────────────────────────────

PULSE_URL = "http://192.168.2.154:7655"
PULSE_USER = "admin"
PULSE_PASS = os.environ.get("PULSE_PASS", "")

SUPABASE_URL = "http://192.168.2.146:8000/rest/v1"
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

VALIDATE_URL = "http://192.168.2.230:4001/run/validate"
VALIDATE_TOKEN = os.environ.get("BRUCE_AUTH_TOKEN", "")

# LiteLLM (ISK Phase 10 [722]) — localhost sur .230 host (pas 192.168.2.230 via bridge)
LITELLM_URL   = "http://localhost:4100/v1/chat/completions"
LITELLM_MODEL = "alpha"  # [902]
LITELLM_KEY   = "" + os.environ.get("BRUCE_LITELLM_KEY", "") + ""

SESSION_ID = None  # Set dynamically or via --session-id

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    level=logging.INFO,
)
log = logging.getLogger("pulse_sync")


# ─── Helpers ─────────────────────────────────────────────────────────────────

def supabase_headers() -> dict:
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }


def pulse_headers() -> dict:
    return {}

def pulse_auth() -> tuple:
    return (PULSE_USER, PULSE_PASS)


# ─── Step 1: Collect from Pulse API ─────────────────────────────────────────

def fetch_pulse_resources() -> list[dict]:
    """GET /api/resources — full infrastructure state."""
    url = f"{PULSE_URL}/api/resources"
    log.info("Fetching Pulse resources from %s", url)
    resp = requests.get(url, auth=pulse_auth(), timeout=15)
    resp.raise_for_status()
    resources = resp.json().get("resources", [])
    log.info("  → %d resources from Pulse", len(resources))
    return resources


def fetch_pulse_health() -> dict:
    """GET /api/health — Pulse server status."""
    resp = requests.get(f"{PULSE_URL}/api/health", auth=pulse_auth(), timeout=10)
    resp.raise_for_status()
    return resp.json()


# ─── Step 2: Collect from bruce_tools ────────────────────────────────────────

def fetch_bruce_tools() -> list[dict]:
    """GET all bruce_tools entries."""
    url = f"{SUPABASE_URL}/bruce_tools?select=*&order=id"
    log.info("Fetching bruce_tools from Supabase")
    resp = requests.get(url, headers=supabase_headers(), timeout=15)
    resp.raise_for_status()
    tools = resp.json()
    log.info("  → %d entries in bruce_tools", len(tools))
    return tools


# ─── Step 3: Normalize Pulse resources → comparable format ───────────────────

# Mapping Pulse resource type → bruce_tools category
TYPE_CATEGORY_MAP = {
    "node": "infrastructure",
    "vm": "infrastructure",
    "docker-host": "infrastructure",
    "host": "infrastructure",
    "docker-container": "docker_management",
    "storage": "infrastructure",
}

# Mapping Pulse resource type → bruce_tools tool_type
TYPE_TOOLTYPE_MAP = {
    "node": "proxmox_node",
    "vm": "virtual_machine",
    "docker-host": "docker_host",
    "host": "docker_host",
    "docker-container": "docker_container",
    "storage": "proxmox_storage",
}


def normalize_pulse_resource(r: dict) -> dict:
    """Convert a Pulse resource into a bruce_tools-comparable dict.

    Returns a dict with keys matching bruce_tools columns, plus some
    Pulse-specific metadata for diff purposes.
    """
    rtype = r.get("type", "unknown")
    name = r.get("name", "")
    display = r.get("displayName", "") or name
    platform_type = r.get("platformType", "")
    platform_id = r.get("platformId", "")
    pdata = r.get("platformData", {}) or {}

    # Derive IP from identity or platformData
    ip = None
    identity = r.get("identity", {}) or {}
    if identity.get("ips"):
        raw_ip = identity["ips"][0] if identity["ips"] else ""
        ip = raw_ip.split("/")[0] if raw_ip else None

    # Derive host name
    host = display if display != name else name

    # Status mapping
    pulse_status = r.get("status", "unknown")
    status_map = {"running": "active", "online": "active", "stopped": "inactive"}
    status = status_map.get(pulse_status, "unknown")

    return {
        "_pulse_id": r.get("id", ""),
        "_pulse_type": rtype,
        "_pulse_status": pulse_status,
        "_pulse_parent": r.get("parentId", ""),
        "name": name,
        "display_name": display,
        "host": host,
        "ip": ip,
        "status": status,
        "category": TYPE_CATEGORY_MAP.get(rtype, "misc"),
        "tool_type": TYPE_TOOLTYPE_MAP.get(rtype, rtype),
        "platform_type": platform_type,
        "platform_id": platform_id,
        # Metrics snapshot
        "cpu_pct": round(r.get("cpu", {}).get("current", 0), 1),
        "mem_pct": round(r.get("memory", {}).get("current", 0), 1),
        "uptime": r.get("uptime", 0),
        # Docker-specific
        "image": pdata.get("image", None),
        "docker_status": pdata.get("status", None),
        "agent_version": pdata.get("agentVersion", None),
        "os": pdata.get("osName") or pdata.get("os", None),
    }



# ─── Step 3.5: Enrich misc/unknown resources via LLM (ISK Phase 10 [722]) ────

def enrich_with_llm(normalized: list[dict], max_llm: int = 10, dry_run: bool = False) -> list[dict]:
    """Enrichit les resources category=misc ou tool_type non mappe via LiteLLM Qwen.

    Injecte {category, tool_type, _llm_role, _llm_description} dans les dicts
    normalises AVANT le diff, pour que les staging entries soient deja enrichies.
    Fallback gracieux: si LiteLLM down, garde misc + flag needs_categorization=True.
    Max max_llm appels LLM/run (defaut 10).
    """
    llm_calls = 0
    enriched  = 0

    for r in normalized:
        # Cible: category=misc OU tool_type non mappe (= rtype brut comme fallback)
        is_misc              = r.get("category") == "misc"
        is_unmapped          = r.get("tool_type") == r.get("_pulse_type")
        # Docker containers: enrichir via image name (ex: grafana/grafana -> monitoring)
        is_docker_with_image = (r.get("_pulse_type") == "docker-container"
                                and bool(r.get("image")))
        if not (is_misc or is_unmapped or is_docker_with_image):
            continue

        if llm_calls >= max_llm:
            r["needs_categorization"] = True
            continue

        name  = r.get("name", "")
        rtype = r.get("_pulse_type", "")
        image = r.get("image") or ""
        ip    = r.get("ip") or ""
        os_   = r.get("os") or ""

        prompt = (
            "Tu categorises une ressource homelab pour une base de connaissance.\n"
            f"Nom: {name} | Type: {rtype} | Image Docker: {image} | IP: {ip} | OS: {os_}\n\n"
            "Reponds UNIQUEMENT en JSON (sans texte avant/apres):\n"
            '{"category":"infrastructure|monitoring|automation|media|docs|security|storage|misc",'
            '"tool_type":"string court descriptif","role":"role applicatif 1 ligne",'
            '"description_courte":"description max 20 mots"}'
        )

        llm_calls += 1

        if dry_run:
            log.debug("  [ENRICH DRY] would enrich: %s (%s)", name, rtype)
            continue

        try:
            resp = requests.post(
                LITELLM_URL,
                headers={"Authorization": f"Bearer {LITELLM_KEY}"},
                json={
                    "model": LITELLM_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 150,
                    "temperature": 0.1,
                },
                timeout=20,
            )
            if not resp.ok:
                log.warning("  [ENRICH] LiteLLM HTTP %s -> needs_categorization", resp.status_code)
                r["needs_categorization"] = True
                continue

            content = resp.json()["choices"][0]["message"]["content"].strip()
            m = re.search(r"\{[^{}]+\}", content, re.DOTALL)
            if not m:
                raise ValueError(f"No JSON in response: {content[:80]}")

            result = json.loads(m.group())
            r["category"]         = result.get("category", r["category"])
            r["tool_type"]        = result.get("tool_type", r["tool_type"])
            r["_llm_role"]        = result.get("role", "")
            r["_llm_description"] = result.get("description_courte", "")
            r["_llm_enriched"]    = True
            enriched += 1
            log.info(
                "  [ENRICH] %s -> cat=%s type=%s | %s",
                name, r["category"], r["tool_type"], r["_llm_role"]
            )

        except Exception as e:
            log.warning("  [ENRICH] LiteLLM error (%s) -> fallback misc + needs_categorization", e)
            r["needs_categorization"] = True

    log.info(
        "Enrichment done: %d enriched, %d LLM calls (max=%d)",
        enriched, llm_calls, max_llm,
    )
    return normalized

# ─── Step 4: Diff — compare Pulse vs bruce_tools ────────────────────────────

def build_bruce_tools_index(tools: list[dict]) -> dict:
    """Index bruce_tools by (name, ip) and by name alone for matching."""
    by_name = {}
    by_ip = {}
    for t in tools:
        n = (t.get("name") or "").lower().strip()
        if n:
            by_name.setdefault(n, []).append(t)
        ip = (t.get("ip") or "").strip()
        if ip:
            by_ip.setdefault(ip, []).append(t)
    return {"by_name": by_name, "by_ip": by_ip}


def build_bruce_tools_host_index(tools: list[dict]) -> dict:
    """Index bruce_tools by host column (lowercase)."""
    by_host = {}
    for t in tools:
        h = (t.get("host") or "").lower().strip()
        if h:
            by_host.setdefault(h, []).append(t)
    return by_host


# Known aliases: Pulse name → bruce_tools name or host
PULSE_NAME_ALIASES = {
    "promox-box": "proxmox-box1",      # Pulse typo in Proxmox hostname
    "pve": "proxmox-box2",              # Proxmox Box2 node name
    "furymcp": "mcp-gateway",            # Docker host on .230
    "rotki": "rotki",                    # VM111 Box1
    "supabase-vm": "_SKIP_",            # Old .206 VM (stopped) — not a real service
}


def match_pulse_to_bruce(normalized: dict, index: dict, host_index: dict) -> dict | None:
    """Try to find the matching bruce_tools entry for a Pulse resource.

    Matching strategy (ordered by specificity):
    1. Known aliases
    2. Exact name match (lowercase)
    3. Host column match (bruce_tools.host == pulse.name)
    4. IP match (skip Docker-internal 172.17.x.x)
    5. Display name / platformId match
    """
    name = (normalized.get("name") or "").lower().strip()
    display = (normalized.get("display_name") or "").lower().strip()
    ip = (normalized.get("ip") or "").strip()
    pulse_type = normalized.get("_pulse_type", "")

    # Skip Docker-internal IPs for matching (they're useless)
    if ip and ip.startswith("172."):
        ip = ""

    # 1. Known aliases
    alias = PULSE_NAME_ALIASES.get(name, "").lower()
    if alias == "_skip_":
        return {"id": -1, "name": "_SKIPPED_", "status": "inactive"}  # Sentinel
    if alias and alias in index["by_name"]:
        return index["by_name"][alias][0]

    # 2. Exact name match
    if name in index["by_name"]:
        candidates = index["by_name"][name]
        if len(candidates) == 1:
            return candidates[0]
        if ip:
            for c in candidates:
                if (c.get("ip") or "") == ip:
                    return c
        return candidates[0]

    # 3. Host column match (bruce_tools entries where host=pulse_name)
    if name in host_index:
        candidates = host_index[name]
        # For VMs/hosts, match any entry on that host
        if len(candidates) >= 1:
            return candidates[0]

    # 4. IP match (only real IPs)
    if ip and ip in index["by_ip"]:
        candidates = index["by_ip"][ip]
        if len(candidates) == 1:
            return candidates[0]
        host = (normalized.get("host") or "").lower()
        for c in candidates:
            if (c.get("host") or "").lower() == host:
                return c

    # 5. Display name match
    if display and display != name and display in index["by_name"]:
        return index["by_name"][display][0]

    return None


def compute_diff(pulse_resources: list[dict], bruce_tools: list[dict]) -> dict:
    """Compare Pulse state vs bruce_tools.

    Returns:
        {
            "new": [...],        # In Pulse but not in bruce_tools
            "ghosts": [...],     # In bruce_tools (infra) but not in Pulse
            "modified": [...],   # Status mismatch
            "matched": [...],    # OK, in sync
            "stats": {...}       # Summary
        }
    """
    index = build_bruce_tools_index(bruce_tools)
    host_index = build_bruce_tools_host_index(bruce_tools)

    new_items = []
    modified = []
    matched = []
    seen_bruce_ids = set()

    # Filter: only sync infra-relevant Pulse resources (skip storage)
    sync_types = {"node", "vm", "docker-host", "host", "docker-container"}

    for r in pulse_resources:
        if r["_pulse_type"] not in sync_types:
            continue

        bt = match_pulse_to_bruce(r, index, host_index)
        if bt is None:
            new_items.append(r)
        else:
            seen_bruce_ids.add(bt["id"])
            # Check for status mismatch
            pulse_st = r["status"]
            bruce_st = (bt.get("status") or "").lower()
            if pulse_st != bruce_st and pulse_st != "unknown":
                modified.append({
                    "pulse": r,
                    "bruce": bt,
                    "diff_type": "status",
                    "pulse_status": pulse_st,
                    "bruce_status": bruce_st,
                })
            else:
                matched.append({"pulse": r, "bruce": bt})

    # Ghost detection: bruce_tools infra entries not seen in Pulse
    infra_categories = {
        "infrastructure", "monitoring", "docker_management",
        "observability", "core", "automation", "media", "docs",
        "network", "security", "backup", "gateway",
    }
    ghosts = []
    for bt in bruce_tools:
        cat = (bt.get("category") or "").lower()
        ip = bt.get("ip") or ""
        if bt["id"] not in seen_bruce_ids and cat in infra_categories and ip:
            # Only flag as ghost if it has an IP (real service)
            ghosts.append(bt)

    return {
        "new": new_items,
        "ghosts": ghosts,
        "modified": modified,
        "matched": matched,
        "stats": {
            "pulse_total": len(pulse_resources),
            "pulse_synced": len([r for r in pulse_resources if r["_pulse_type"] in sync_types]),
            "bruce_tools_total": len(bruce_tools),
            "new": len(new_items),
            "ghosts": len(ghosts),
            "modified": len(modified),
            "matched": len(matched),
        },
    }


# ─── Step 5: Push divergences into staging_queue ─────────────────────────────

def push_to_staging(entry: dict) -> dict | None:
    """Insert one entry into staging_queue via Supabase REST."""
    url = f"{SUPABASE_URL}/staging_queue"
    headers = supabase_headers()
    headers["Prefer"] = "return=representation"
    resp = requests.post(url, json=entry, headers=headers, timeout=10)
    if resp.status_code in (200, 201):
        return resp.json()
    log.error("  staging push failed: %s %s", resp.status_code, resp.text[:200])
    return None


def trigger_validate() -> bool:
    """POST to validate_service to process pending staging."""
    try:
        resp = requests.post(
            VALIDATE_URL,
            headers={"X-BRUCE-TOKEN": VALIDATE_TOKEN},
            timeout=30,
        )
        data = resp.json()
        log.info("  validate: %s", data.get("validate", {}).get("stdout", "")[:120])
        return data.get("ok", False)
    except Exception as e:
        log.error("  validate failed: %s", e)
        return False


def build_staging_entry_new_resource(r: dict) -> dict:
    """Create a staging_queue entry for a NEW resource discovered by Pulse."""
    description_parts = [
        f"Decouvert par pulse_sync.py via Pulse API.",
        f"Type: {r['_pulse_type']} | Platform: {r['platform_type']}",
        f"Status: {r['_pulse_status']}",
    ]
    if r.get("image"):
        description_parts.append(f"Image: {r['image']}")
    if r.get("os"):
        description_parts.append(f"OS: {r['os']}")
    if r.get("agent_version"):
        description_parts.append(f"Agent: {r['agent_version']}")

    return {
        "table_cible": "lessons_learned",
        "contenu_json": {
            "lesson_type": "discovery",
            "lesson_text": (
                f"PULSE_SYNC NEW RESOURCE: {r['name']} "
                f"(type={r['_pulse_type']}, host={r.get('host','?')}, "
                f"ip={r.get('ip','?')}, status={r['_pulse_status']}). "
                f"{' '.join(description_parts)} "
                f"Non present dans bruce_tools. A enregistrer."
            ),
            "importance": "normal",
            "confidence_score": 0.9,
            "session_id": SESSION_ID,
            "project_scope": "homelab",
        },
        "status": "pending",
        "project_scope": "homelab",
        "data_family": "proposals",
    }


def build_staging_entry_status_change(item: dict) -> dict:
    """Create a staging_queue entry for a STATUS MISMATCH."""
    p = item["pulse"]
    b = item["bruce"]
    return {
        "table_cible": "lessons_learned",
        "contenu_json": {
            "lesson_type": "discovery",
            "lesson_text": (
                f"PULSE_SYNC STATUS MISMATCH: {b['name']} (bruce_tools id={b['id']}) "
                f"bruce_status={item['bruce_status']} vs pulse_status={item['pulse_status']}. "
                f"Pulse voit {p['_pulse_status']}, bruce_tools dit {b.get('status','')}. "
                f"Verifier et mettre a jour bruce_tools."
            ),
            "importance": "normal",
            "confidence_score": 0.85,
            "session_id": SESSION_ID,
            "project_scope": "homelab",
        },
        "status": "pending",
        "project_scope": "homelab",
        "data_family": "proposals",
    }


def build_staging_entry_ghost(bt: dict) -> dict:
    """Create a staging_queue entry for a GHOST (in bruce_tools but not in Pulse)."""
    return {
        "table_cible": "lessons_learned",
        "contenu_json": {
            "lesson_type": "diagnostic",
            "lesson_text": (
                f"PULSE_SYNC GHOST: {bt['name']} (bruce_tools id={bt['id']}, "
                f"ip={bt.get('ip','?')}, category={bt.get('category','?')}) "
                f"est dans bruce_tools mais INVISIBLE dans Pulse. "
                f"Causes possibles: machine eteinte, agent absent, "
                f"pas un service Docker/Proxmox, ou entree obsolete."
            ),
            "importance": "normal",
            "confidence_score": 0.7,
            "session_id": SESSION_ID,
            "project_scope": "homelab",
        },
        "status": "pending",
        "project_scope": "homelab",
        "data_family": "proposals",
    }


# ─── Step 6: Report ─────────────────────────────────────────────────────────

def format_report(diff: dict, pushed: int) -> str:
    """Human-readable report."""
    s = diff["stats"]
    lines = [
        "=" * 60,
        "  PULSE_SYNC REPORT",
        f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}",
        "=" * 60,
        "",
        f"  Pulse resources:   {s['pulse_total']} total, {s['pulse_synced']} synced types",
        f"  bruce_tools:       {s['bruce_tools_total']} entries",
        "",
        f"  [OK] Matched:        {s['matched']}",
        f"  [NEW] New (Pulse only): {s['new']}",
        f"  [GHOST] Ghosts (bruce only): {s['ghosts']}",
        f"  [DIFF] Status mismatch: {s['modified']}",
        "",
        f"  [PUSH] Pushed to staging: {pushed}",
        "",
    ]

    if diff["new"]:
        lines.append("--- NEW RESOURCES ---")
        for r in diff["new"]:
            lines.append(
                f"  + {r['name']} ({r['_pulse_type']}) "
                f"host={r.get('host','?')} ip={r.get('ip','?')} "
                f"status={r['_pulse_status']}"
            )
        lines.append("")

    if diff["modified"]:
        lines.append("--- STATUS MISMATCHES ---")
        for m in diff["modified"]:
            lines.append(
                f"  ! {m['bruce']['name']} (id={m['bruce']['id']}): "
                f"bruce={m['bruce_status']} -> pulse={m['pulse_status']}"
            )
        lines.append("")

    if diff["ghosts"]:
        lines.append("--- GHOSTS (bruce_tools without Pulse match) ---")
        for g in diff["ghosts"]:
            lines.append(
                f"  ? {g['name']} (id={g['id']}) "
                f"ip={g.get('ip','?')} cat={g.get('category','?')}"
            )
        lines.append("")

    return "\n".join(lines)


def json_report(diff: dict, pushed: int) -> dict:
    """Machine-readable report."""
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "stats": diff["stats"],
        "pushed_to_staging": pushed,
        "new": [
            {"name": r["name"], "type": r["_pulse_type"], "ip": r.get("ip"),
             "host": r.get("host"), "status": r["_pulse_status"]}
            for r in diff["new"]
        ],
        "modified": [
            {"name": m["bruce"]["name"], "bruce_id": m["bruce"]["id"],
             "bruce_status": m["bruce_status"], "pulse_status": m["pulse_status"]}
            for m in diff["modified"]
        ],
        "ghosts": [
            {"name": g["name"], "bruce_id": g["id"], "ip": g.get("ip"),
             "category": g.get("category")}
            for g in diff["ghosts"]
        ],
    }


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    global SESSION_ID

    parser = argparse.ArgumentParser(description="pulse_sync.py — Sync Pulse → bruce_tools")
    parser.add_argument("--dry-run", action="store_true", help="Don't push to staging")
    parser.add_argument("--verbose", "-v", action="store_true", help="Debug output")
    parser.add_argument("--json", action="store_true", help="JSON output instead of text")
    parser.add_argument("--enrich", action="store_true", default=True,
                        dest="enrich", help="Enrichir resources misc via LLM (defaut ON)")
    parser.add_argument("--no-enrich", action="store_false", dest="enrich",
                        help="Desactive enrichissement LLM")
    parser.add_argument("--max-llm", type=int, default=10,
                        help="Max appels LLM enrichissement par run (defaut 10)")
    parser.add_argument("--session-id", type=int, default=None, help="Session ID for lessons")
    args = parser.parse_args()

    if args.verbose:
        log.setLevel(logging.DEBUG)

    SESSION_ID = args.session_id

    t0 = time.time()

    # ── 1. Health check ──
    try:
        health = fetch_pulse_health()
        log.info("Pulse healthy (uptime=%ds)", health.get("uptime", 0))
    except Exception as e:
        log.error("Pulse unreachable: %s", e)
        sys.exit(1)

    # ── 2. Collect ──
    try:
        raw_resources = fetch_pulse_resources()
    except Exception as e:
        log.error("Failed to fetch Pulse resources: %s", e)
        sys.exit(1)

    try:
        bruce_tools = fetch_bruce_tools()
    except Exception as e:
        log.error("Failed to fetch bruce_tools: %s", e)
        sys.exit(1)

    # ── 3. Normalize ──
    normalized = [normalize_pulse_resource(r) for r in raw_resources]
    log.info("Normalized %d resources", len(normalized))

    # ── 3.5. Enrich misc/unknown via LLM (ISK Phase 10) ──
    if args.enrich:
        normalized = enrich_with_llm(
            normalized, max_llm=args.max_llm, dry_run=args.dry_run
        )

    # ── 4. Diff ──
    diff = compute_diff(normalized, bruce_tools)
    log.info(
        "Diff: %d new, %d ghosts, %d modified, %d matched",
        diff["stats"]["new"],
        diff["stats"]["ghosts"],
        diff["stats"]["modified"],
        diff["stats"]["matched"],
    )

    # ── 5. Push to staging ──
    pushed = 0
    if not args.dry_run:
        # Push new resources
        for r in diff["new"]:
            entry = build_staging_entry_new_resource(r)
            result = push_to_staging(entry)
            if result:
                pushed += 1
                log.debug("  pushed new: %s", r["name"])

        # Push status mismatches
        for m in diff["modified"]:
            entry = build_staging_entry_status_change(m)
            result = push_to_staging(entry)
            if result:
                pushed += 1
                log.debug("  pushed modified: %s", m["bruce"]["name"])

        # Push ghosts (limit to first 10 to avoid flooding)
        ghost_limit = min(len(diff["ghosts"]), 10)
        for g in diff["ghosts"][:ghost_limit]:
            entry = build_staging_entry_ghost(g)
            result = push_to_staging(entry)
            if result:
                pushed += 1
                log.debug("  pushed ghost: %s", g["name"])

        if pushed > 0:
            log.info("Triggering validate_service...")
            trigger_validate()
    else:
        log.info("DRY-RUN: would push %d new + %d modified + %d ghosts",
                 diff["stats"]["new"], diff["stats"]["modified"],
                 min(diff["stats"]["ghosts"], 10))

    elapsed = time.time() - t0

    # ── 6. Report ──
    if args.json:
        report = json_report(diff, pushed)
        report["elapsed_s"] = round(elapsed, 2)
        report["dry_run"] = args.dry_run
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(format_report(diff, pushed))
        print(f"  Elapsed: {elapsed:.1f}s")
        if args.dry_run:
            print("  DRY-RUN mode -- nothing pushed")

    return 0 if diff["stats"]["new"] == 0 and diff["stats"]["modified"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
