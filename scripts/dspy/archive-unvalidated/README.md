# DSPy Archive — Unvalidated Files

Ces fichiers ont ete recuperes mais ne sont pas directement utilisables:

## temp_gold_moe_optA.json
- PROBLEME: Champ "expected_card" au lieu de "expected_triage" attendu par bruce_dspy_moe_labeled.py
- ACTION: Renommer le champ expected_card -> expected_triage pour compatibilite

## temp_gold_14b.json / temp_gold_14b_v2.json
- Supercedes par temp_gold_14b_v3.json (20 exemples vs 15)
- Gardes pour reference historique

## bruce_dspy_session_summary.py
- Gold set manquant: dspy_gold_session_summary_v1.json non retrouve
- Script fonctionnel mais inutilisable sans gold set

## bruce_dspy_moe_labeled.py
- Gold set reference (dspy_gold_moe_triage_v3.json) non retrouve
- temp_gold_moe_optA.json existe mais champ incompatible
