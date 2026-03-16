# BOOTSTRAP.md — Reconstruire BRUCE depuis zéro

> Ce guide suppose que vous avez : ce repo + un backup Supabase (pg_dump).
> Temps estimé : ~2h pour un opérateur expérimenté.

## Prérequis

### Matériel minimum
- **Serveur principal** (.230) : 32GB RAM, Docker, Ubuntu 24. Héberge le gateway, les workers, Forgejo, n8n.
- **Serveur LLM** (.32) : GPU NVIDIA (24GB+ VRAM recommandé). Héberge llama.cpp pour inférence locale.
- **Serveur Supabase** (.146) : 16GB RAM, Docker. Héberge Supabase self-hosted (PostgreSQL + PostgREST + Storage).
- **Serveur observabilité** (.154) : Prometheus, Grafana, Loki, Uptime Kuma.
- **Serveur embeddings** (.85) : GPU NVIDIA. BAAI/bge-m3 via TEI (Text Embeddings Inference).

### Réseau
- Tous les serveurs sur le même LAN (192.168.2.0/24)
- Ports exposés : 4000 (gateway), 8000 (Supabase REST + llama.cpp), 3300 (Forgejo), 5678 (n8n), 8081 (embedder), 4100 (LiteLLM)
- SSH entre toutes les machines (clé publique déployée, user `furycom`)

### Logiciels requis
- Docker + Docker Compose v2 sur .230, .146, .32
- Python 3.10+ sur .230 (avec venv pour ingestion)
- Node.js 20+ sur .230 (pour le gateway)
- NVIDIA drivers + CUDA sur .32 et .85

---

## Étape 1 : Restaurer Supabase (.146)

```bash
# 1. Installer Supabase self-hosted
git clone --depth 1 https://github.com/supabase/supabase
cd supabase/docker
cp .env.example .env
# Éditer .env : POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY
docker compose up -d

# 2. Restaurer le backup
# Le backup est un pg_dump généré par le workflow n8n #90 (quotidien)
docker cp backup.sql supabase-db:/tmp/
docker exec supabase-db psql -U supabase_admin -d postgres -f /tmp/backup.sql

# 3. Vérifier
curl http://localhost:8000/rest/v1/ -H "apikey: VOTRE_SERVICE_ROLE_KEY"
```

### Tables critiques (29)
- `knowledge_base` : KB principale (~287 entrées)
- `lessons_learned` : Leçons extraites (~1214)
- `roadmap` : Tâches et historique (~600 done)
- `session_history` : Historique des sessions Claude
- `staging_queue` : Pipeline d'écriture validée
- `bruce_chunks` : Chunks RAG (~8600)
- `bruce_embeddings` : Vecteurs d'embedding
- `bruce_tools` : Registre des outils BRUCE (36+)
- `media_library` : Bibliothèque média (~5176)
- `homelab_services` : Inventaire infra
- `observed_docker_snapshots` : État Docker collecté

### RPCs critiques
- `exec_sql(sql text)` : Exécution SQL arbitraire
- `check_unlocked_tools(capabilities text[])` : Vérification dépendances outils
- `match_bruce_chunks(query_embedding, match_threshold, match_count)` : Recherche vectorielle

---

## Étape 2 : Déployer le gateway MCP (.230)

```bash
# 1. Cloner le repo
git clone https://github.com/Furycom/Bruce.git /home/furycom/mcp-stack
cd /home/furycom/mcp-stack

# 2. Configurer l'environnement
cp .env.example .env
# Éditer .env avec les vrais secrets :
#   SUPABASE_URL=http://192.168.2.146:8000/rest/v1
#   SUPABASE_KEY=<service_role_key>
#   BRUCE_AUTH_TOKEN=<token_fort>
#   LOCAL_LLM_URL=http://192.168.2.32:8000
#   EMBEDDER_URL=http://192.168.2.85:8081
#   LITELLM_URL=http://192.168.2.230:4100
#   BRUCE_LLM_API_BASE=http://192.168.2.32:8000/v1
#   BRUCE_LLM_MODEL=<nom_modele>
#   BRUCE_LLM_API_KEY=<clé>

# 3. Construire et lancer
docker compose up -d --build

# 4. Vérifier
curl -s http://localhost:4000/bruce/integrity \
  -H "Authorization: Bearer <BRUCE_AUTH_TOKEN>" | jq .
```

