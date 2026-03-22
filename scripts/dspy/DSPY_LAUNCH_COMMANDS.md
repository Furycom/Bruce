# DSPy Launch Commands - Session 1242
## PREREQUIS (BLOCKER - faire manuellement)

venv-ingestion n'existe PAS sur .32. SSH whitelist bloque python3.

```bash
# Se connecter directement a .32 (pas via gateway)
ssh furycom@192.168.2.32

# Creer le venv
python3 -m venv /home/furycom/venv-ingestion
/home/furycom/venv-ingestion/bin/pip install dspy-ai

# Verifier
/home/furycom/venv-ingestion/bin/python3 -c "import dspy; print(dspy.__version__)"
```

## AVANT CHAQUE RUN

```bash
# 1. Claim le GPU (screensaver arrete mais bonne pratique)
python3 /workspace/scripts/bruce_llm_claim.py claim 1242

# 2. Purger le cache DSPy
rm -rf ~/.dspy_cache/

# 3. Verifier les constantes de version (PIEGE RECURRENT)
grep -n 'LOCK_FILE\|PROGRESS_FILE\|RESULTS_DIR\|LOG_FILE' /workspace/scripts/dspy/bruce_dspy_optimizer_v32.py

# 4. Verifier que llama-server tourne sur .32
curl -s http://192.168.2.32:8000/v1/models

# 5. Creer le repertoire resultats
mkdir -p /workspace/dspy-results/v32
```

## LANCEMENT

```bash
# IMPORTANT: --reasoning off OBLIGATOIRE sur Qwen3
# IMPORTANT: parallel=1 (GPU unique)
# IMPORTANT: JAMAIS MIPROv2 avec LLM local (utiliser LabeledFewShot)

cd /workspace/scripts/dspy
/home/furycom/venv-ingestion/bin/python3 bruce_dspy_optimizer_v32.py
```

## APRES LE RUN

```bash
# 1. Verifier les resultats
ls -la /workspace/dspy-results/v32/

# 2. Release le GPU
python3 /workspace/scripts/bruce_llm_claim.py release

# 3. Git commit
cd /workspace && git add -A && git commit -m "dspy: results v32 [session 1242]"
```

## GOLD SETS DISPONIBLES

| Fichier | Exemples | Tache | Modele | Statut |
|---------|----------|-------|--------|--------|
| dspy_gold_kb_audit_v1.json | 13 | KB review | 32B | VALIDE |
| dspy_gold_32b_alpha_v1.json | 15 | Alpha review | 32B | VALIDE |
| dspy_gold_14b_review_v3.json | 20 | 14B review | 14B | VALIDE |
| dspy_gold_session_summary_v1.json | 10 | Session summary | 32B | CREE |
| dspy_gold_moe_triage_v1.json | 20 | MoE triage | 14B/32B | CREE |
| gold_examples_v3.py | 45 | Extraction | 32B | VALIDE |

## MANQUANT
- dspy_gold_dedup_v1.json (dedup semantique) - a creer
