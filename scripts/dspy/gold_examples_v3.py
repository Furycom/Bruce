#!/usr/bin/env python3
"""
gold_examples_v3.py — 45 gold examples pour DSPy MIPROv2
Session Opus 161b — Tâche [648]

Distribution:
  - Technique homelab (solutions, diagnostics): 10 (8 train + 2 test)
  - Règles Yann (decisions, rule_canon): 8 (6 train + 2 test)
  - Architecture (design, pipeline): 6 (5 train + 1 test)
  - Conversations ChatGPT (QA, wishes): 5 (4 train + 1 test)
  - Bruit/rejection: 7 (5 train + 2 test)
  - Warnings/problèmes: 5 (4 train + 1 test)
  - Infrastructure (services, config): 4 (3 train + 1 test)
  Total: 45 (35 train / 10 test)

Chaque exemple basé sur de vraies données BRUCE (lessons, KB, sessions).
"""
import dspy

GOLD_EXAMPLES = [

    # ============================================================
    # CATÉGORIE 1: TECHNIQUE HOMELAB (solutions, diagnostics)
    # ============================================================

    # [TRAIN-01] Solution SSH non-bloquant — basé sur lesson réelle
    dspy.Example(
        text="On a découvert que SSH via invoke_expression bloque complètement le terminal PowerShell. Le processus reste en attente indéfiniment. La solution trouvée: utiliser Start-Job avec Wait-Job -Timeout 25 pour garder le contrôle. Si timeout, Stop-Job récupère la main. Pour les scripts complexes avec guillemets imbriqués SSH+PowerShell, passer par SCP en 2 étapes plutôt que l'inline.",
        source="Session BRUCE 14 - debugging SSH",
        lessons_json='[{"lesson_type":"solution","lesson_text":"SSH via invoke_expression bloque le terminal PowerShell indéfiniment. Solution: Start-Job + Wait-Job -Timeout 25. Stop-Job en fallback. Pour scripts complexes, SCP en 2 étapes.","importance":"critical","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Comment exécuter SSH depuis PowerShell sans bloquer le terminal?","answer":"Utiliser Start-Job: $job = Start-Job -ScriptBlock { ssh -i key user@host commande }; $job | Wait-Job -Timeout 25 | Receive-Job. Stop-Job en cas de timeout. Pour scripts complexes avec guillemets imbriqués, utiliser SCP en 2 étapes.","category":"ssh","tags":["powershell","ssh","non-bloquant"]}]',
        decisions_json='[{"decision_text":"SSH toujours via Start-Job, jamais invoke_expression directe","rationale":"invoke_expression bloque le terminal indéfiniment","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="SSH bloque PowerShell via invoke_expression. Solution: Start-Job + Wait-Job -Timeout."
    ).with_inputs("text", "source"),

    # [TRAIN-02] Bug double /rest/v1 — basé sur lesson #789
    dspy.Example(
        text="Bug trouvé dans le container mcp-gateway: la variable SUPABASE_URL contenait déjà /rest/v1, et le code ajoutait /rest/v1 une deuxième fois. Résultat: toutes les requêtes Supabase partaient vers /rest/v1/rest/v1 et retournaient 404. Le fix: retirer le suffixe de la variable d'env et le laisser seulement dans le code.",
        source="Session BRUCE 20",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Bug SUPABASE_URL double /rest/v1 dans container mcp-gateway: la variable d env contenait déjà /rest/v1, et le code ajoutait /rest/v1 une 2e fois -> 404. Fix: retirer le suffixe de la variable d env.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Pourquoi le container mcp-gateway retourne 404 sur toutes les requêtes Supabase?","answer":"Vérifier si SUPABASE_URL contient déjà /rest/v1. Le code server.js ajoute /rest/v1 automatiquement. Si la variable contient déjà le suffixe, les requêtes partent vers /rest/v1/rest/v1 -> 404.","category":"debugging","tags":["supabase","mcp-gateway","env","404"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Bug double /rest/v1 dans SUPABASE_URL du container mcp-gateway causait des 404."
    ).with_inputs("text", "source"),

    # [TRAIN-03] Docker compose restart vs up — basé sur lesson #2502
    dspy.Example(
        text="Piège classique Docker: docker compose restart NE relit PAS les variables d'environnement du .env. Si on change le .env et fait restart, les anciens valeurs persistent. Il faut faire docker compose down puis docker compose up -d pour que les nouvelles valeurs soient prises en compte. On s'est fait avoir pendant la migration Supabase.",
        source="Session Opus 140 - migration Supabase",
        lessons_json='[{"lesson_type":"warning","lesson_text":"docker compose restart NE relit PAS le fichier .env. Si les variables d environnement changent, il faut docker compose down + up -d. restart ne suffit pas.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Pourquoi mes variables d environnement Docker ne sont pas prises en compte après restart?","answer":"docker compose restart ne relit pas le .env. Les variables restent celles du dernier up. Solution: docker compose down puis docker compose up -d pour forcer la relecture du .env.","category":"docker","tags":["compose","restart","env","piege"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="docker compose restart ne relit pas .env. Utiliser down + up -d pour appliquer les changements."
    ).with_inputs("text", "source"),

    # [TRAIN-04] Diagnostic disque VM103 — basé sur lesson #904
    dspy.Example(
        text="Analyse disque critique sur VM103 mcp-gateway (.230): 37GB total, 32GB utilisé, seulement 2.9GB libre soit 92 pourcent. Les plus gros consommateurs: Docker images et containers 18GB, les logs dans /var/log 4.2GB, le répertoire /home/furycom avec tous les scripts et backups 6GB. Il faut nettoyer les images Docker inutilisées et rotater les logs.",
        source="Session BRUCE 79 - audit infrastructure",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"VM103 mcp-gateway (.230) disque critique: 37GB total, 32GB utilisé (92%). Docker images 18GB, logs 4.2GB, /home/furycom 6GB. Nettoyer images Docker inutilisées et rotater logs.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quel est l état du disque VM103 mcp-gateway et comment le nettoyer?","answer":"37GB total, 32GB utilisé (92%). Gros consommateurs: Docker images/containers 18GB, /var/log 4.2GB, /home/furycom 6GB. Actions: docker system prune pour images inutilisées, rotation logs, archiver scripts one-shot.","category":"infrastructure","tags":["vm103","disque","docker","nettoyage"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Disque VM103 (.230) à 92%. Docker 18GB, logs 4.2GB. Nettoyage nécessaire."
    ).with_inputs("text", "source"),

    # [TRAIN-05] LiteLLM healthcheck fix — basé sur lesson #1443
    dspy.Example(
        text="LiteLLM était marqué unhealthy dans Docker parce que le healthcheck utilisait CMD curl mais l'image LiteLLM n'a pas curl installé. Le fix: changer le healthcheck pour utiliser wget à la place, ou mieux, utiliser le CMD python avec urllib qui est toujours présent. On a aussi changé l'interval de 10s à 30s pour éviter les faux positifs au démarrage.",
        source="Session Sonnet 82 - fix LiteLLM",
        lessons_json='[{"lesson_type":"solution","lesson_text":"LiteLLM unhealthy: healthcheck utilisait CMD curl mais curl absent de l image. Fix: utiliser wget ou python urllib. Aussi augmenter interval à 30s pour éviter faux positifs au démarrage.","importance":"normal","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Pourquoi LiteLLM est marqué unhealthy dans Docker?","answer":"Le healthcheck utilise curl mais l image LiteLLM n inclut pas curl. Fix: remplacer par wget ou python -c avec urllib. Augmenter l interval à 30s pour éviter les faux positifs au démarrage lent.","category":"debugging","tags":["litellm","docker","healthcheck"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="LiteLLM unhealthy: curl absent de l image Docker. Fix: wget ou python urllib."
    ).with_inputs("text", "source"),

    # [TRAIN-06] Séquences ID non alignées après migration — basé sur lesson #2504
    dspy.Example(
        text="Après la migration manuelle Supabase de .206 vers .146, les séquences PostgreSQL n'étaient pas alignées. On avait inséré des rows avec des IDs explicites (genre INSERT INTO lessons_learned (id, ...) VALUES (500, ...)) mais la séquence auto-increment était encore à 1. Du coup le prochain INSERT sans ID explicite essayait id=1, collision avec un existant. Fix: SELECT setval pour réaligner chaque séquence au MAX(id) de la table.",
        source="Session Opus 140 - migration Supabase",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Après migration manuelle avec IDs explicites, les séquences PostgreSQL ne sont pas alignées. Le prochain INSERT auto-increment cause une collision. Fix: SELECT setval sur chaque séquence au MAX(id)+1.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment réaligner les séquences PostgreSQL après une migration avec IDs explicites?","answer":"Utiliser SELECT setval(pg_get_serial_sequence(table, id), MAX(id)) FROM table pour chaque table migrée. Sans ça, le prochain INSERT auto-increment essaie un ID déjà existant et échoue.","category":"database","tags":["postgresql","sequences","migration","setval"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Séquences PostgreSQL désalignées après migration manuelle. Fix: setval au MAX(id)."
    ).with_inputs("text", "source"),

    # [TRAIN-07] Opérateur && invalide PowerShell — basé sur lesson #797
    dspy.Example(
        text="L'opérateur && n'est pas un séparateur valide dans PowerShell classique. Il faut utiliser le point-virgule pour chaîner les commandes. Exemple: au lieu de cd /tmp && ls, faire cd /tmp ; ls. Aussi, dans les commandes SSH passées depuis PowerShell, attention au mélange: le && fonctionne dans le shell distant (bash) mais pas dans la commande PowerShell locale qui l'enveloppe.",
        source="Session BRUCE 14",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"Opérateur && invalide dans PowerShell. Utiliser point-virgule (;) pour chaîner les commandes. Attention au mélange: && fonctionne dans bash distant via SSH mais pas dans PowerShell local.","importance":"normal","confidence_score":0.9}]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[{"question":"Pourquoi && ne fonctionne pas dans PowerShell?","answer":"&& n est pas un opérateur valide dans PowerShell classique. Utiliser le point-virgule (;) pour chaîner les commandes. Dans les commandes SSH, && fonctionne côté bash distant mais pas dans le wrapper PowerShell local.","category":"conversation-qa","tags":["powershell","syntaxe"]}]',
        summary="&& invalide dans PowerShell, utiliser point-virgule. Fonctionne dans bash distant via SSH."
    ).with_inputs("text", "source"),

    # [TRAIN-08] node_exporter firewall fix — basé sur lesson #2433
    dspy.Example(
        text="node_exporter sur .32 (furycomai) était inaccessible depuis Prometheus sur .154. Le diagnostic initial de Sonnet disait que c'était un firewall Proxmox au niveau hyperviseur, ce qui était faux. La vraie cause: ufw sur la VM .32 bloquait le port 9100. Fix: sudo ufw allow from 192.168.2.0/24 to any port 9100. Toujours vérifier ufw sur la VM elle-même avant de soupçonner l'hyperviseur.",
        source="Session Opus 134 - fix monitoring",
        lessons_json='[{"lesson_type":"solution","lesson_text":"node_exporter .32 inaccessible depuis Prometheus .154: cause = ufw sur la VM bloquait port 9100, PAS firewall Proxmox hyperviseur. Fix: sudo ufw allow from 192.168.2.0/24 to any port 9100.","importance":"normal","confidence_score":1.0},{"lesson_type":"diagnostic","lesson_text":"Correction diagnostic Sonnet: Sonnet avait conclu firewall Proxmox au niveau hyperviseur, c était faux. Toujours vérifier ufw sur la VM elle-même en premier.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Pourquoi node_exporter est inaccessible depuis un autre serveur du réseau?","answer":"Vérifier ufw sur la VM elle-même: sudo ufw status. Si port 9100 bloqué, ouvrir avec sudo ufw allow from 192.168.2.0/24 to any port 9100. Ne pas supposer un firewall hyperviseur Proxmox sans preuve.","category":"debugging","tags":["node_exporter","ufw","firewall","prometheus"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="node_exporter bloqué par ufw sur la VM, pas par Proxmox. Fix: ufw allow port 9100."
    ).with_inputs("text", "source"),

    # ============================================================
    # CATÉGORIE 2: RÈGLES YANN (decisions, rule_canon)
    # ============================================================

    # [TRAIN-09] Règle consolidation — basé sur current_state réel
    dspy.Example(
        text="Yann insiste: toujours consolider et documenter dans Supabase avant de passer à la tâche suivante. Ne jamais enchaîner sans avoir enregistré. S'arrêter régulièrement pour faire le point. Si la session crashe, rien ne doit être perdu. Toute découverte, idée, redéfinition de priorité doit être notée immédiatement, pas à la fin.",
        source="Session BRUCE 15 - règles Yann",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: Toujours consolider et documenter dans Supabase avant d avancer à la prochaine tâche. Ne jamais enchaîner sans avoir enregistré. Noter immédiatement, pas à la fin.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Documentation obligatoire dans Supabase entre chaque tâche","rationale":"Si la session crashe, rien ne doit être perdu. Petites étapes validées plutôt que grandes sessions non documentées.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"style_travail","value":"Yann préfère les petites étapes validées et documentées plutôt que les grandes sessions continues","category":"style"}]',
        conversation_qa_json='[]',
        summary="Règle Yann: documenter systématiquement dans Supabase entre chaque tâche. Rien ne doit être perdu."
    ).with_inputs("text", "source"),

    # [TRAIN-10] Règle ne pas modifier ce qui fonctionne — basé sur current_state réel
    dspy.Example(
        text="Yann: Je veux qu'on arrête de toucher aux trucs qui marchent. Chaque fois qu'on essaie d'améliorer quelque chose qui fonctionne, on casse autre chose. La stabilité prime sur l'amélioration. Si ça marche, on n'y touche pas sauf si on a une raison explicite et approuvée.",
        source="Session BRUCE - règle stabilité",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: Ne jamais modifier ce qui fonctionne sans raison explicite et approuvée. La stabilité prime sur l amélioration.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Ne pas modifier ce qui fonctionne sans raison explicite","rationale":"Chaque amélioration non nécessaire risque de casser autre chose. Stabilité prioritaire.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"valeur_stabilite","value":"Yann valorise la stabilité au-dessus de l amélioration incrémentale. Ne toucher que ce qui a une raison explicite.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Règle Yann: ne jamais modifier ce qui fonctionne sans raison explicite. Stabilité prime."
    ).with_inputs("text", "source"),

    # [TRAIN-11] Hiérarchie LLM — basé sur lesson #2474
    dspy.Example(
        text="Yann définit la hiérarchie de confiance: Scripts sont en bas, puis vLLM local, puis ChatGPT, puis Sonnet, puis Opus, puis Humain c'est-à-dire Yann au sommet. Règles de résolution de contradictions: la date récente gagne sauf si la source est trop basse. Un script ne peut pas renverser Opus ou l'humain. Ce qui est rejeté est archivé, jamais effacé. Le routeur de difficulté: évident va au script, subtil va au LLM, risque va à Opus ou l'humain.",
        source="Convo conscience BRUCE 2026-02-27",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"HIÉRARCHIE LLM BRUCE: Scripts < vLLM local < ChatGPT < Sonnet < Opus < Humain (Yann). Date récente gagne sauf source trop basse. Rejeté = archivé jamais effacé. Routeur difficulté: évident->script, subtil->LLM, risque->Opus/humain.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Hiérarchie de confiance LLM avec résolution par date et niveau de source","rationale":"Un script ne doit pas renverser une décision Opus ou humaine. Le rejeté est archivé, pas effacé.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[{"question":"Comment BRUCE résout les contradictions entre sources?","answer":"Hiérarchie: Scripts < vLLM < ChatGPT < Sonnet < Opus < Yann. Date récente gagne sauf source trop basse. Rejeté archivé jamais effacé. Routeur: évident->script, subtil->LLM, risque->Opus/humain.","category":"conversation-qa","tags":["hierarchie","confiance","resolution"]}]',
        summary="Hiérarchie LLM BRUCE définie par Yann. Résolution par date et niveau de source."
    ).with_inputs("text", "source"),

    # [TRAIN-12] Règle base parfaite — basé sur current_state réel
    dspy.Example(
        text="Yann est catégorique: la base doit être parfaite. Ce qui y entre doit être parfait. Aucune erreur tolérée. Ne pas procrastiner, régler les problèmes de qualité une fois pour toutes. Travailler fort à la source, à la base. Zéro tolérance pour le contenu sous-standard. Ne pas déclarer victoire sur la qualité après un seul audit.",
        source="Session Opus 125 - règle qualité",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: La base doit être parfaite. Ce qui y entre doit être parfait. Aucune erreur tolérée. Zéro tolérance pour le contenu sous-standard. Ne pas déclarer victoire après un seul audit.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Zéro tolérance qualité sur les données BRUCE","rationale":"La base est la fondation de tout. Contenu sous-standard pollue tout ce qui se construit dessus.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"exigence_qualite","value":"Yann exige la perfection des données. Zéro tolérance pour le contenu sous-standard dans Supabase.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Règle Yann: base parfaite, zéro tolérance contenu sous-standard, pas de victoire prématurée."
    ).with_inputs("text", "source"),

    # [TRAIN-13] Décision pas de nouvelles technos — basé sur lesson #2382
    dspy.Example(
        text="Yann tranche: on n'ajoute pas de nouvelle technologie comme Neo4j, Zep, ou Graphiti. Le problème ce n'est pas les outils, c'est la qualité des données. Travailler avec ce qu'on a déjà: Supabase, pgvector, le pipeline staging. Quand la base sera propre et solide, là on pourra évaluer si on a besoin de plus.",
        source="Session Opus 117 - décision Yann",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"DECISION YANN: Ne pas ajouter nouvelle technologie (Neo4j, Zep, Graphiti). Le problème est la qualité des données, pas les outils. Travailler avec Supabase, pgvector, pipeline staging existant.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Pas de nouvelle technologie tant que la base n est pas propre","rationale":"Le problème est la qualité des données, pas les outils. Supabase + pgvector + staging suffisent.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"pragmatisme_outils","value":"Yann préfère optimiser les outils existants plutôt qu ajouter de nouvelles technologies","category":"preference"}]',
        conversation_qa_json='[]',
        summary="Décision Yann: pas de nouvelles technos. Qualité données d abord avec outils existants."
    ).with_inputs("text", "source"),

    # [TRAIN-14] Rollback certain — basé sur lesson REGLE_YANN_ROLLBACK_CERTAIN
    dspy.Example(
        text="Nouvelle règle de Yann pour BRUCE: agir SEULEMENT si le rollback est certain. Rollback certain signifie une sauvegarde réelle plus un pipeline testé au vert. Une procédure écrite sur papier mais non testée ne vaut pas un rollback. La gradation: on commence par lecture seule, puis actions approuvées, puis automatisation progressive.",
        source="Convo conscience BRUCE 2026-02-27",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: BRUCE agit SEULEMENT si rollback certain. Rollback certain = sauvegarde réelle + pipeline testé au vert. Procédure papier non testée ne vaut pas rollback. Gradation: lecture seule -> actions approuvées -> automatisation progressive.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"BRUCE n agit que si le rollback est garanti","rationale":"Sauvegarde réelle + pipeline testé. Pas de confiance dans des procédures non testées.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Règle Yann: agir seulement si rollback certain. Sauvegarde réelle + pipeline testé."
    ).with_inputs("text", "source"),

    # ============================================================
    # CATÉGORIE 3: ARCHITECTURE (design, pipeline)
    # ============================================================

    # [TRAIN-15] Pipeline staging — basé sur architecture réelle
    dspy.Example(
        text="Le pipeline d'écriture Supabase est strict et non négociable. Toute donnée passe par staging_queue avec table_cible et contenu_json. Puis conflict_detector.py vérifie les doublons et contradictions. Puis validate.py avec les quality gates promeut en canon. On n'écrit JAMAIS directement dans les tables canoniques. Les colonnes staging_queue sont: table_cible TEXT, contenu_json JSONB, status TEXT, author_system TEXT.",
        source="Architecture BRUCE - pipeline écriture",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Pipeline écriture BRUCE: staging_queue (table_cible + contenu_json) -> conflict_detector.py -> validate.py quality gates -> tables canon. Jamais d écriture directe dans les tables canon.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment fonctionne le pipeline d écriture Supabase BRUCE?","answer":"staging_queue (table_cible TEXT, contenu_json JSONB, status TEXT, author_system TEXT) -> conflict_detector.py (doublons/contradictions) -> validate.py (quality gates + promotion canon). JAMAIS d écriture directe dans les tables canoniques.","category":"pipeline","tags":["staging","validate","architecture"]}]',
        decisions_json='[{"decision_text":"Écriture Supabase uniquement via staging_queue, jamais directe","rationale":"Assure détection doublons, audit trail, et quality gates","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Pipeline strict: staging_queue -> conflict_detector -> validate -> canon. Jamais d écriture directe."
    ).with_inputs("text", "source"),

    # [TRAIN-16] Architecture multi-projets — basé sur lesson #2421
    dspy.Example(
        text="L'architecture multi-projets BRUCE utilise 3 couches. Couche 1: champ project_scope sur les tables canon avec 4 valeurs (homelab, musique, domotique, general). Couche 2: registre project_keywords_registry dans current_state qui mappe les mots-clés vers les projets. Couche 3: le context_router dans session/init filtre par project_scope. Un contenu ambigu va dans general par défaut.",
        source="Session Opus 128 - design multi-projets",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Architecture multi-projets BRUCE en 3 couches: (1) champ project_scope sur tables canon (homelab/musique/domotique/general), (2) registre project_keywords_registry dans current_state, (3) context_router filtrant par scope dans session/init. Ambigu -> general.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment BRUCE gère les différents projets (homelab, musique, domotique)?","answer":"3 couches: (1) Champ project_scope sur tables canon (4 valeurs: homelab, musique, domotique, general). (2) Registre project_keywords_registry mappant mots-clés vers projets. (3) context_router dans session/init filtre par scope. Contenu ambigu -> general par défaut.","category":"architecture","tags":["multi-projets","scope","context_router"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Architecture multi-projets BRUCE: 3 couches (project_scope, keywords_registry, context_router)."
    ).with_inputs("text", "source"),

    # [TRAIN-17] Services tmux vulnérables — basé sur lesson réelle
    dspy.Example(
        text="Les services embed_worker et validate_service sur .230 tournent dans des sessions tmux, pas en systemd. Un reboot de .230 les tue silencieusement. Après chaque reboot, il faut vérifier tmux ls et relancer manuellement si nécessaire. embed_worker est dans la session tmux nommée embed, validate_service dans validate_svc sur le port 4001.",
        source="Session BRUCE 16 - services tmux",
        lessons_json='[{"lesson_type":"warning","lesson_text":"embed_worker et validate_service sur .230 tournent en tmux, pas systemd. Un reboot les tue silencieusement. Vérifier tmux ls après chaque reboot de .230.","importance":"critical","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Que faire après un reboot de .230?","answer":"Vérifier tmux ls. Services critiques: embed_worker (session tmux embed), validate_service (session tmux validate_svc, port 4001). Si absents, les relancer manuellement. Pas de systemd.","category":"services","tags":["tmux","reboot","230"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="embed_worker et validate_service en tmux sur .230. Vulnérables au reboot, vérifier tmux ls."
    ).with_inputs("text", "source"),

    # [TRAIN-18] Trigger text discoverabilité — basé sur lesson #2419
    dspy.Example(
        text="Pour rendre les outils bruce_tools trouvables par recherche sémantique, on a ajouté une colonne trigger_text sur la table. C'est un tableau de phrases qui décrivent quand utiliser l'outil. Exemple pour push_to_staging.py: écrire supabase, ajouter lesson, staging, pipeline écriture. L'embed_worker indexe ces trigger_texts comme des chunks RAG. Score de recherche confirmé: 0.70 à 0.79.",
        source="Session Opus 126 - discoverabilité outils",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Discoverabilité bruce_tools: colonne trigger_text (tableau phrases) ajoutée. L embed_worker indexe comme chunks RAG. Scores recherche sémantique: 0.70-0.79. Rend les outils trouvables par question naturelle.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment rendre les outils bruce_tools trouvables par recherche sémantique?","answer":"Colonne trigger_text sur bruce_tools: tableau de phrases décrivant quand utiliser l outil. L embed_worker indexe ces phrases comme chunks RAG. Permet de trouver l outil par question naturelle avec scores 0.70-0.79.","category":"tools","tags":["bruce_tools","trigger_text","rag","discoverabilite"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="trigger_text sur bruce_tools pour discoverabilité sémantique. Indexé par embed_worker."
    ).with_inputs("text", "source"),

    # [TRAIN-19] Magasin outils vs services — basé sur lesson #2475
    dspy.Example(
        text="Yann clarifie la distinction entre le magasin d'outils et la liste de services. Les services c'est les machines, VMs, containers, ports, IPs. Les outils c'est les scripts, APIs, frameworks, comment les utiliser et quand. La table bruce_tools contient les deux mais ils doivent être séparés conceptuellement. Un outil a un trigger_text, un when_to_use, un how_to_run. Un service a un host, un port, une URL.",
        source="Convo conscience 2026-02-27",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Distinction magasin outils vs liste services. Services = machines/VMs/containers/ports/IPs. Outils = scripts/APIs/frameworks avec trigger_text, when_to_use, how_to_run. Les deux dans bruce_tools mais conceptuellement séparés.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Distinguer outils (scripts/APIs) et services (machines/VMs) dans bruce_tools","rationale":"Un outil a trigger_text, when_to_use, how_to_run. Un service a host, port, URL. Conceptuellement différents même si dans la même table.","importance":"normal"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Distinction outils vs services dans bruce_tools: scripts avec trigger/usage vs machines avec host/port."
    ).with_inputs("text", "source"),

    # ============================================================
    # CATÉGORIE 4: CONVERSATIONS ChatGPT (QA, wishes)
    # ============================================================

    # [TRAIN-20] Homepage dashboard — basé sur vraie convo ChatGPT
    dspy.Example(
        text="Yann: Est-ce que Homepage pourrait servir de tableau de bord principal pour BRUCE? ChatGPT: Oui, Homepage de gethomepage.dev est excellent pour ça. Il supporte les widgets dynamiques et une API REST. Tu pourrais avoir 3 zones: santé système, tâches et automatisations, mémoire et connaissances. Yann: Et BRUCE peut écrire dedans? ChatGPT: Oui, Homepage expose une API. BRUCE met à jour les widgets via HTTP après backup de la config.",
        source="ChatGPT BRUCE homelab no1",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Homepage (gethomepage.dev) choisi comme tableau de bord BRUCE. 3 zones: santé système, tâches/automatisations, mémoire/connaissances. BRUCE écrit via API REST après backup config.","importance":"critical","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Comment utiliser Homepage comme dashboard BRUCE?","answer":"Homepage (gethomepage.dev) supporte widgets dynamiques et API REST. Structure: 3 zones (santé système, tâches/automatisations, mémoire/connaissances). BRUCE écrit via HTTP REST après backup automatique.","category":"architecture","tags":["homepage","dashboard","api","widgets"]}]',
        decisions_json='[{"decision_text":"Homepage choisi comme tableau de bord principal BRUCE","rationale":"Supporte API REST, widgets dynamiques, léger, très configurable","importance":"critical"}]',
        wishes_json='[{"wish_text":"Yann souhaite que BRUCE puisse écrire automatiquement dans Homepage pour afficher l état du système en temps réel","importance":"critical"}]',
        user_profile_json='[]',
        conversation_qa_json='[{"question":"BRUCE peut-il écrire dans Homepage?","answer":"Oui, Homepage expose une API REST. BRUCE met à jour les widgets via HTTP après backup automatique de la config.","category":"conversation-qa","tags":["homepage","api","bruce"]}]',
        summary="Homepage choisi comme dashboard BRUCE avec 3 zones. Écriture via API REST."
    ).with_inputs("text", "source"),

    # [TRAIN-21] Alertes Grafana automatiques — basé sur vraie convo
    dspy.Example(
        text="Yann: Je voudrais que BRUCE crée automatiquement des tâches quand Grafana détecte une alerte, sans intervention de ma part. ChatGPT: C'est faisable via pipeline: alerte Grafana déclenche un webhook n8n, le workflow n8n appelle le MCP Server BRUCE qui crée la tâche dans la roadmap Supabase. Totalement automatique. Le MCP Server expose les fonctions BRUCE comme des outils appelables.",
        source="ChatGPT BRUCE session 2026-02-25",
        lessons_json='[]',
        knowledge_base_json='[{"question":"Comment connecter les alertes Grafana à la création automatique de tâches BRUCE?","answer":"Pipeline: alerte Grafana -> webhook n8n -> workflow n8n -> appel MCP Server BRUCE -> création tâche roadmap Supabase. Aucune intervention Yann. Le MCP Server expose les fonctions BRUCE comme outils appelables.","category":"workflow","tags":["grafana","n8n","mcp","automation","roadmap"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann souhaite que BRUCE crée automatiquement des tâches roadmap quand Grafana détecte une alerte, sans intervention manuelle","importance":"critical"}]',
        user_profile_json='[{"trait":"preference_autonomie","value":"Yann préfère que BRUCE agisse de façon autonome sur les alertes sans nécessiter son intervention","category":"preference"}]',
        conversation_qa_json='[{"question":"BRUCE peut-il créer des tâches automatiquement depuis Grafana?","answer":"Oui, via pipeline: alerte Grafana -> webhook n8n -> MCP Server BRUCE -> tâche Supabase roadmap. Entièrement automatique.","category":"conversation-qa","tags":["grafana","automation","mcp"]}]',
        summary="Yann veut création automatique de tâches depuis alertes Grafana via n8n + MCP."
    ).with_inputs("text", "source"),

    # [TRAIN-22] Backups Supabase — basé sur vraie convo
    dspy.Example(
        text="Yann: On devrait faire un backup de Supabase chaque nuit? ChatGPT: Absolument. pg_dump via cron sur TrueNAS. Mais le vrai danger c'est les backups qui échouent silencieusement. Chaque backup doit écrire une entrée dans events_log avec timestamp et taille. Un script vérifie chaque matin, et si absent, alerte Grafana immédiate. Pas de confiance aveugle.",
        source="ChatGPT BRUCE homelab no1",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Backups qui échouent silencieusement = vrai danger. Chaque backup doit écrire dans events_log (timestamp + taille). Si absent le lendemain -> alerte Grafana.","importance":"critical","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Comment implémenter des backups Supabase fiables?","answer":"pg_dump via cron TrueNAS + vérification active: chaque backup écrit dans events_log (timestamp, taille). Script matinal: si entrée absente -> alerte Grafana immédiate. Alternative: réplication logique Postgres.","category":"runbook","tags":["backup","supabase","grafana","events_log"]}]',
        decisions_json='[{"decision_text":"Les backups doivent écrire dans events_log pour détection d échec","rationale":"Un backup qui échoue sans alerte est pire que pas de backup","importance":"critical"}]',
        wishes_json='[{"wish_text":"Yann souhaite des backups Supabase automatiques chaque nuit avec alerte si échec","importance":"critical"}]',
        user_profile_json='[{"trait":"valeur_fiabilite","value":"Yann insiste sur la détection active des échecs plutôt que la confiance aveugle","category":"value"}]',
        conversation_qa_json='[]',
        summary="Backups Supabase via pg_dump + vérification active events_log. Alerte Grafana si absent."
    ).with_inputs("text", "source"),

    # [TRAIN-23] Extraction volume insuffisant — basé sur lesson réelle
    dspy.Example(
        text="Yann: On n'extrait pas assez d'informations de nos conversations. ChatGPT: Le prompt actuel est trop restrictif, il rejette tout ce qui est sous 80 caractères. On devrait aussi extraire les paires QA directement depuis les échanges. Chaque fois que tu poses une question et que je réponds, c'est une paire QA parfaite pour le RAG qu'on ignore actuellement.",
        source="Session BRUCE 111",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"Volume extraction insuffisant: seuils trop élevés (80 chars) + paires QA conversationnelles non extraites. Chaque échange question/réponse est une paire QA parfaite pour le RAG.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Abaisser seuils extraction et extraire les paires QA conversationnelles","rationale":"Trop d information utile perdue avec seuils actuels. Les QA sont la source de signal la plus riche.","importance":"critical"}]',
        wishes_json='[{"wish_text":"Yann souhaite que le pipeline extraie beaucoup plus d informations par conversation, notamment les paires QA","importance":"critical"}]',
        user_profile_json='[{"trait":"objectif_extraction","value":"Yann veut maximiser le signal extrait, pas filtrer agressivement","category":"goal"}]',
        conversation_qa_json='[{"question":"Pourquoi n extrait-on pas assez des conversations?","answer":"Seuils trop restrictifs (80 chars) + paires QA conversationnelles ignorées. Chaque échange Q/R est exploitable pour le RAG. Abaisser seuils et ajouter extraction QA.","category":"conversation-qa","tags":["extraction","qa","pipeline"]}]',
        summary="Extraction insuffisante: seuils trop élevés + paires QA ignorées. Maximiser le signal."
    ).with_inputs("text", "source"),

    # ============================================================
    # CATÉGORIE 5: BRUIT / REJECTION (le modèle doit apprendre à NE PAS extraire)
    # ============================================================

    # [TRAIN-24] Bavardage pur — pas de contenu technique
    dspy.Example(
        text="Yann: J'ai eu une longue journée. Je vais aller manger et on reprend demain. Bonne soirée! Claude: Bonne soirée Yann, repose-toi bien. On reprendra demain avec les idées fraîches.",
        source="Session fin de journée",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Fin de session, pas de contenu technique."
    ).with_inputs("text", "source"),

    # [TRAIN-25] Confirmation simple — pas de signal
    dspy.Example(
        text="OK je vais regarder ça. Donne-moi une minute. Bon, c'est fait. On continue? Oui parfait, on enchaîne.",
        source="Session BRUCE 5",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Échange conversationnel sans contenu technique."
    ).with_inputs("text", "source"),

    # [TRAIN-26] Réflexion vague sans action — bruit déguisé
    dspy.Example(
        text="On pourrait peut-être améliorer la fiabilité du système un jour. Il faudrait voir comment optimiser les performances. À un moment donné il va falloir centraliser tout ça. Mais bon, c'est pas pour maintenant, on verra plus tard.",
        source="Session BRUCE divagation",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Réflexions vagues sans action concrète ni information extractible."
    ).with_inputs("text", "source"),

    # [TRAIN-27] Échange social — pas d'info technique
    dspy.Example(
        text="Yann: Hey, tu sais que j'ai appris que TrueNAS Scale vient de sortir une nouvelle version? Claude: Oui, je pense que c'est Dragonfish. Yann: Exact! Bon, c'est pas pour nous pour l'instant mais c'est cool de voir le projet avancer. Comment ça va de ton côté?",
        source="Session BRUCE bavardage",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Bavardage social sur TrueNAS sans information actionnable."
    ).with_inputs("text", "source"),

    # [TRAIN-28] Répétition d'info connue — pas de nouvelle info
    dspy.Example(
        text="Pour rappel, Supabase est sur .146. La gateway est sur .230. Le MCP server tourne dans Docker. Prometheus est sur .154. Grafana aussi. Tout le monde sait ça.",
        source="Session BRUCE rappel",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Rappel d informations déjà connues, rien de nouveau à extraire."
    ).with_inputs("text", "source"),

    # ============================================================
    # CATÉGORIE 6: WARNINGS / PROBLÈMES
    # ============================================================

    # [TRAIN-29] Quality gate rejette Yann — basé sur lesson #2381
    dspy.Example(
        text="Problème critique: le quality gate de validate.py rejette des décisions de Yann. Gate 2 vLLM a rejeté une règle Yann comme Vague aspiration sans plan. Le pipeline ne distingue pas les décisions du patron des soumissions automatiques Claude. Fix appliqué: bypass quality gates si actor contient yann.",
        source="Session Opus 117 - bug quality gate",
        lessons_json='[{"lesson_type":"warning","lesson_text":"PROBLÈME CRITIQUE: quality gate validate.py rejette des décisions Yann. Gate 2 vLLM juge le texte sans contexte auteur. Fix: bypass quality gates si actor=yann.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Bypass quality gates pour actor=yann dans validate.py","rationale":"Les décisions de Yann ne doivent pas être filtrées par un LLM 7B","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Quality gate rejette décisions Yann. Fix: bypass si actor=yann."
    ).with_inputs("text", "source"),

    # [TRAIN-30] Bug validate.py bruce_tools — basé sur lesson #2546
    dspy.Example(
        text="Bug dans validate.py: il tente d'injecter les colonnes authority_tier et created_by dans bruce_tools, mais ces colonnes n'existent pas dans la table. Résultat: HTTP 400 à chaque insertion bruce_tools. La table bruce_tools a un schéma différent des tables canon standards. Fix: ajouter bruce_tools dans SIMPLE_TABLES et exclure ces colonnes.",
        source="Session 149 - bug validate",
        lessons_json='[{"lesson_type":"warning","lesson_text":"validate.py injecte authority_tier et created_by dans bruce_tools mais ces colonnes n existent pas -> HTTP 400. Fix: ajouter bruce_tools dans SIMPLE_TABLES et exclure colonnes inexistantes.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Pourquoi les insertions bruce_tools échouent dans validate.py?","answer":"validate.py injecte authority_tier et created_by automatiquement mais bruce_tools n a pas ces colonnes. Fix: ajouter bruce_tools dans SIMPLE_TABLES pour bypasser l injection automatique de ces colonnes.","category":"debugging","tags":["validate","bruce_tools","schema"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Bug validate.py: colonnes authority_tier/created_by inexistantes dans bruce_tools -> HTTP 400."
    ).with_inputs("text", "source"),

    # [TRAIN-31] SSH accès impossible box2 — basé sur lesson #2522
    dspy.Example(
        text="Impossible d'accéder en SSH à box2 Proxmox sur 192.168.2.103. Aucune clé SSH configurée pour root@192.168.2.103 sur le jump host .230. Les tentatives via furycom échouent aussi car le compte n'existe pas sur le Proxmox. Pour accéder à box2 il faut passer par l'interface web Proxmox ou configurer manuellement la clé SSH root.",
        source="Session 145 - accès SSH box2",
        lessons_json='[{"lesson_type":"warning","lesson_text":"SSH accès box2 Proxmox (.103) impossible: aucune clé SSH configurée pour root@.103 sur .230. Compte furycom inexistant sur Proxmox. Accès uniquement via interface web Proxmox.","importance":"normal","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Comment accéder à box2 Proxmox en SSH?","answer":"Actuellement impossible via SSH: aucune clé configurée pour root@192.168.2.103 et pas de compte furycom sur Proxmox. Accès via interface web Proxmox uniquement. Pour SSH, configurer manuellement la clé root.","category":"ssh","tags":["proxmox","box2","acces"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="SSH box2 Proxmox impossible: pas de clé, pas de compte furycom. Accès web seulement."
    ).with_inputs("text", "source"),

    # [TRAIN-32] Gateway ne supporte pas bruce_tools — basé sur lesson #2574
    dspy.Example(
        text="Découverte: le endpoint /bruce/write dans server.js n'accepte que 5 tables: lessons_learned, knowledge_base, current_state, roadmap, session_history. Pour insérer dans bruce_tools, il faut passer directement par le REST Supabase via staging_queue avec un POST. Le validate_service gère correctement bruce_tools depuis le fix v3.1.",
        source="Session Opus 161b",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Le endpoint /bruce/write n accepte que 5 tables canon. Pour bruce_tools: passer par staging_queue REST direct. validate.py v3.1+ gère bruce_tools correctement.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment insérer dans bruce_tools si /bruce/write refuse?","answer":"Le gateway /bruce/write n accepte que 5 tables (lessons_learned, knowledge_base, current_state, roadmap, session_history). Pour bruce_tools: POST directement sur /rest/v1/staging_queue avec table_cible=bruce_tools. validate.py v3.1+ le gère.","category":"pipeline","tags":["gateway","bruce_tools","staging"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Gateway /bruce/write limité à 5 tables. bruce_tools via staging_queue REST direct."
    ).with_inputs("text", "source"),

    # ============================================================
    # CATÉGORIE 7: INFRASTRUCTURE (services, config)
    # ============================================================

    # [TRAIN-33] Stack outils open-source — basé sur lesson réelle
    dspy.Example(
        text="Le pipeline d'ingestion BRUCE utilise une stack open-source: DSPy de Stanford pour l'optimisation auto des prompts Qwen 7B via MIPROv2. Instructor de 567-labs pour la validation Pydantic et retry auto JSON. Best-of-N avec 3 extractions multi-températures (0.3, 0.5, 0.7) fusionnées par SequenceMatcher. Et un nettoyeur clean_vllm_json pour les apostrophes françaises qui cassent le JSON.",
        source="Documentation technique BRUCE 2026-02",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Stack ingestion BRUCE open-source: DSPy (optimisation prompts MIPROv2), Instructor (validation Pydantic + retry JSON), Best-of-N (3 températures fusionnées SequenceMatcher), clean_vllm_json (apostrophes françaises).","importance":"normal","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Quels outils compose le pipeline d ingestion BRUCE?","answer":"4 composants: (1) DSPy Stanford - optimisation prompts MIPROv2 pour Qwen 7B. (2) Instructor 567-labs - validation Pydantic + retry JSON auto. (3) Best-of-N - 3 extractions multi-temp (0.3/0.5/0.7) fusionnées SequenceMatcher. (4) clean_vllm_json - nettoyage apostrophes françaises.","category":"tools","tags":["dspy","instructor","ingestion","vllm"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Stack ingestion BRUCE: DSPy + Instructor + Best-of-N + clean_vllm_json."
    ).with_inputs("text", "source"),

    # [TRAIN-34] Tables canoniques Supabase — basé sur architecture réelle
    dspy.Example(
        text="Les tables canoniques de Supabase BRUCE sont: lessons_learned pour les leçons techniques, knowledge_base pour les QA structurées, current_state pour l'état vivant du système, roadmap pour les tâches, session_history pour l'historique des sessions, bruce_tools pour le magasin d'outils, events_log pour les événements, staging_queue pour la file de validation. Chaque table a ses colonnes propres.",
        source="Architecture BRUCE - schéma Supabase",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Tables canoniques Supabase BRUCE: lessons_learned, knowledge_base, current_state, roadmap, session_history, bruce_tools, events_log, staging_queue. Chaque table a un schéma propre.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quelles sont les tables canoniques de Supabase BRUCE?","answer":"8 tables: lessons_learned (leçons), knowledge_base (QA structurées), current_state (état vivant), roadmap (tâches), session_history (historique sessions), bruce_tools (outils), events_log (événements), staging_queue (file validation).","category":"schema","tags":["supabase","tables","canon"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="8 tables canoniques Supabase BRUCE avec schémas propres."
    ).with_inputs("text", "source"),

    # [TRAIN-35] Principe zéro échec silencieux — basé sur lesson réelle
    dspy.Example(
        text="Yann exige zéro échec silencieux pour toute l'infrastructure BRUCE. Tout doit être visible. Si quelque chose échoue, ça doit être immédiatement évident. Le pipeline doit être traçable de bout en bout. Pas de confiance aveugle dans les automatisations. Chaque processus automatique doit produire une trace vérifiable.",
        source="ChatGPT BRUCE homelab - principes",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"Principe fiabilité BRUCE: zéro échec silencieux. Chaque erreur immédiatement visible. Pipeline traçable bout en bout. Pas de confiance aveugle dans les automatisations.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Zéro échec silencieux pour toute l infrastructure BRUCE","rationale":"Tout problème doit être immédiatement visible, pas découvert par hasard","importance":"critical"}]',
        wishes_json='[{"wish_text":"Yann veut que tout échec dans BRUCE soit immédiatement visible, pipeline traçable de bout en bout","importance":"critical"}]',
        user_profile_json='[{"trait":"valeur_visibilite","value":"Yann exige la visibilité complète, aucune confiance aveugle dans les automatisations","category":"value"}]',
        conversation_qa_json='[]',
        summary="Principe BRUCE: zéro échec silencieux, tout traçable et visible."
    ).with_inputs("text", "source"),


    # ============================================================
    # ============================================================
    # TEST SET — 10 exemples (indices 35 à 44)
    # ============================================================
    # ============================================================

    # [TEST-01] psql sur .206 — basé sur lesson #795
    dspy.Example(
        text="psql local ne fonctionne pas sur furycom@192.168.2.206 car il n'y a pas de socket PostgreSQL dans /var/run/postgresql. Supabase utilise Docker avec un port mappé sur 5432, pas un socket Unix. Pour se connecter: psql -h localhost -U postgres -p 5432. Le mot de passe est dans le fichier .env du docker-compose Supabase.",
        source="Session BRUCE 14 - debugging psql",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"psql sur .206 échoue: pas de socket /var/run/postgresql. Supabase utilise Docker + port 5432. Connexion: psql -h localhost -U postgres -p 5432. Mot de passe dans .env docker-compose.","importance":"normal","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Comment se connecter à PostgreSQL Supabase en local?","answer":"psql -h localhost -U postgres -p 5432. Pas de socket Unix, Supabase tourne dans Docker avec port mappé. Mot de passe dans le fichier .env du docker-compose Supabase.","category":"ssh","tags":["psql","supabase","docker","connexion"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="psql local sur .206 échoue: pas de socket. Utiliser psql -h localhost -p 5432."
    ).with_inputs("text", "source"),

    # [TEST-02] Règle Claude ne doit pas inventer — basé sur lesson #2372
    dspy.Example(
        text="Yann est formel: Claude ne doit JAMAIS inventer une architecture ou un outil que personne n'a demandé. Claude ne doit JAMAIS faire du travail spéculatif qui créerait de la dette technique. Si Claude n'est pas sûr de ce qui est demandé, il doit demander confirmation plutôt que de deviner et construire quelque chose d'inutile.",
        source="Session Opus 117 - règle Yann",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: Claude ne doit JAMAIS inventer une architecture ou un outil non demandé. Pas de travail spéculatif créant de la dette technique. En cas de doute, demander confirmation.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Claude ne fait pas de travail spéculatif non demandé","rationale":"Le travail spéculatif crée de la dette technique. Si pas sûr, demander plutôt que deviner.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Règle Yann: Claude ne doit jamais inventer d architecture non demandée. Demander plutôt que deviner."
    ).with_inputs("text", "source"),

    # [TEST-03] Transcriptions ambiantes — basé sur lesson #2478
    dspy.Example(
        text="Yann envisage un système de transcriptions ambiantes dans la maison. Enregistrement continu en local, traitement par le LLM local, extraction d'informations utiles. La confidentialité est non négociable: tout reste en local, jamais de cloud. Le traitement se ferait par Whisper en local puis extraction par Qwen. Les transcriptions brutes ne seraient jamais conservées, seulement les informations extraites.",
        source="Convo conscience 2026-02-27",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Vision transcriptions ambiantes maison: enregistrement continu LOCAL, traitement Whisper + Qwen local. Confidentialité non négociable: tout en local, jamais de cloud. Transcriptions brutes non conservées, seulement extractions.","importance":"critical","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Comment fonctionne le système de transcriptions ambiantes prévu?","answer":"Enregistrement continu en local, transcription par Whisper local, extraction par Qwen local. Confidentialité totale: rien sur le cloud. Transcriptions brutes effacées, seules les informations extraites sont conservées.","category":"architecture","tags":["transcription","whisper","local","vie_privee"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann envisage des transcriptions ambiantes maison 100% locales avec Whisper + Qwen, confidentialité non négociable","importance":"critical"}]',
        user_profile_json='[{"trait":"valeur_vie_privee","value":"La confidentialité est non négociable pour Yann. Tout traitement audio reste 100% local, jamais de cloud.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Transcriptions ambiantes maison: Whisper + Qwen local. Confidentialité totale, brutes effacées."
    ).with_inputs("text", "source"),

    # [TEST-04] Bruit — discussion météo sans info
    dspy.Example(
        text="Fait froid aujourd'hui. Moins 20 dehors. Va falloir que je vérifie que le serveur dans le garage est pas trop froid. Enfin bon. On fait quoi là?",
        source="Session BRUCE bavardage",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Bavardage météo sans contenu technique exploitable."
    ).with_inputs("text", "source"),

    # [TEST-05] Heredoc PowerShell — basé sur lesson #796
    dspy.Example(
        text="Les heredoc PowerShell combinés avec des backticks JavaScript causent des problèmes: cat > /tmp/file.py << 'EOF' via SSH depuis PowerShell échoue quand le contenu contient des backticks qui sont interprétés par PowerShell comme des caractères d'échappement. Solution: écrire le contenu dans un fichier local puis SCP vers la cible, jamais de heredoc avec backticks via SSH.",
        source="Session BRUCE 14",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"Heredoc via SSH depuis PowerShell échoue avec backticks JS: PowerShell les interprète comme échappement. Solution: écrire en fichier local puis SCP, jamais heredoc+backticks via SSH.","importance":"normal","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Pourquoi les heredoc SSH échouent depuis PowerShell avec du JavaScript?","answer":"Les backticks dans le contenu JS sont interprétés par PowerShell comme caractères d échappement. Solution: écrire dans un fichier local puis transférer via SCP en 2 étapes. Ne jamais utiliser heredoc avec du contenu contenant des backticks.","category":"ssh","tags":["powershell","heredoc","backticks","ssh"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Heredoc SSH + backticks JS échoue dans PowerShell. Solution: fichier local + SCP."
    ).with_inputs("text", "source"),

    # [TEST-06] Bruit déguisé en technique — vague
    dspy.Example(
        text="Il faudrait qu'on améliore la performance du système. Les temps de réponse sont pas terribles. On pourrait optimiser. Faudrait regarder ça à un moment donné. C'est important de tester correctement.",
        source="Session BRUCE réflexion",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Réflexions vagues sur la performance sans données concrètes ni actions définies."
    ).with_inputs("text", "source"),

    # [TEST-07] Memory Gate architecture — basé sur lesson #2483
    dspy.Example(
        text="Yann veut remplacer les fichiers Markdown de mémoire persistante par un vrai endpoint HTTP. Le Memory Gate serait un endpoint REST sur le MCP server que ChatGPT conscience appelle pour lire et écrire la mémoire BRUCE. GET pour lire le handoff, POST pour écrire des découvertes. Mappe directement sur current_state et knowledge_base dans Supabase. Avantage: plus de fichiers à gérer manuellement.",
        source="Convo conscience 2026-02-27",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Memory Gate = endpoint REST sur MCP server pour ChatGPT conscience. GET pour lire handoff, POST pour écrire découvertes. Mappe sur current_state et knowledge_base. Remplace fichiers Markdown manuels.","importance":"critical","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Comment fonctionne le Memory Gate pour ChatGPT conscience?","answer":"Endpoint REST sur MCP server. GET /memory pour lire le handoff et contexte BRUCE. POST /memory pour écrire des découvertes. Mappe directement sur current_state et knowledge_base Supabase. Remplace les fichiers Markdown de mémoire persistante.","category":"architecture","tags":["memory_gate","chatgpt","conscience","api"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann veut remplacer les fichiers Markdown de mémoire par un endpoint HTTP Memory Gate","importance":"critical"}]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Memory Gate: endpoint REST remplaçant fichiers Markdown pour mémoire ChatGPT conscience."
    ).with_inputs("text", "source"),

    # [TEST-08] Prompt vLLM amélioré — basé sur lesson #1655
    dspy.Example(
        text="Amélioration du prompt d'extraction vLLM dans bruce_ingest.py: le nouveau prompt v2 est beaucoup plus explicite sur le format attendu. Il demande du JSON strict avec des champs lesson_type, lesson_text, importance, confidence_score pour les lessons. Il inclut des exemples inline de bonne et mauvaise extraction. Le seuil de confiance minimum est passé à 0.7 pour réduire le bruit.",
        source="Session Sonnet 100",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Prompt vLLM ingestion v2: JSON strict avec champs explicites, exemples inline bonne/mauvaise extraction, seuil confiance 0.7 minimum pour réduire bruit.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quelles améliorations dans le prompt vLLM d extraction v2?","answer":"Format JSON strict demandé. Champs explicites: lesson_type, lesson_text, importance, confidence_score. Exemples inline de bonne et mauvaise extraction. Seuil confiance minimum 0.7 pour réduire bruit.","category":"pipeline","tags":["vllm","prompt","ingestion","extraction"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Prompt extraction vLLM v2: JSON strict, exemples inline, seuil confiance 0.7."
    ).with_inputs("text", "source"),

    # [TEST-09] Conversation mixte: wish + technique — cas complexe
    dspy.Example(
        text="Yann: J'aimerais que quand je parle à BRUCE depuis mon téléphone, il comprenne le contexte de ce que je fais. Genre si je suis dans le garage et je dis hey BRUCE le serveur fait un bruit bizarre, il devrait savoir quel serveur est dans le garage et me guider. ChatGPT: Pour ça il faudrait un inventaire physique lié aux emplacements. Un champ location dans bruce_tools avec les valeurs bureau, garage, rack1, rack2.",
        source="ChatGPT BRUCE domotique",
        lessons_json='[]',
        knowledge_base_json='[{"question":"Comment BRUCE pourrait comprendre le contexte physique de l utilisateur?","answer":"Ajouter un champ location dans bruce_tools avec les emplacements physiques (bureau, garage, rack1, rack2). Quand Yann mentionne un lieu, BRUCE filtre les équipements par location pour comprendre le contexte.","category":"architecture","tags":["location","contexte","domotique"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann souhaite que BRUCE comprenne le contexte physique quand il parle depuis un lieu (garage, bureau) et identifie automatiquement les équipements concernés","importance":"normal"}]',
        user_profile_json='[{"trait":"usage_mobile","value":"Yann veut interagir avec BRUCE depuis son téléphone en contexte physique (garage, bureau)","category":"usage"}]',
        conversation_qa_json='[{"question":"Comment BRUCE peut comprendre de quel serveur on parle selon le lieu?","answer":"Inventaire physique avec champ location dans bruce_tools. Quand Yann dit garage, filtrer par location=garage pour identifier les équipements concernés.","category":"conversation-qa","tags":["location","contexte"]}]',
        summary="Yann veut BRUCE contextuel par lieu physique. Solution: champ location dans bruce_tools."
    ).with_inputs("text", "source"),

    # [TEST-10] N8N API access — basé sur lesson #1450
    dspy.Example(
        text="Pour accéder à l'API n8n depuis PowerShell, il faut utiliser le header X-N8N-API-KEY et non pas un bearer token classique. L'API key se trouve dans les settings n8n. Exemple: Invoke-RestMethod avec header X-N8N-API-KEY. Le endpoint de base est http://192.168.2.230:5678/api/v1. On peut lister les workflows, les exécutions, les credentials.",
        source="Session Sonnet 81",
        lessons_json='[{"lesson_type":"solution","lesson_text":"API n8n via PowerShell: header X-N8N-API-KEY (pas bearer token). API key dans settings n8n. Endpoint: http://192.168.2.230:5678/api/v1. Lister workflows, exécutions, credentials.","importance":"normal","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Comment accéder à l API n8n depuis PowerShell?","answer":"Utiliser header X-N8N-API-KEY (pas bearer token). API key dans settings n8n. Endpoint base: http://192.168.2.230:5678/api/v1. Endpoints: /workflows, /executions, /credentials.","category":"tools","tags":["n8n","api","powershell"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="API n8n: header X-N8N-API-KEY, endpoint :5678/api/v1. Pas de bearer token."
    ).with_inputs("text", "source"),

]
