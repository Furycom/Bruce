# Dell 7910 (.32) - Model Inventory

> Les fichiers GGUF sont dans /srv/models/ sur .32.
> Trop gros pour Git. Ce fichier documente ce qui est installe.
> Derniere mise a jour: 2026-03-22

## GPU: NVIDIA (14GB VRAM utilisable)

## Modeles installes

| Dossier | Modele | Quantization | Statut |
|---------|--------|-------------|--------|
| qwen3-32b-q4km | Qwen3-32B | Q4_K_M | PRODUCTION (Alpha) |
| deepseek-r1-qwen-32b-q4 | DeepSeek-R1-Distill-Qwen-32B | Q4_K_M | Disponible |
| qwen2.5-72b-instruct-q4km | Qwen2.5-72B-Instruct | Q4_K_M | Disponible (lent) |
| qwen25-72b-iq3m | Qwen2.5-72B-Instruct | IQ3_M | Disponible (lent) |
| llama33-70b-abliterated-q3 | Llama-3.3-70B-abliterated | Q3_K_M | Disponible (lent) |
| valkyrie-49b-q3km | Valkyrie-49B-v2.1 | Q3_K_M | Disponible |
| qwen3-14b-q4km | Qwen3-14B | Q4_K_M (UD) | Bench V4 |
| qwen3-30b-a3b-q4km | Qwen3-30B-A3B (MoE) | Q4_K_M (UD) | Bench V4 |
| qwen35-9b-q4km | Qwen3.5-9B | Q4_K_M | Bench V4 |
| qwen35-27b-q4km | Qwen3.5-27B | Q4_K_M | Bench V4 |
| qwen35-35b-a3b-q4km | Qwen3.5-35B-A3B (MoE) | Q4_K_M | Bench V4 |

## Benchmark V4 Classement (nothink mode)

1. qwen3-32b-alpha-ref: 0.947 (V3 ref)
2. valkyrie-49b-ref: 0.927 (V3 ref)
3. qwen35-27b: 0.800 (V4)
4. qwen35-9b: 0.800 (V4)
5. qwen35-35b-moe: 0.793 (V4)
6. qwen3-14b: 0.750 (V4)
7. qwen3-30b-moe: 0.743 (V4)
8. qwen25-72b-iq3-retest: 0.250 (V4, partiel)

## Pour reconstruire

1. Installer modeles depuis HuggingFace (download_models.py, download_qwen35.sh)
2. Production = Qwen3-32B Q4_K_M
3. Lancer avec recreate_llama_server.sh
