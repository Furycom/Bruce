#!/usr/bin/env python3
"""Fixed version: submit KB entries via /bruce/write (which handles staging internally)."""
import time, json, sys, urllib.request, urllib.error

GATEWAY = "http://192.168.2.230:4000"
TOKEN = os.environ.get("BRUCE_AUTH_TOKEN", "")
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

def post_json(url, payload_dict, timeout=15, max_retries=3):
    data = json.dumps(payload_dict).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=HEADERS, method="POST")
    for attempt in range(1, max_retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode()), None
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            if attempt < max_retries:
                print(f"    retry {attempt}/{max_retries-1} in 2s ({e.code}: {body[:100]})")
                time.sleep(2)
            else:
                return None, f"HTTP {e.code}: {body[:200]}"
        except Exception as e:
            if attempt < max_retries:
                time.sleep(2)
            else:
                return None, str(e)

ENTRIES = [
    {"question": "Anti-pattern: SSH inline dans PowerShell", "answer": "JAMAIS de SSH inline dans Invoke-RestMethod ou interpolation PowerShell. SSH DOIT utiliser Start-Job + Wait-Job -Timeout 25. Violation = shell bloque indefiniment, session perdue.", "category": "governance", "subcategory": "anti-patterns", "tags": ["ssh", "powershell", "anti-pattern"]},
    {"question": "Anti-pattern: SSH pour lire la cle Supabase", "answer": "JAMAIS de SSH pour la cle Supabase. Stockee localement: $script:SUPA_KEY = (Get-Content supabase_key.txt -Raw).Trim(). Aussi sur .230: /home/furycom/bruce-config/supabase_key_local.txt.", "category": "governance", "subcategory": "anti-patterns", "tags": ["supabase", "cle", "anti-pattern"]},
    {"question": "Anti-pattern: requetes inutiles apres bootstrap", "answer": "Si bootstrap retourne les infos suffisantes, NE PAS aller chercher plus. Ne pas refaire de requetes KB/REST sauf besoin explicite.", "category": "governance", "subcategory": "anti-patterns", "tags": ["bootstrap", "anti-pattern"]},
    {"question": "Anti-pattern: timeout mental 15 secondes", "answer": "Si un appel PowerShell prend >15s, KILL immediatement et pivoter. Ne JAMAIS faire 3x wait_for_completion sur un shell bloque.", "category": "governance", "subcategory": "anti-patterns", "tags": ["timeout", "powershell", "anti-pattern"]},
    {"question": "Anti-pattern: chainer scp et ssh", "answer": "JAMAIS chainer scp + ssh dans le meme invoke_expression. Separer en 2 appels distincts.", "category": "governance", "subcategory": "anti-patterns", "tags": ["scp", "ssh", "anti-pattern"]},
    {"question": "Anti-pattern: scope variables PowerShell", "answer": "Toujours $script: scope pour les variables PowerShell reutilisees entre appels MCP.", "category": "governance", "subcategory": "anti-patterns", "tags": ["powershell", "scope", "anti-pattern"]},
    {"question": "Anti-pattern: tatonnement sans KB", "answer": "KB avant tatonnement: chercher dans la KB avec semantic_search avant d essayer un endpoint/schema. bruce_tools search aussi.", "category": "governance", "subcategory": "anti-patterns", "tags": ["kb", "semantic-search", "anti-pattern"]},
    {"question": "Anti-pattern: diagnostic sans MCP-first", "answer": "MCP-first pour diagnostic infra. ORDRE: (1) Prometheus, (2) Grafana Loki, (3) Docker MCP, (4) Proxmox, (5) Pulse, (6) SSH en dernier.", "category": "governance", "subcategory": "anti-patterns", "tags": ["mcp", "diagnostic", "anti-pattern"]},
    {"question": "Anti-pattern: cycle toxique creation taches", "answer": "NE PAS creer de nouvelles taches sauf si bloquant immediat. Resoudre les racines existantes. Ne pas normaliser les frictions de Yann.", "category": "governance", "subcategory": "anti-patterns", "tags": ["roadmap", "cycle-toxique", "anti-pattern"]},
    {"question": "Anti-pattern: SQL sans ConvertTo-Json", "answer": "TOUJOURS ConvertTo-Json pour body SQL. JAMAIS JSON manuel. exec-sql: pas de UNION ALL, sous-requetes, multi-statements. UNE requete simple.", "category": "governance", "subcategory": "anti-patterns", "tags": ["sql", "powershell", "anti-pattern"]},
    {"question": "Anti-pattern: Supabase sur mauvaise machine", "answer": "Supabase est sur .146, JAMAIS .230. Ne JAMAIS docker exec supabase-db sur .230. SQL via gateway exec-sql ou REST .146:8000.", "category": "governance", "subcategory": "anti-patterns", "tags": ["supabase", "anti-pattern"]},
    {"question": "Anti-pattern: SSH sans contexte prealable", "answer": "CONTEXTE D ABORD, SSH ENSUITE. Relire Memory MCP/handoff/bootstrap pour identifier machine, log, PID. UN SEUL appel SSH cible.", "category": "governance", "subcategory": "anti-patterns", "tags": ["ssh", "contexte", "anti-pattern"]},
    {"question": "Comment transferer un fichier vers .230?", "answer": "METHODE UNIQUE: POST /bruce/file/write. filepath=/home/furycom/DEST/fichier.txt, content=CONTENU. Paths: /home/furycom/ (inbox, uploads, bruce-config, mcp-stack, workdir). FALLBACK: SCP 2 etapes.", "category": "runbook", "subcategory": "file-transfer", "tags": ["transfert", "fichier", "file-write"]},
    {"question": "Pattern SSH PowerShell correct pour BRUCE", "answer": "Start-Job + Wait-Job -Timeout 25 avec ssh -T -o BatchMode=yes. Preferer Desktop Commander start_process pour SSH (PowerShell intercepte -o et $variables).", "category": "runbook", "subcategory": "ssh-pattern", "tags": ["ssh", "powershell", "pattern"]},
    {"question": "Procedure chargement cle Supabase et headers REST", "answer": "Cle locale: $script:SUPA_KEY = (Get-Content supabase_key.txt -Raw).Trim(). Headers: apikey + Authorization Bearer + Content-Type. Endpoint: .146:8000/rest/v1/<table>.", "category": "runbook", "subcategory": "supabase-auth", "tags": ["supabase", "cle", "auth"]},
    {"question": "Fallback si gateway BRUCE est down", "answer": "REST direct .146:8000 avec cle service_role. MCP semantic search independant. SSH .230 en dernier: docker ps, docker logs.", "category": "runbook", "subcategory": "fallback", "tags": ["fallback", "gateway"]},
    {"question": "Carte reseau machines homelab BRUCE", "answer": "Supabase .146:8000. Gateway .230:4000. LLM .32:8000. Embedder .85:8081. n8n .174:5678. OpenWebUI .32:3000. Forgejo .230:3300. Pulse .154:7655. LiteLLM .230:4100.", "category": "infrastructure", "subcategory": "network-map", "tags": ["infra", "machines", "ips"]},
    {"question": "SSH users par machine homelab", "answer": ".154/.174/.173/.12/.113/.87/.249=yann. .103=root. Toutes autres=furycom. Cle Windows: homelab_key. Mdp universel: 2035.", "category": "infrastructure", "subcategory": "ssh-access", "tags": ["ssh", "users", "machines"]},
    {"question": "Types de session BRUCE et modeles", "answer": "Opus Desktop: architecture, audits. Sonnet Desktop: planification, analyse. Code terminal: SSH, docker, deploiement. Yann prefere Opus pour tout.", "category": "governance", "subcategory": "session-types", "tags": ["session", "opus", "sonnet"]},
    {"question": "Regles immuables BRUCE", "answer": "Staging-first: POST staging_queue. Session close obligatoire. author_system=claude. Documenter apres chaque tache. Ne pas boucler sur retry.", "category": "governance", "subcategory": "core-rules", "tags": ["staging", "session", "regles"]},
    {"question": "Schema knowledge_base colonnes", "answer": "KB: id, question, answer, category, subcategory, tags, author_system, content_hash, validated, confidence_score, etc. PAS de colonne archived. ROADMAP: step_name PAS title.", "category": "schema", "subcategory": "knowledge-base", "tags": ["schema", "kb", "colonnes"]},
    {"question": "Priorisation roadmap BRUCE", "answer": "Prioriser par EFFET DE LEVIER (impact multiplicateur), pas severite classique. Attaquer ce qui debloque le plus de valeur en aval.", "category": "governance", "subcategory": "prioritization", "tags": ["roadmap", "priorisation"]},
    {"question": "Architecture gateway BRUCE post-REFONTE", "answer": "server.js ~400L orchestrateur COPY image. routes/ 19 fichiers bind mount. shared/ 9 modules bind mount. Modif routes = restart. Modif server.js = rebuild.", "category": "architecture", "subcategory": "gateway", "tags": ["gateway", "architecture", "routes"]},
]

success = 0
for i, e in enumerate(ENTRIES):
    payload = {
        "table_cible": "knowledge_base",
        "contenu_json": {
            "question": e["question"],
            "answer": e["answer"],
            "category": e["category"],
            "subcategory": e["subcategory"],
            "tags": e.get("tags", []),
            "confidence_score": 1.0,
            "author_system": "claude",
            "project_scope": "homelab",
            "tag_domain": "bruce",
        },
        "author_system": "claude",
        "notes": f"[1001] claude.md migration {i+1}/{len(ENTRIES)}",
    }
    print(f"  [{i+1}/{len(ENTRIES)}] {e['category']}/{e['subcategory']}: {e['question'][:50]}...")
    result, err = post_json(f"{GATEWAY}/bruce/write", payload)
    if result and result.get("ok"):
        success += 1
        print(f"    OK")
    else:
        print(f"    FAIL: {err or result}")
    time.sleep(0.3)

print(f"\nDone: {success}/{len(ENTRIES)}")
