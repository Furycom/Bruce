#!/usr/bin/env python3
"""
bruce_docker_collect_local.py

Phase C — 3.1 : Collecteur Docker (sous-étape 1 + 2)

- Liste les conteneurs actifs via `docker ps --format '{{json .}}'`
- Récupère les détails via `docker inspect --format '{{json .}}' <ID>`
- Écrit un snapshot JSON normalisé dans:  ~/docker_snapshots/docker_ps_<hostname>.json

IMPORTANT:
- Aucun chemin hardcodé /home/yann. On utilise le HOME de l'utilisateur courant.
"""

import datetime
import json
import os
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List


def run_cmd(cmd: List[str]) -> str:
    """Exécute une commande et renvoie stdout, sinon quitte avec stderr."""
    try:
        result = subprocess.run(
            cmd,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return result.stdout
    except subprocess.CalledProcessError as exc:
        print(f"[ERROR] Command failed: {' '.join(cmd)}", file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        sys.exit(1)


def collect_docker_ps() -> List[Dict[str, Any]]:
    """Parse `docker ps --format '{{json .}}'` (1 ligne JSON par conteneur)."""
    out = run_cmd(["docker", "ps", "--format", "{{json .}}"])
    rows: List[Dict[str, Any]] = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append({"_raw": line, "_parse_error": True})
    return rows


def collect_docker_inspect(container_ids: List[str]) -> List[Dict[str, Any]]:
    """Exécute `docker inspect` par conteneur (format JSON)."""
    inspections: List[Dict[str, Any]] = []
    for cid in container_ids:
        cid = cid.strip()
        if not cid:
            continue
        out = run_cmd(["docker", "inspect", "--format", "{{json .}}", cid])
        out = out.strip()
        try:
            inspections.append(json.loads(out))
        except json.JSONDecodeError:
            inspections.append({"id": cid, "_raw": out, "_parse_error": True})
    return inspections


def main() -> None:
    hostname = socket.gethostname()
    observed_at = datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

    home = Path.home()
    out_dir = home / "docker_snapshots"
    out_dir.mkdir(parents=True, exist_ok=True)

    outfile = out_dir / f"docker_ps_{hostname}.json"

    # Vérifier que docker existe
    if not shutil_which("docker"):
        print("[ERROR] docker binary not found in PATH", file=sys.stderr)
        sys.exit(2)

    docker_ps = collect_docker_ps()
    container_ids = [row.get("ID", "") for row in docker_ps if isinstance(row, dict)]
    docker_inspect = collect_docker_inspect([cid for cid in container_ids if cid])

    payload = {
        "hostname": hostname,
        "source": "docker",
        "observed_at": observed_at,
        "snapshot": {
            "docker_ps": docker_ps,
            "docker_inspect": docker_inspect,
        },
    }

    with open(outfile, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    print(f"[OK] Docker snapshot written to {outfile}")
    print()
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def shutil_which(cmd: str) -> str:
    # mini-which sans importer shutil (pour rester minimaliste)
    paths = os.environ.get("PATH", "").split(os.pathsep)
    for p in paths:
        candidate = Path(p) / cmd
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return ""


if __name__ == "__main__":
    main()
