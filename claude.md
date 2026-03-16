# claude.md — BRUCE Index v6
# Lu automatiquement a chaque session. ~50 lignes. Ne PAS gonfler.
# Tout le contenu detaille est dans KB Supabase (Tier 2). Ceci est un index.

## IDENTITE
Assistant IA de Yann. Plateforme: Claude Desktop Windows (PAS claude.ai).
Projet BRUCE = homelab intelligent, memoire Supabase .146.
Gateway MCP: 192.168.2.230:4000 (Bearer bruce-secret-token-01).

## HIERARCHIE SOURCES VERITE (5 tiers)
Tier 0 - claude.md: Cet index. Pointeur, pas contenu. ~800 tokens.
Tier 1 - Bootstrap gateway: Contexte operationnel recalcule par topic. POST /bruce/bootstrap.
Tier 2 - KB Supabase: Regles, anti-patterns, runbooks, architecture. Source canonique permanente.
Tier 3 - Memory MCP: Etat session ephemere (BRUCE_SESSION, BRUCE_ALERTS). Flush entre sessions.
Tier 4 - Lessons + RAG: Archive profonde. semantic_search pendant session, jamais au bootstrap.

## DEMARRAGE (3 etapes)
1. POST /bruce/bootstrap {topic:"...", model:"opus", include_tasks:false}
   Retourne: integrite, dashboard, handoff, outils et regles par topic
2. Memory MCP open_nodes ["BRUCE_SESSION"] pour handoff
3. Resume compact. Travailler.

NE PAS faire semantic_search au bootstrap. Le bootstrap injecte deja le contexte par topic.

## 3 REGLES D OR
1. Gateway-first: tout passe par .230:4000. MCP natifs = debug only.
2. Staging-first: toute ecriture -> staging_queue. Jamais INSERT direct (sauf roadmap).
3. Documenter-first: apres chaque tache -> session close + KB si pertinent.

## OU TROUVER L INFO (tout dans KB Supabase)
- Anti-patterns: KB category=governance, subcategory=anti-patterns
- Runbooks: KB category=runbook (ssh-pattern, file-transfer, supabase-auth, fallback)
- Infrastructure: KB category=infrastructure (network-map, ssh-access)
- Schema DB: KB category=schema
- Architecture: KB category=architecture
- Profil Yann: KB category=user_profile
- Outils: bruce_tools table (103 entrees, 23 categories)
- Endpoints: GET /openapi.json (56+ endpoints)

## PATTERN SSH (raccourci — detail dans KB runbook/ssh-pattern)
Preferer Desktop Commander start_process pour SSH.
Start-Job + Wait-Job -Timeout 25. Cle: C:\Users\Administrator\.ssh\homelab_key

## FIN DE SESSION
1. Memory MCP: add_observations sur BRUCE_SESSION (handoff pour prochaine session)
2. POST /bruce/session/close {session_id, summary, handoff_next}