### Architecture gateway
```
server.js (404L)          — orchestrateur Express, imports, middleware, OpenAPI
├── routes/ (19 fichiers) — endpoints REST (bind mount, restart suffit)
├── shared/ (9 modules)   — auth, config, supabase-client, helpers, etc. (bind mount)
└── mcp-gateway/
    ├── Dockerfile        — image Node.js
    └── entrypoint.sh     — point d'entrée container
```

> **Important** : `server.js` est COPIÉ dans l'image Docker. Toute modification nécessite `docker compose build && docker compose up -d`. Les dossiers `routes/` et `shared/` sont en bind mount — un restart suffit.

---

## Étape 3 : Déployer les workers (.230)

### Python venv
```bash
python3 -m venv /home/furycom/venv-ingestion
source /home/furycom/venv-ingestion/bin/activate
pip install requests httpx supabase python-dotenv dspy-ai litellm
```

### Embed worker (systemd user)
```bash
# Copier le unit file
mkdir -p ~/.config/systemd/user/
cp configs/systemd/user/bruce-embed-worker.service ~/.config/systemd/user/
# Activer
systemctl --user daemon-reload
systemctl --user enable --now bruce-embed-worker.service
loginctl enable-linger $(whoami)
```

### Validate service (systemd user, port 4001)
```bash
cp configs/systemd/user/bruce-validate-svc.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bruce-validate-svc.service
```

### Docker collector (systemd system)
```bash
sudo cp configs/systemd/system/bruce-docker-collector.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bruce-docker-collector.timer
```

---

## Étape 4 : Configurer les crons (.230)

```bash
# Importer le crontab d'exemple
# Revue et ajuster les paths avant import
crontab configs/crontab.example
```

### Crons actifs
| Schedule | Script | Rôle |
|----------|--------|------|
| `*/5 * * * *` | inbox_watcher.sh | Surveille /home/furycom/inbox/*.txt |
| `*/5 * * * *` | bruce_watchdog.sh | Health check containers |
| `15 * * * *` | bruce_alert_dispatcher.py | Dispatch alertes |
| `0 * * * *` | sync_homelab_hub.py | Sync homelab_services |
| `0 2 1 * *` | bruce_monthly_review.py | Revue qualité mensuelle |
| `0 3 1 * *` | bruce_quality_review.py | Audit qualité KB |
| `0 4 * * *` | kb_maintenance.py | Maintenance KB quotidienne |
| `0 4 * * 0` | trivy_scan_weekly.py | Scan sécurité hebdo |
| `0 4 * * 0` | bookstack_sync.py | Sync BookStack |
| `0 5 * * *` | pulse_sync_cron.sh | Sync Pulse monitoring |

---

## Étape 5 : Déployer le LLM local (.32)

```bash
# llama.cpp via Docker
docker run -d --name llama-server \
  --gpus all \
  -v /chemin/modeles:/models \
  -p 8000:8080 \
  ghcr.io/ggerganov/llama.cpp:server \
  -m /models/MODELE.gguf \
  --n-gpu-layers auto \
  --flash-attn auto \
  --ctx-size 16384 \
  --parallel 2

