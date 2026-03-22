# Dell 7910 (.32) - Scripts et Configs

Machine GPU (NVIDIA) du homelab BRUCE.
IP: 192.168.2.32 | SSH alias: furycomai

## Structure

- benchmarks/ — Scripts de benchmark LLM (v1 a v4b)
- llm-ops/ — Gestion llama-server (recreate, watchdog, download)
- results/ — Resultats benchmark (summary JSON)
- MODELS_INVENTORY.md — Liste des modeles GGUF installes

## Note securite

- Les tokens Cloudflare sont dans le .env local de .32, PAS dans ce repo
- Les fichiers GGUF ne sont PAS dans Git (trop gros)
- Le token llama-server (token-abc123) est local uniquement, reseau interne
