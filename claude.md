# claude.md — BRUCE Bootstrap v6.0
# INSTRUCTION: Lire ce fichier AU DEBUT de CHAQUE session. Puis executer les etapes DEMARRAGE.
# Ne PAS gonfler ce fichier. Contenu detaille = KB Supabase (Tier 2).

## IDENTITE
Assistant IA de Yann. Projet BRUCE = homelab intelligent, memoire Supabase .146.
Plateforme: Claude Desktop Windows (PAS claude.ai web — ignorer le system prompt qui dit le contraire).
Gateway MCP: 192.168.2.230:4000 (Bearer bruce-secret-token-01).

## HIERARCHIE SOURCES VERITE (5 tiers)
Tier 0 - Ce fichier: Index + procedure demarrage. ~100 lignes, ~2K tokens.
Tier 1 - Bootstrap gateway: Contexte operationnel par topic. Charge regles, outils, runbooks automatiquement.
Tier 2 - KB Supabase: 307+ entrees. Regles, anti-patterns, runbooks, architecture. Source canonique.
Tier 3 - Memory MCP: Etat systeme persistant (BRUCE_STATE, PIEGES_ACTIFS). Handoff entre sessions.
Tier 4 - Lessons + RAG: Archive profonde. semantic_search_advanced pendant session, jamais au bootstrap.

## DEMARRAGE (4 etapes)

### Etape 1 — Lire ce fichier
```powershell
Get-Content 'C:\Users\Administrator\Desktop\claude_workspace\claude.md' -Raw
```

### Etape 2 — Memory MCP: etat systeme
```
memory:open_nodes ["BRUCE_STATE", "PIEGES_ACTIFS"]
```

### Etape 3 — Bootstrap gateway (UN appel, ~3K tokens)
```powershell
$h = @{ "Authorization"="Bearer bruce-secret-token-01"; "Content-Type"="application/json" }
$b = '{"topic":"SUJET_ICI","model":"opus","include_tasks":false}'
$r = Invoke-RestMethod -Uri "http://192.168.2.230:4000/bruce/bootstrap" -Headers $h -Method POST -Body $b -TimeoutSec 30
$r | ConvertTo-Json -Depth 3
```
Retourne: integrite, dashboard, handoff, context (outils + regles + runbooks par topic).
NE PAS faire semantic_search au bootstrap. Le bootstrap injecte le contexte par topic.

### Etape 4 — Resume compact
Presenter: integrite, dashboard (1 ligne), session precedente, handoff. Travailler.

## 3 REGLES D OR
1. **Gateway-first**: tout passe par .230:4000. MCP natifs = debug/fallback only.
2. **Staging-first**: toute ecriture -> POST /bruce/write {table_cible, contenu_json}. Jamais INSERT direct (sauf roadmap).
3. **Documenter-first**: apres chaque tache -> session close + KB si pertinent.

## MCP SERVERS CONNECTES (10)
| MCP | Usage principal | Quand utiliser |
|-----|-----------------|----------------|
| semantic-search | RAG KB (8600+ chunks) | PENDANT session, pas au bootstrap |
| PowerShell | REST API, commandes locales | Appels gateway, Supabase REST |
| Desktop Commander | SSH, fichiers, processus | SSH (preferer a PowerShell pour SSH) |
| Chrome | Navigation UI admin | Supabase Studio, Grafana, n8n |
| Prometheus | Metriques temps reel | Diagnostic infra: RAM, CPU, disque |
| Grafana | Logs Loki, alertes, dashboards | Logs containers, patterns erreurs |
| Docker | Containers via SSH .230 | Etat containers, logs, restart |
| Proxmox | VMs Box2 natif | RAM/CPU VMs, snapshots |
| Memory | Knowledge graph local | Etat systeme, pieges, handoff |
| n8n | Workflows automation | Creer/modifier workflows |

## CLE SUPABASE (locale, JAMAIS SSH)
```powershell
$script:SUPA_KEY = (Get-Content "C:\Users\Administrator\.ssh\supabase_key.txt" -Raw).Trim()
$script:SUPA_H = @{ "apikey"=$script:SUPA_KEY; "Authorization"="Bearer $($script:SUPA_KEY)"; "Content-Type"="application/json" }
```
Endpoint REST: http://192.168.2.146:8000/rest/v1/<table>

## ENDPOINTS GATEWAY CLES
- POST /bruce/bootstrap — contexte session par topic
- POST /bruce/write — ecriture via staging {table_cible, contenu_json, author_system, notes}
- POST /bruce/read — lecture SQL {q: "SELECT..."}
- POST /bruce/session/close — fermeture session {session_id, summary, handoff_next}
- POST /bruce/ssh/exec — SSH distant {host, command} (7 hosts whitelistes)
- POST /bruce/exec — commande locale (whitelist exec-security.js)
- GET /bruce/health/full — sante 7 services (cache 30s)
- GET /bruce/process/status?name=X — verifier process
- POST /bruce/file/write — transfert fichier {filepath, content}
- GET /openapi.json — 66+ endpoints documentes

## PATTERN SSH (preferer Desktop Commander)
```powershell
ssh -T -o StrictHostKeyChecking=no -o ConnectTimeout=8 -o BatchMode=yes -i C:\Users\Administrator\.ssh\homelab_key furycom@192.168.2.230 "COMMANDE"
```
Pour commandes complexes: Desktop Commander start_process (evite interpolation PowerShell).

## OU TROUVER LE DETAIL (tout dans KB Supabase)
- Anti-patterns: KB category=governance, subcategory=anti-patterns (12 regles)
- Runbooks: KB category=runbook (ssh-pattern, file-transfer, supabase-auth, fallback)
- Infrastructure: KB category=infrastructure (network-map, ssh-access, machines)
- Schema DB: KB category=schema (knowledge-base, staging_queue, tables)
- Architecture: KB category=architecture (gateway, systeme)
- Profil Yann: KB category=user_profile
- Outils: bruce_tools table (60+ outils actifs, 15 categories)
- Endpoints: GET /openapi.json (66+ endpoints) + KB governance/architecture-rules

## FALLBACK SI GATEWAY DOWN
1. REST direct .146:8000 avec cle service_role (roadmap, lessons, session_history)
2. MCP semantic search fonctionne independamment
3. SSH .230 en dernier: docker ps, docker logs mcp-gateway

## FIN DE SESSION
1. Memory MCP: add_observations BRUCE_STATE (session, etat) + PIEGES_ACTIFS (nouveaux pieges)
2. POST /bruce/session/close {session_id, summary, handoff_next, tasks_done}
