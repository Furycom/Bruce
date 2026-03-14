# BRUCE MCP Gateway

BRUCE est une gateway HTTP construite avec Node.js et Express (`server.js`) qui centralise un grand nombre de routes sous le namespace `/bruce`. Elle sert de couche d'orchestration pour un assistant IA de homelab en exposant des endpoints liés au chat, à la mémoire, à l'infra, aux données et aux outils. Le dépôt inclut aussi une spécification OpenAPI intégrée intitulée "BRUCE MCP Gateway", ce qui positionne le service comme un serveur MCP/tool gateway. La documentation de sauvegarde fournie montre son usage dans un contexte Claude Desktop.

## Structure du repository

- `server.js` : point d'entrée Express (middlewares, montage des routes, OpenAPI, démarrage du serveur).
- `routes/` : endpoints métier (ex. chat, mémoire, infra, RAG, fichiers, exécution, etc.).
- `shared/` : modules partagés (config, auth, helpers, clients, orchestration LLM).
- `tests/` : tests unitaires Jest (`tests/unit/*`).
- Documents importants :
  - `REVIEW.md`
  - `REFACTOR_CHAT.md`
  - `BACKUP_CLAUDE_DESKTOP.md`
  - `.env.example`

## Prérequis

- Node.js 18+
- Docker
- Variables d'environnement configurées (voir `.env.example`)

## Démarrage rapide

```bash
docker compose up -d
```

## Tests

```bash
npm test
```

(Test runner: Jest)