# Vérifier
curl http://192.168.2.32:8000/health
```

> **Port** : interne 8080, externe 8000. Ne pas confondre.
> **Modèle alpha actuel** : Qwen3-32B Q4_K_M (nécessite `/no_think` dans les prompts)

---

## Étape 6 : Déployer l'embedder (.85)

```bash
# Text Embeddings Inference (Hugging Face)
docker run -d --name tei-bge-m3 \
  --gpus all \
  -p 8081:80 \
  ghcr.io/huggingface/text-embeddings-inference:latest \
  --model-id BAAI/bge-m3

# Vérifier
curl http://192.168.2.85:8081/embed -d '{"inputs":"test"}' -H 'Content-Type: application/json'
```

---

## Étape 7 : Déployer l'observabilité (.154)

```bash
# Stack Prometheus + Grafana + Loki
# Voir docker-compose dans le repo dédié box2-observability

# Services :
#   Prometheus : port 9090
#   Grafana    : port 3001 (service account claude-mcp pour MCP)
#   Loki       : port 3100
#   Uptime Kuma: port 3001 (sur .230)
```

---

## Étape 8 : Configurer Claude Desktop

### claude_desktop_config.json
Configurer les MCP servers pour connecter Claude Desktop à l'infra :
1. **Desktop Commander** — fichiers, processus locaux
2. **PowerShell MCP** — exécution de commandes
3. **homelab-semantic-search-advanced** — RAG BRUCE (Supabase pgvector)
4. **Docker MCP** — containers via SSH
5. **Prometheus MCP** — métriques via Grafana
6. **Grafana MCP** — dashboards, Loki logs
7. **Proxmox MCP** — gestion VMs
8. **Memory MCP** — knowledge graph local (Anthropic officiel)
9. **n8n MCP** — automation workflows
10. **Claude in Chrome** — navigation web, UI admin

### claude.md
Le fichier `claude.md` dans le workspace Claude Desktop contient le bootstrap complet :
- Infrastructure (IPs, ports, credentials placeholders)
- Anti-patterns critiques (15 règles)
- Patterns SSH/REST/SQL
- Profil utilisateur

---

## Étape 9 : Vérification finale

```bash
# 1. Gateway health
curl -s http://192.168.2.230:4000/bruce/integrity \
  -H "Authorization: Bearer <TOKEN>" | jq .

# 2. Bootstrap complet
curl -s http://192.168.2.230:4000/bruce/bootstrap \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"topic":"verification","model":"opus","include_tasks":true}' | jq .

# 3. Vérifier tous les checks
# supabase: true, staging_pending: true, embedder: true,
# local-llm: true, validate_service: true, n8n: true,
# litellm: true, sequences: true

