#!/usr/bin/env python3
"""Migrate claude.md content to Supabase KB entries via staging_queue.

This script creates ~25 knowledge_base entries from the content currently
in claude.md (anti-patterns, runbooks, infrastructure, etc.) so that
claude.md can be reduced to a minimal index.

Part of the 5-tier context layer architecture [999].
"""

import time
import argparse
import json
import sys
import urllib.error
import urllib.request

GATEWAY = "http://192.168.2.230:4000"
REST_BASE = "http://192.168.2.146:8000/rest/v1"
TOKEN = "bruce-secret-token-01"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}
REST_HEADERS = {
    "apikey": TOKEN,
    "Authorization": f"Bearer {TOKEN}",
}


def post_json(url, payload, headers, timeout, max_retries):
    """POST JSON payload with retry/backoff."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")

    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body), None
        except Exception as exc:  # noqa: BLE001
            err = exc
            if attempt < max_retries:
                sleep_s = min(2.0 * attempt, 6.0)
                print(f"    retry {attempt}/{max_retries - 1} in {sleep_s:.1f}s ({exc})")
                time.sleep(sleep_s)
            else:
                return None, err


def get_json(url, headers, timeout):
    """GET JSON payload."""
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def submit_to_staging(question, answer, category, subcategory, tags, note, timeout, max_retries):
    """Submit a KB entry via staging_queue through /bruce/write."""
    inner = json.dumps({
        "question": question,
        "answer": answer,
        "category": category,
        "subcategory": subcategory,
        "tags": tags,
        "confidence_score": 1.0,
        "author_system": "claude",
        "project_scope": "homelab",
        "tag_domain": "bruce",
    })
    payload = json.dumps({
        "table_cible": "staging_queue",
        "contenu_json": json.dumps({
            "table_cible": "knowledge_base",
            "contenu_json": inner,
            "author_system": "claude",
            "notes": note,
        }),
        "author_system": "claude",
        "notes": note,
    })
    result, err = post_json(
        f"{GATEWAY}/bruce/write",
        payload,
        HEADERS,
        timeout=timeout,
        max_retries=max_retries,
    )
    if err is not None:
        print(f"  ERROR: {err}")
        return None
    return result


def trigger_staging_validation(timeout, max_retries):
    """Trigger /bruce/staging/validate once submissions are complete."""
    result, err = post_json(
        f"{GATEWAY}/bruce/staging/validate",
        {},
        HEADERS,
        timeout=timeout,
        max_retries=max_retries,
    )
    if err is not None:
        print(f"Validation ERROR: {err}")
        return False
    print(f"Validation response: {result}")
    return True


def verify_kb_ingestion(timeout):
    """Verify anti-pattern records are queryable in knowledge_base via REST."""
    url = f"{REST_BASE}/knowledge_base?subcategory=eq.anti-patterns&select=id,question,subcategory"
    try:
        rows = get_json(url, REST_HEADERS, timeout=timeout)
        print(f"Verification: found {len(rows)} anti-pattern rows in knowledge_base.")
        if rows:
            print(f"  sample: {rows[0].get('id')} - {rows[0].get('question')}")
        return True
    except Exception as exc:  # noqa: BLE001
        print(f"Verification ERROR: {exc}")
        return False


# ── KB entries to create ──
ENTRIES = [
    # --- ANTI-PATTERNS (16 rules from claude.md) ---
    {
        "question": "Anti-pattern: SSH inline dans PowerShell",
        "answer": "JAMAIS de SSH inline dans Invoke-RestMethod ou interpolation PowerShell. SSH DOIT utiliser Start-Job + Wait-Job -Timeout 25. Violation = shell bloque indefiniment, session perdue. Pattern correct: $job = Start-Job { param($k,$h,$c,$o) & ssh -T -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes -i $k $h $c 2>&1 | Out-File $o } -ArgumentList $key, $host, $cmd, $outfile; Wait-Job $job -Timeout 25",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["ssh", "powershell", "anti-pattern", "bloquant"],
    },
    {
        "question": "Anti-pattern: SSH pour lire la cle Supabase",
        "answer": "JAMAIS de SSH pour la cle Supabase. Elle est stockee localement: $script:SUPA_KEY = (Get-Content 'C:\\Users\\Administrator\\.ssh\\supabase_key.txt' -Raw).Trim(). Aussi sur .230: /home/furycom/bruce-config/supabase_key_local.txt. Headers REST: apikey + Authorization Bearer + Content-Type application/json. Endpoint: http://192.168.2.146:8000/rest/v1/<table>",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["supabase", "cle", "anti-pattern", "ssh"],
    },
    {
        "question": "Anti-pattern: requetes inutiles apres bootstrap",
        "answer": "Si bootstrap retourne les infos suffisantes, NE PAS aller chercher plus. Le bootstrap inclut RAG, taches, lecons, dashboard, etat. Ne pas refaire de requetes KB/REST sauf besoin explicite pendant le travail.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["bootstrap", "anti-pattern", "tokens"],
    },
    {
        "question": "Anti-pattern: timeout mental 15 secondes",
        "answer": "Timeout mental 15s: si un appel PowerShell prend >15s, KILL immediatement et pivoter. Ne JAMAIS faire 3x wait_for_completion sur un shell bloque.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["timeout", "powershell", "anti-pattern"],
    },
    {
        "question": "Anti-pattern: chainer scp et ssh",
        "answer": "JAMAIS chainer scp + ssh dans le meme invoke_expression. Separer en 2 appels distincts.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["scp", "ssh", "anti-pattern"],
    },
    {
        "question": "Anti-pattern: scope variables PowerShell",
        "answer": "Toujours $script: scope pour les variables PowerShell reutilisees entre appels MCP. Sans $script:, la variable est perdue entre deux appels invoke_expression.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["powershell", "scope", "anti-pattern"],
    },
    {
        "question": "Anti-pattern: tatonnement sans KB",
        "answer": "KB avant tatonnement: avant d essayer un endpoint/schema, chercher dans la KB avec semantic_search. La reponse y est probablement deja. Aussi: avant action technique, faire semantic_search_advanced('bruce_tools [description]', top_k=3). Si outil pertinent score > 0.6, l UTILISER.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["kb", "semantic-search", "anti-pattern"],
    },
    {
        "question": "Anti-pattern: diagnostic sans MCP-first",
        "answer": "MCP-first pour tout diagnostic infra. ORDRE: (1) Prometheus MCP pour metriques RAM/CPU/disque/targets, (2) Grafana MCP pour logs Loki + alertes, (3) Docker MCP pour containers, (4) Proxmox MCP pour VMs Box2, (5) Pulse GET .154:7655/api/resources (auth Basic admin:bruce-pulse-2026), (6) SSH seulement si les 5 precedents ne suffisent pas. POST [997] /bruce/health/full remplace les 5 premiers pour diagnostic de base.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["mcp", "diagnostic", "anti-pattern", "prometheus", "grafana"],
    },
    {
        "question": "Anti-pattern: cycle toxique creation taches",
        "answer": "STOP cycle toxique: NE PAS creer de nouvelles taches sauf si bloquant immediat. Le reflexe decouvrir -> creer tache -> grossir roadmap est le probleme #1 de BRUCE. Resoudre les racines existantes AVANT d en ajouter. Ne pas normaliser les frictions de Yann: si Yann signale un probleme recurrent, le traiter comme prioritaire.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["roadmap", "cycle-toxique", "anti-pattern"],
    },
    {
        "question": "Anti-pattern: SQL sans ConvertTo-Json",
        "answer": "SQL: TOUJOURS ConvertTo-Json pour construire le body SQL. Pattern: $body = @{ sql = 'SELECT ... WHERE col = value' } | ConvertTo-Json -Compress. JAMAIS de JSON manuel avec quotes imbriquees. exec-sql ne supporte pas UNION ALL, sous-requetes correlees, multi-statements. UNE requete simple a la fois.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["sql", "powershell", "anti-pattern", "convertto-json"],
    },
    {
        "question": "Anti-pattern: Supabase sur mauvaise machine",
        "answer": "Supabase est sur .146, JAMAIS .230. Le container supabase-db est sur furysupa (.146). Ne JAMAIS tenter docker exec supabase-db sur .230. Pour SQL DDL/DML: utiliser gateway /tools/supabase/exec-sql. Pour lecture: PostgreSQL MCP (port 5433) ou REST API .146:8000.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["supabase", "146", "anti-pattern"],
    },
    {
        "question": "Anti-pattern: SSH sans contexte prealable",
        "answer": "CONTEXTE D ABORD, SSH ENSUITE. Avant TOUT appel SSH, RELIRE le contexte deja charge (Memory MCP, handoff, bootstrap) pour identifier: (1) sur quelle MACHINE le process tourne, (2) quel FICHIER LOG consulter, (3) quel PID ou nom de process chercher. UN SEUL appel SSH cible. JAMAIS tatonner sur plusieurs machines.",
        "category": "governance",
        "subcategory": "anti-patterns",
        "tags": ["ssh", "contexte", "anti-pattern", "machine"],
    },

    # --- RUNBOOKS ---
    {
        "question": "Comment transferer un fichier vers .230?",
        "answer": "METHODE UNIQUE: POST /bruce/file/write. $h = @{ 'Authorization'='Bearer bruce-secret-token-01'; 'Content-Type'='application/json' }; $body = @{ filepath='/home/furycom/DESTINATION/fichier.txt'; content='CONTENU' } | ConvertTo-Json; Invoke-RestMethod -Uri 'http://192.168.2.230:4000/bruce/file/write' -Headers $h -Method POST -Body $body. Paths autorises: /home/furycom/ (inbox, uploads, bruce-config, mcp-stack, workdir). Options: mode='append', backup=true. FALLBACK si endpoint DOWN: Write local + SCP 2 etapes. CE QUI NE MARCHE PAS: Base64 en SSH, heredoc SSH inline, tarball PowerShell, chunks base64.",
        "category": "runbook",
        "subcategory": "file-transfer",
        "tags": ["transfert", "fichier", "scp", "file-write"],
    },
    {
        "question": "Pattern SSH PowerShell correct pour BRUCE",
        "answer": "Pattern SSH: $key = 'C:\\Users\\Administrator\\.ssh\\homelab_key'; $job = Start-Job { param($k,$h,$c,$o) & ssh -T -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes -i $k $h $c 2>&1 | Out-File $o -Encoding UTF8 } -ArgumentList $key, 'furycom@192.168.2.230', 'COMMANDE', \"$env:TEMP\\ssh_out.txt\"; Wait-Job $job -Timeout 25 | Out-Null; Get-Content \"$env:TEMP\\ssh_out.txt\". IMPORTANT: Pour SSH, preferer Desktop Commander start_process au lieu de Windows-MCP PowerShell (PowerShell intercepte -o et interpole $variables bash).",
        "category": "runbook",
        "subcategory": "ssh-pattern",
        "tags": ["ssh", "powershell", "pattern", "start-job"],
    },
    {
        "question": "Procedure chargement cle Supabase et headers REST",
        "answer": "Cle service_role stockee localement: $script:SUPA_KEY = (Get-Content 'C:\\Users\\Administrator\\.ssh\\supabase_key.txt' -Raw).Trim(). Headers: $script:SUPA_H = @{ 'apikey'=$script:SUPA_KEY; 'Authorization'='Bearer '+$script:SUPA_KEY; 'Content-Type'='application/json' }. Endpoint REST: http://192.168.2.146:8000/rest/v1/<table>. JAMAIS SSH pour lire cette cle.",
        "category": "runbook",
        "subcategory": "supabase-auth",
        "tags": ["supabase", "cle", "auth", "headers"],
    },
    {
        "question": "Fallback si gateway BRUCE est down",
        "answer": "Si gateway .230:4000 down: (1) REST direct vers .146:8000 avec cle service_role. Taches: /rest/v1/roadmap?status=in.(todo,doing). Lecons: /rest/v1/lessons_learned?importance=eq.critical&limit=10. Session: /rest/v1/session_history?order=id.desc&limit=1. (2) MCP semantic search fonctionne independamment. (3) SSH .230 si Supabase aussi down: docker ps, docker logs bruce-gateway.",
        "category": "runbook",
        "subcategory": "fallback",
        "tags": ["fallback", "gateway", "supabase"],
    },

    # --- INFRASTRUCTURE ---
    {
        "question": "Carte reseau machines homelab BRUCE (IPs et roles)",
        "answer": "Supabase PRIMAIRE: 192.168.2.146:8000 (furysupa). Supabase ANCIEN: 192.168.2.206:8000 (NE PAS utiliser ecriture). MCP Gateway: 192.168.2.230:4000 (Bearer bruce-secret-token-01). llama.cpp alpha: 192.168.2.32:8000/v1 (Dell 7910). LiteLLM: .230:4100/v1 (model=alpha, token-abc123). Jump host SSH: furycom@192.168.2.230 (Cle: C:\\Users\\Administrator\\.ssh\\homelab_key). Pulse: 192.168.2.154:7655. Embedder: 192.168.2.85:8081 (BAAI/bge-m3). n8n: 192.168.2.174:5678. OpenWebUI: 192.168.2.32:3000 (ai.furycom.com). Forgejo: 192.168.2.230:3300.",
        "category": "infrastructure",
        "subcategory": "network-map",
        "tags": ["infra", "machines", "ips", "reseau"],
    },
    {
        "question": "SSH users par machine homelab",
        "answer": "SSH USERS: .154=yann, .174=yann, .173=yann, .12=yann, .113=yann, .87=yann, .249=yann, .103=root, .58=root (mdp inconnu). Toutes les autres=furycom (.230, .32, .146, .85, .231). Cle Windows: C:\\Users\\Administrator\\.ssh\\homelab_key. Mot de passe universel: 2035. Sudo NOPASSWD configure sur: .230(furycom), .32(furycom), .146(furycom), .154(yann), .174(yann), .173(yann), .12(yann), .113(yann), .87(yann), .249(yann), .231(furycom).",
        "category": "infrastructure",
        "subcategory": "ssh-access",
        "tags": ["ssh", "users", "machines", "acces"],
    },

    # --- GOVERNANCE ---
    {
        "question": "Types de session BRUCE et modeles associes",
        "answer": "Opus (Claude Desktop): Architecture, audits, raisonnement profond. model_hint=opus. Sonnet (Claude Desktop): Planification, roadmap, analyse generale. model_hint=sonnet. Code (Claude Code terminal): SSH natif bash, docker, scripts, deploiement. model_hint=code. Yann prefere Opus Desktop pour TOUT. Deteste Claude Code (reserve aux deploiements SSH lourds uniquement).",
        "category": "governance",
        "subcategory": "session-types",
        "tags": ["session", "opus", "sonnet", "code"],
    },
    {
        "question": "Regles immuables BRUCE (staging, session, ecriture)",
        "answer": "Ecriture: POST staging_queue, validate.py. JAMAIS INSERT direct. Exception: roadmap INSERT direct via REST. contenu_json pour lessons DOIT contenir: lesson_type, lesson_text, importance, confidence_score. Fin session: (1) Memory MCP add_observations, (2) POST /bruce/session/close. author_system = 'claude' (jamais claude-opus/sonnet). Documenter dans Supabase apres chaque tache significative. Ne pas boucler sur retry, diagnostiquer et documenter.",
        "category": "governance",
        "subcategory": "core-rules",
        "tags": ["staging", "session", "ecriture", "regles"],
    },
    {
        "question": "Schema knowledge_base colonnes et contraintes",
        "answer": "KB colonnes: id, question, answer, category, subcategory, tags, author_system, content_hash, validated, confidence_score, actor, session_id, intent, data_family, canonical_lock, authority_tier, protection_level, project_scope, created_at, tag_domain. KB N A PAS de colonne archived (seul lessons_learned l a). CHECK category IN: architecture, runbook, governance, infrastructure, tools, schema, pipeline, user_profile, ssh, configuration, docker, debugging, workflow, database, mcp. ROADMAP colonnes: step_name (PAS title).",
        "category": "schema",
        "subcategory": "knowledge-base",
        "tags": ["schema", "kb", "colonnes", "knowledge-base"],
    },
    {
        "question": "Priorisation roadmap BRUCE par effet de levier",
        "answer": "La roadmap BRUCE doit etre priorisee par EFFET DE LEVIER (impact multiplicateur sur le reste du systeme), pas par severite classique. Yann prefere attaquer ce qui debloque le plus de valeur en aval plutot que des correctifs isoles meme urgents.",
        "category": "governance",
        "subcategory": "prioritization",
        "tags": ["roadmap", "priorisation", "levier"],
    },
    {
        "question": "Architecture gateway BRUCE post-REFONTE",
        "answer": "server.js = ~400L (pur orchestrateur: imports, middleware, OpenAPI, app.listen). routes/ = 19 fichiers bind mount (modif = restart suffit). shared/ = 9 modules bind mount. Docker build context = mcp-stack root. server.js COPY dans image (modif = docker compose build + up). Endpoints cles: /bruce/write POST (table_cible, contenu_json, author_system, notes), /bruce/read POST (q: SQL), /bruce/session/close POST, /bruce/exec POST, /bruce/file/write POST, /bruce/file/read GET.",
        "category": "architecture",
        "subcategory": "gateway",
        "tags": ["gateway", "architecture", "routes", "docker"],
    },
]


def parse_args():
    parser = argparse.ArgumentParser(description="Migrate claude.md content into KB staging_queue")
    parser.add_argument("--timeout", type=int, default=15, help="HTTP timeout seconds (default: 15)")
    parser.add_argument("--max-retries", type=int, default=3, help="HTTP retries per request (default: 3)")
    parser.add_argument("--sleep", type=float, default=0.2, help="Delay between entry submissions")
    parser.add_argument("--run-validation", action="store_true", help="Call /bruce/staging/validate after submissions")
    parser.add_argument("--verify", action="store_true", help="Query knowledge_base anti-pattern rows after validation")
    parser.add_argument("--strict", action="store_true", help="Exit non-zero if any step fails")
    return parser.parse_args()


def main():
    args = parse_args()
    print(f"Migrating {len(ENTRIES)} claude.md entries to KB via staging_queue...")
    success = 0
    failures = []

    for i, entry in enumerate(ENTRIES):
        note = f"[1001] claude.md migration entry {i+1}/{len(ENTRIES)}"
        print(f"  [{i+1}/{len(ENTRIES)}] {entry['category']}/{entry['subcategory']}: {entry['question'][:60]}...")
        result = submit_to_staging(
            entry["question"], entry["answer"],
            entry["category"], entry["subcategory"],
            entry.get("tags", []), note,
            timeout=args.timeout,
            max_retries=args.max_retries,
        )
        if result and result.get("ok"):
            success += 1
        else:
            print(f"    WARN: staging submission may have failed: {result}")
            failures.append(entry["question"])
        time.sleep(args.sleep)  # Rate limit safety

    print(f"\nDone: {success}/{len(ENTRIES)} entries submitted to staging_queue.")
    if failures:
        print("Failed entries:")
        for q in failures:
            print(f"  - {q}")

    print("Next: run staging validation to promote to knowledge_base.")
    print(f"  curl -X POST http://192.168.2.230:4000/bruce/staging/validate -H 'Authorization: Bearer {TOKEN}' -H 'Content-Type: application/json' -d '{{}}'")

    validation_ok = True
    if args.run_validation:
        print("\nTriggering staging validation...")
        validation_ok = trigger_staging_validation(args.timeout, args.max_retries)

    verify_ok = True
    if args.verify:
        print("\nVerifying knowledge_base ingestion...")
        verify_ok = verify_kb_ingestion(args.timeout)

    if args.strict and (success != len(ENTRIES) or not validation_ok or not verify_ok):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
