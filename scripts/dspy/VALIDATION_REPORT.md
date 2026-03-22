# RAPPORT DE VALIDATION DSPy — Session 1243 Opus
# Date: 2026-03-22

## GOLD SETS

### 1. dspy_gold_kb_audit_v1.json — VALIDE
- Source: Windows claude_workspace
- Format: Array of {input_kb, expected_review} — correct pour tache kb_audit
- Exemples: 13 entries avec vrais IDs KB (687, 157, 452, 1103, 1102, 934, etc.)
- Donnees reelles: OUI — references .146, .230, .32, vLLM obsolete, migration Supabase
- Verdicts couverts: keep (5), archive (3), update (5) — bonne diversite
- Destination: /workspace/scripts/dspy/gold-sets/

### 2. dspy_gold_32b_alpha_v1.json — VALIDE
- Source: Windows claude_workspace
- Format: Array of {input_lesson, moe_triage, review_14b, expected_alpha} — pipeline 3 couches
- Exemples: 15 entries representant le pipeline complet MoE->14B->32B
- Donnees reelles: OUI — SSH blocks, symlinks claude.md, user wishes Yann
- Verdicts: confirm (5), upgrade (5), downgrade (3), override_archive (0) — bonne couverture
- Destination: /workspace/scripts/dspy/gold-sets/

### 3. temp_gold_moe_optA.json — PARTIEL
- Source: Windows claude_workspace
- Format: Array of {input_lesson, expected_card} — triage MoE
- Exemples: 16 entries avec IDs reels et synthetiques (9001-9016)
- PROBLEME: Champ "expected_card" au lieu de "expected_triage" attendu par bruce_dspy_moe_labeled.py
- PROBLEME: Le script reference dspy_gold_moe_triage_v3.json (non trouve)
- Contenu valide mais incompatible tel quel avec le script existant
- Destination: /workspace/scripts/dspy/archive-unvalidated/ (renommage de champ necessaire)

### 4. temp_gold_14b.json — VALIDE (supercede par v3)
- Source: Windows claude_workspace
- Format: Array of {input_lesson, moe_triage, expected_review} — review 14B
- Exemples: 15 entries avec vrais IDs BRUCE et lessons reelles
- Verdicts: keep, downgrade, upgrade, archive — bonne couverture
- NOTE: v3 existe avec 20 exemples = version superieure
- Destination: /workspace/scripts/dspy/archive-unvalidated/ (supercede par v3)

### 5. temp_gold_14b_v2.json — VALIDE (supercede par v3)
- Quasi-identique a v1, 15 exemples
- Destination: /workspace/scripts/dspy/archive-unvalidated/ (supercede par v3)

### 6. temp_gold_14b_v3.json — VALIDE (MEILLEURE VERSION)
- 20 exemples (vs 15 pour v1/v2) — plus complet
- Inclut entries supplementaires (9050-9056): deploiement, gateway write, cron, SSH
- Meilleure couverture des cas edge: Ollama obsolete, user_wish sacre, codellama
- Destination: /workspace/scripts/dspy/gold-sets/ (renomme: dspy_gold_14b_review_v3.json)

## SCRIPTS DSPy

### 7. bruce_dspy_generic.py — VALIDE
- Cible: 3 taches configurables (dedup, session_summary, kb_audit) via env
- Modele: Configurable via DSPY_MODEL_NAME
- Paths: /tmp/dspy_results (configurable via env) — OK
- Methodes: LabeledFewShot + BootstrapFewShot + BFSRS — JAMAIS MIPROv2
- Infra: .32:8000, token-abc123 — compatible
- Qualite: Production-ready, contient 3 modules complets avec metriques
- Destination: /workspace/scripts/dspy/

### 8. bruce_dspy_32b_alpha.py — VALIDE (paths a corriger)
- Cible: 32B Alpha arbitrage (couche 3 pipeline)
- Modele: openai/local-32b, timeout=300s
- PATHS A CORRIGER: RESULTS_DIR et GOLD_FILE pointent vers /home/furycom/ (hors Git)
- Methodes: LabeledFewShot(k=4) + LFS(k=6) + BFSRS
- Infra: .32:8000, token-abc123 — compatible
- Destination: /workspace/scripts/dspy/ (avec correction paths)

### 9. bruce_dspy_session_summary.py — PARTIEL
- Cible: Session summary, modele MoE 35B
- GOLD SET MANQUANT: dspy_gold_session_summary_v1.json NON TROUVE sur Windows
- Le script est fonctionnel mais inutilisable sans gold set
- Destination: /workspace/scripts/dspy/archive-unvalidated/ (gold set manquant)

### 10. bruce_dspy_moe_labeled.py — PARTIEL
- Cible: MoE triage LabeledFewShot
- GOLD SET INCOMPATIBLE: reference dspy_gold_moe_triage_v3.json (non trouve)
- temp_gold_moe_optA.json existe mais champ "expected_card" vs "expected_triage"
- Destination: /workspace/scripts/dspy/archive-unvalidated/ (gold set mismatch)

## PROMPT OPTIMISE

### 11. dspy_v32_best_trial11_backup.md — VALIDE
- Contenu: Instruction 7 (meilleur prompt) du v32 optimizer
- Score: 84.83% (trial 11) — progression complete documentee (13 trials)
- NON TRONQUE — texte complet du prompt d extraction memoire BRUCE
- Destination: /workspace/scripts/dspy/prompts/

## FICHIERS DEJA DANS LE REPO

### 12. gold_examples_v3.py — DEJA PRESENT
- 66KB, deja dans /workspace/scripts/dspy/gold_examples_v3.py
- PAS besoin de copier

### 13. bruce_dspy_optimizer_v32.py — DEJA PRESENT
- Deja dans /workspace/scripts/dspy/
- PATHS A CORRIGER: RESULTS_DIR=/home/furycom/dspy_results_v32 (hors Git)

## RESUME

| Fichier | Statut | Destination |
|---------|--------|-------------|
| dspy_gold_kb_audit_v1.json | VALIDE | gold-sets/ |
| dspy_gold_32b_alpha_v1.json | VALIDE | gold-sets/ |
| temp_gold_14b_v3.json | VALIDE | gold-sets/ (rename: dspy_gold_14b_review_v3.json) |
| bruce_dspy_generic.py | VALIDE | scripts/dspy/ |
| bruce_dspy_32b_alpha.py | VALIDE | scripts/dspy/ (fix paths) |
| dspy_v32_best_trial11_backup.md | VALIDE | scripts/dspy/prompts/ |
| temp_gold_moe_optA.json | PARTIEL | archive-unvalidated/ |
| temp_gold_14b.json | SUPERCEDE | archive-unvalidated/ |
| temp_gold_14b_v2.json | SUPERCEDE | archive-unvalidated/ |
| bruce_dspy_session_summary.py | PARTIEL | archive-unvalidated/ |
| bruce_dspy_moe_labeled.py | PARTIEL | archive-unvalidated/ |
