# COMMANDES GIT A EXECUTER MANUELLEMENT
# Session 1243 Opus — 2026-03-22
# Executer sur .230 via SSH furycomai -> furymcp

# === ETAPE 0: Fix DSPy v32 paths (AVANT commit) ===
cd /home/furycom/mcp-stack
sed -i 's|/home/furycom/dspy_results_v32|/workspace/dspy-results/v32|g' scripts/dspy/bruce_dspy_optimizer_v32.py
sed -i 's|PROGRESS_FILE = "/tmp/dspy_v32_progress.json"|PROGRESS_FILE = "/workspace/dspy-results/v32/progress.json"|g' scripts/dspy/bruce_dspy_optimizer_v32.py
mkdir -p dspy-results/v32

# === ETAPE 1: Verifier les fichiers ===
git status
git diff .gitignore

# === ETAPE 2: Ajouter les nouveaux fichiers ===
git add .gitignore
git add dell-7910/
git add scripts/dspy/gold-sets/
git add scripts/dspy/prompts/
git add scripts/dspy/bruce_dspy_generic.py
git add scripts/dspy/VALIDATION_REPORT.md
git add scripts/dspy/archive-unvalidated/
git add scripts/dspy/bruce_dspy_optimizer_v32.py

# === ETAPE 3: Commit ===
git commit -m "feat: Git sync audit - rescue DSPy gold sets + Dell 7910 scripts

Session 1243 Opus P0: Tout ce qui n'est pas personnel doit etre dans Git.

Nouveaux fichiers:
- dell-7910/: scripts benchmark (v1-v4b), llm-ops, model inventory
- scripts/dspy/gold-sets/: 3 gold sets valides (kb_audit, 32b_alpha, 14b_review)
- scripts/dspy/prompts/: best trial 11 prompt (84.83%)
- scripts/dspy/bruce_dspy_generic.py: optimizer multi-tache
- scripts/dspy/VALIDATION_REPORT.md: rapport validation detaille

Corrections:
- .gitignore: ajout *.gguf, secrets, dspy_cache
- bruce_dspy_optimizer_v32.py: paths corriges vers /workspace/

Archives (non valides):
- scripts/dspy/archive-unvalidated/: fichiers avec gold sets manquants ou incompatibles"

# === ETAPE 4: Push vers les deux remotes ===
git push forgejo main
git push github main

# === VERIFICATION ===
git log --oneline -5
git remote -v