# 4. Tester l'écriture via staging
curl -s http://192.168.2.230:4000/bruce/write \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"table_cible":"lessons_learned","contenu_json":{"lesson_type":"discovery","lesson_text":"Test bootstrap","importance":"low","confidence_score":0.5,"author_system":"claude","project_scope":"homelab"},"author_system":"claude","notes":"test"}' | jq .
```

---

## Secrets à configurer (.env.example)

| Variable | Description |
|----------|-------------|
| `SUPABASE_KEY` | Clé service_role Supabase |
| `BRUCE_AUTH_TOKEN` | Token Bearer pour le gateway |
| `BRUCE_LLM_API_KEY` | Clé API pour le provider LLM |
| `BRUCE_LITELLM_KEY` | Clé LiteLLM (si utilisé) |

> **AUCUN** secret ne doit être commité dans le repo. Utiliser `.env` (gitignored) et `.env.example` avec placeholders.

---

## Arborescence du repo

```
Bruce/
├── server.js                    # Gateway orchestrateur (404L)
├── docker-compose.yml           # Stack Docker
├── .env.example                 # Template secrets
├── .gitignore
├── package.json
├── BOOTSTRAP.md                 # CE FICHIER
├── README.md
├── AGENTS.md                    # Instructions Codex/agents
│
├── routes/                      # 19 endpoints REST (bind mount)
│   ├── admin.js
│   ├── ask.js
│   ├── chat.js
│   ├── data-read.js
│   ├── data-write.js
│   ├── docker.js
│   ├── exec.js
│   ├── file.js
│   ├── inbox.js
│   ├── infra.js
│   ├── manual.js
│   ├── memory.js
│   ├── rag.js
│   ├── roadmap.js
│   ├── search.js
│   ├── session.js
│   ├── staging.js
│   ├── tools.js
│   └── tools-unlock.js
│
├── shared/                      # 9 modules partagés (bind mount)
│   ├── auth.js
│   ├── config.js
│   ├── context-engine.js
│   ├── docker-client.js
│   ├── exec-security.js
│   ├── fetch-utils.js
│   ├── helpers.js
│   ├── llm-profiles.js
│   ├── llm-queue.js
│   ├── openapi.js
│   └── supabase-client.js
│
├── scripts/
│   ├── workers/                 # Services persistants
│   │   ├── embed_worker.py      # Embedding continu (systemd user)
│   │   ├── validate_service.py  # HTTP validation (port 4001, systemd user)
│   │   ├── validate.py          # Validation staging_queue
│   │   ├── inbox_watcher.sh     # Surveillance inbox (cron */5min)
│   │   └── bruce_watchdog.sh    # Health check containers (cron */5min)
│   │
│   ├── ingestion/               # Pipeline d'ingestion
│   │   ├── bruce_ingest.py      # Ingestion principale
│   │   ├── bruce_lesson_review.py
│   │   └── quality_gates.py     # Gates de validation
│   │
│   ├── maintenance/             # Maintenance KB
│   │   ├── kb_maintenance.py    # Maintenance quotidienne (cron 4h)
│   │   ├── bruce_quality_review.py  # Audit mensuel
│   │   └── bruce_monthly_review.py
│   │
│   ├── monitoring/              # Monitoring et alertes
│   │   ├── bruce_alert_dispatcher.py  # Dispatch alertes (cron */15min)
│   │   ├── bruce_ip_audit.py
│   │   ├── trivy_scan_weekly.py       # Scan sécurité (cron hebdo)
│   │   ├── bruce_log_shipper.py
│   │   ├── pulse_sync.py
│   │   └── pulse_sync_cron.sh
│   │
│   ├── docker/                  # Collecte état Docker
│   │   ├── bruce_docker_collect_local.py
│   │   ├── bruce_docker_post_observed_snapshot.py
│   │   └── bruce_docker_snapshot_to_sql.py
│   │
│   ├── media/                   # Bibliothèque média
│   │   ├── bruce_media_audit.py
│   │   ├── bruce_tmdb_enrich.py
│   │   ├── populate_bruce_uid.py
│   │   └── scan_disk_v6.ps1
│   │
│   ├── dspy/                    # Optimisation DSPy
│   │   ├── bruce_dspy_optimizer_v32.py
│   │   ├── gold_examples_v3.py
│   │   ├── gate2_eval.py
│   │   └── dspy_cron_watchdog.sh
│   │
│   └── utils/                   # Utilitaires
│       ├── sync_homelab_hub.py
│       ├── bookstack_sync.py
│       └── embed_diagnostic.py
│
├── configs/
│   ├── litellm_config.yaml
│   ├── crontab.example
│   └── systemd/
│       ├── system/              # Units root
│       │   ├── bruce-cmd-worker.service
│       │   ├── bruce-docker-collector.service
│       │   ├── bruce-docker-collector.timer
│       │   ├── bruce-rag-embed.service
│       │   └── bruce-rag-embed.timer
│       └── user/                # Units furycom (loginctl linger)
│           ├── bruce-embed-worker.service
│           └── bruce-validate-svc.service
│
├── mcp-gateway/
│   ├── Dockerfile
│   ├── entrypoint.sh
│   ├── package.json
│   └── connectors.json
│
├── operations/                  # Snapshots Supabase
└── tests/                       # Tests (integration, unit)
```
