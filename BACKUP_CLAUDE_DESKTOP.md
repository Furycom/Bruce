# BACKUP — Claude Desktop Windows
*Dernière mise à jour : 2026-03-14 — Session Sonnet 1126*

Ce fichier documente la configuration complète de Claude Desktop Windows pour restauration après crash ou réinstallation.

---

## 1. Informations système

| Élément | Valeur |
|---------|--------|
| OS | Windows Server (Administrator) |
| Machine | FurycomAI / poste Windows principal |
| Claude Desktop | Version installée dans AppData |
| Config path | `C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json` |
| Workspace | `C:\Users\Administrator\Desktop\claude_workspace\` |
| SSH key | `C:\Users\Administrator\.ssh\homelab_key` |
| Supabase key | `C:\Users\Administrator\.ssh\supabase_key.txt` |

---

## 2. claude_desktop_config.json (10 MCP servers)

```json
{
  "mcpServers": {
    "PowerShell": {
      "command": "cmd.exe",
      "args": [
        "/c",
        "C:\\Users\\Administrator\\Documents\\PowerShell\\Modules\\PowerShell.MCP\\1.5.1\\bin\\win-x64\\run-proxy.cmd"
      ]
    },
    "homelab-semantic-search-advanced": {
      "command": "node",
      "args": [
        "C:\\Users\\Administrator\\Desktop\\claude_workspace\\mcp_semantic_search\\index_advanced.js"
      ]
    },
    "prometheus": {
      "command": "node",
      "args": [
        "C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\prometheus-mcp\\dist\\index.mjs",
        "stdio"
      ],
      "env": {
        "PROMETHEUS_URL": "http://192.168.2.154:9090"
      }
    },
    "grafana": {
      "command": "uvx",
      "args": ["mcp-grafana", "-t", "stdio"],
      "env": {
        "GRAFANA_URL": "http://192.168.2.154:3001",
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": "<GRAFANA_SERVICE_ACCOUNT_TOKEN>"
      }
    },
    "docker": {
      "command": "mcp-docker",
      "env": {
        "DOCKER_BASE_URL": "tcp://192.168.2.230:2375"
      }
    },
    "proxmox": {
      "command": "C:\\Users\\Administrator\\Desktop\\claude_workspace\\mcp_servers\\ProxmoxMCP\\.venv\\Scripts\\python.exe",
      "args": ["-m", "proxmox_mcp.server"],
      "env": {
        "PYTHONPATH": "C:\\Users\\Administrator\\Desktop\\claude_workspace\\mcp_servers\\ProxmoxMCP\\src",
        "PROXMOX_MCP_CONFIG": "C:\\Users\\Administrator\\Desktop\\claude_workspace\\mcp_servers\\ProxmoxMCP\\proxmox-config\\config.json"
      }
    },
    "postgres": {
      "command": "mcp-server-postgres",
      "args": [
        "postgresql://postgres:<POSTGRES_PASSWORD>@192.168.2.146:5433/postgres?connect_timeout=10&keepalives=1&keepalives_idle=60&keepalives_interval=10&keepalives_count=3"
      ]
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "C:\\Users\\Administrator\\.claude-memory\\memory.json"
      }
    },
    "n8n-mcp": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm", "--init",
        "-e", "MCP_MODE=stdio",
        "-e", "LOG_LEVEL=error",
        "-e", "DISABLE_CONSOLE_OUTPUT=true",
        "-e", "N8N_API_URL=http://192.168.2.174:5678",
        "-e", "N8N_API_KEY=<N8N_API_KEY>",
        "ghcr.io/czlonkowski/n8n-mcp:latest"
      ]
    }
  },
  "preferences": {
    "coworkScheduledTasksEnabled": true,
    "ccdScheduledTasksEnabled": true,
    "sidebarMode": "chat",
    "bypassPermissionsModeEnabled": true,
    "coworkWebSearchEnabled": true,
    "chromeExtensionEnabled": true
  }
}
```

---

## 3. Tokens et credentials critiques

| Service | Token / Credential | Notes |
|---------|-------------------|-------|
| Gateway BRUCE | `bruce-secret-token-01` | Bearer token pour toutes les requêtes gateway .230:4000 |
| LiteLLM | `bruce-litellm-key-01` | Master key LiteLLM .230:4100 |
| llama-server .32 | `token-abc123` | API key llama.cpp .32:8000 |
| GitHub API | `<GITHUB_PAT>` | Repo Furycom/Bruce — merge PRs |
| Forgejo API | `<FORGEJO_API_TOKEN>` | User bruce, .230:3300 |
| Grafana | `<GRAFANA_SERVICE_ACCOUNT_TOKEN>` | Service account claude-mcp |
| n8n | `<N8N_API_KEY>` | API key n8n .174:5678 |
| Supabase service_role | Fichier local `C:\Users\Administrator\.ssh\supabase_key.txt` | Ne pas stocker en clair ici |
| Cloudflare API (DNS) | `<CLOUDFLARE_DNS_TOKEN>` | Zone furycom.com |
| Cloudflare API (Tunnel) | `<CLOUDFLARE_TUNNEL_TOKEN>` | Tunnel edit |
| Cloudflare Tunnel ID | `54f97b11-a447-4f3b-9bff-bd48e2823c15` | furycomai → ai.furycom.com |

---

## 4. Prérequis installation (ordre)

### 4.1 Claude Desktop
1. Télécharger depuis https://claude.ai/download
2. Installer normalement
3. Se connecter avec le compte Anthropic

### 4.2 PowerShell MCP
```powershell
# Module PowerShell.MCP v1.5.1
# Path: C:\Users\Administrator\Documents\PowerShell\Modules\PowerShell.MCP\1.5.1\
# Installer depuis PowerShell Gallery ou copier le dossier
Install-Module PowerShell.MCP -RequiredVersion 1.5.1
```

### 4.3 Node.js (pour semantic search + prometheus)
```
node >= 18 requis
npm install -g prometheus-mcp
```

### 4.4 homelab-semantic-search-advanced
```
Copier le dossier mcp_semantic_search\ dans le workspace
Configurer index_advanced.js avec l'URL Supabase et la clé
```

### 4.5 Proxmox MCP
```
Dossier: claude_workspace\mcp_servers\ProxmoxMCP\
Python venv dans .venv\ avec proxmox_mcp installé
Config: proxmox-config\config.json (Proxmox host, token)
```

### 4.6 mcp-docker
```
npm install -g mcp-docker
Docker Desktop installé et DOCKER_BASE_URL pointant vers tcp://192.168.2.230:2375
```

### 4.7 mcp-server-postgres
```
npm install -g @modelcontextprotocol/server-postgres
```

### 4.8 Grafana MCP (uvx)
```
pip install uvx
uvx mcp-grafana (téléchargé automatiquement)
```

### 4.9 Memory MCP
```
npx -y @modelcontextprotocol/server-memory
MEMORY_FILE_PATH: C:\Users\Administrator\.claude-memory\memory.json
Sauvegarder memory.json séparément — contient tout l'historique BRUCE_STATE
```

### 4.10 n8n MCP
```
Docker requis (image ghcr.io/czlonkowski/n8n-mcp:latest)
```

---

## 5. Fichiers critiques à sauvegarder

| Fichier | Importance | Notes |
|---------|-----------|-------|
| `claude_desktop_config.json` | 🔴 Critique | Ce fichier |
| `C:\Users\Administrator\.ssh\homelab_key` | 🔴 Critique | Clé SSH accès .230 |
| `C:\Users\Administrator\.ssh\supabase_key.txt` | 🔴 Critique | Clé service_role Supabase |
| `C:\Users\Administrator\.claude-memory\memory.json` | 🔴 Critique | Mémoire persistante BRUCE |
| `claude_workspace\claude.md` | 🔴 Critique | Bootstrap instructions v5.5 |
| `claude_workspace\mcp_semantic_search\` | 🟡 Important | Serveur RAG local |
| `claude_workspace\mcp_servers\ProxmoxMCP\` | 🟡 Important | Dont proxmox-config/config.json |
| `claude_workspace\Send-FileToRemote.ps1` | 🟡 Important | Wrapper transfert fichiers |

---

## 6. Infrastructure homelab (référence)

| Machine | IP | Rôle |
|---------|-----|------|
| mcp-gateway | 192.168.2.230 | Gateway BRUCE, Forgejo, LiteLLM, Docker MCP |
| Supabase | 192.168.2.146 | Base de données principale (furysupa) |
| Dell 7910 | 192.168.2.32 | LLM local (Qwen3-32B, llama.cpp) |
| box2-observability | 192.168.2.154 | Prometheus, Grafana, Loki |
| box2-automation | 192.168.2.174 | n8n workflows |
| Proxmox | 192.168.2.103 | Hyperviseur box2 |
| Embedder | 192.168.2.85:8081 | Service embeddings |
