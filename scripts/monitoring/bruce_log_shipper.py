#!/usr/bin/env python3
import os
"""
bruce_log_shipper.py - Envoie les logs Docker de .230 vers Vector:9880
Containers ciblés: mcp-gateway, validate_service, et autres containers BRUCE
Cron: */5 * * * * (toutes les 5 min)
"""

import subprocess, requests, json, time, os
from datetime import datetime, timezone

VECTOR_URL = "http://192.168.2.154:9880/logs"
SUPABASE_URL = "http://192.168.2.146:8000/rest/v1"
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

# Containers à surveiller sur .230
TARGET_CONTAINERS = ["mcp-gateway", "supabase-db", "supabase-rest", "supabase-kong"]
# Mots-clés erreur pour events_log
ERROR_KEYWORDS = ["error", "err", "fatal", "exception", "traceback", "failed", "crash"]

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json"
}

def get_container_logs(container, since="5m"):
    """Récupère les logs d'un container des N dernières minutes."""
    try:
        r = subprocess.run(
            ["docker", "logs", "--since", since, "--tail", "50", container],
            capture_output=True, text=True, timeout=10
        )
        lines = (r.stdout + r.stderr).strip().split('\n')
        return [l for l in lines if l.strip()]
    except Exception as e:
        return []

def push_to_vector(container, lines, host=".230-mcp-gateway"):
    """Envoie les logs vers Vector HTTP push."""
    if not lines:
        return 0
    payload = []
    for line in lines:
        payload.append({
            "message": line,
            "labels": {
                "container": container,
                "host": "mcp-gateway-host",
                "source": "bruce_shipper",
                "service_name": container
            },
            "timestamp": datetime.now(timezone.utc).isoformat()
        })
    try:
        r = requests.post(VECTOR_URL, json=payload, timeout=5)
        return len(payload) if r.status_code < 300 else 0
    except Exception as e:
        print(f"  Vector push err ({container}): {e}")
        return 0

def log_error_to_supabase(container, message):
    """Enregistre les erreurs critiques dans events_log."""
    try:
        requests.post(f"{SUPABASE_URL}/events_log", headers=HEADERS, json={
            "event_type": "container_error",
            "source_table": "logs",
            "payload": {"container": container, "message": message[:500], "host": "192.168.2.230"},
            "created_by": "bruce_log_shipper",
            "data_family": "observed"
        }, timeout=5)
    except:
        pass

def main():
    print(f"[{datetime.now().strftime('%H:%M:%S')}] bruce_log_shipper - scan containers .230")
    total_shipped = 0
    errors_found = 0

    for container in TARGET_CONTAINERS:
        lines = get_container_logs(container, since="5m")
        if not lines:
            continue

        # Détection erreurs
        for line in lines:
            if any(kw in line.lower() for kw in ERROR_KEYWORDS):
                errors_found += 1
                log_error_to_supabase(container, line)

        n = push_to_vector(container, lines)
        if n:
            print(f"  {container}: {n} lignes -> Vector")
            total_shipped += n

    print(f"  Total: {total_shipped} lignes shippées, {errors_found} erreurs détectées")

if __name__ == "__main__":
    main()
