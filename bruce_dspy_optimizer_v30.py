#!/usr/bin/env python3
"""
BRUCE DSPy Optimizer v2.9
=========================
Améliorations vs v28:
  - 75 gold examples (45 TRAIN / 15 DEV / 15 TEST) — split propre sans contamination
  - Baseline sur DEV (15 exemples), MIPROv2 sur TRAIN (45 exemples)
  - TEST set jamais vu pendant l'optimisation
  - Predict (pas ChainOfThought) — prouvé v28
  - Direct .32:8000 (bypass LiteLLM Docker) — prouvé v28
  - timeout=600 dans dspy.LM() — prouvé v28
  - max_tokens=2000 — prouvé v28
  - Métrique v2.8 corrigée (sur-extraction OK)
  - Lockfile anti-doublon
  - Progress JSON + state file pour reprise
"""

import dspy
import json
import os
import sys
import time
import fcntl
import signal
import logging

# ─── Config ───────────────────────────────────────────────────────────────────
LLM_BASE_URL  = "http://192.168.2.32:8000/v1"
LLM_API_KEY   = "token-abc123"
MODEL_NAME    = "openai/local-qwen3"
MAX_TOKENS    = 2000
TIMEOUT_SEC   = 600
CTX_SIZE      = 16384

RESULTS_DIR   = "/home/furycom/dspy_results_v29"
LOG_FILE      = f"{RESULTS_DIR}/bench_v29.log"
PROGRESS_FILE = "/tmp/dspy_v29_progress.json"
LOCK_FILE     = "/tmp/dspy_v29.lock"
BEST_MODEL    = f"{RESULTS_DIR}/best_model.json"

# ─── Logging ──────────────────────────────────────────────────────────────────
os.makedirs(RESULTS_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stdout)
    ]
)
log = logging.getLogger("dspy_v29")

# ─── Lockfile anti-doublon ─────────────────────────────────────────────────────
def acquire_lock():
    lf = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lf.write(str(os.getpid()))
        lf.flush()
        return lf
    except IOError:
        log.error(f"Un autre process DSPy tourne déjà (lockfile {LOCK_FILE}). Abort.")
        sys.exit(1)

# ─── Progress JSON ─────────────────────────────────────────────────────────────
def save_progress(phase, step, total, score=None, extra=None):
    data = {
        "phase": phase, "step": step, "total": total,
        "score": score, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "pid": os.getpid()
    }
    if extra:
        data.update(extra)
    with open(PROGRESS_FILE, "w") as f:
        json.dump(data, f, indent=2)


# ─── Signature ────────────────────────────────────────────────────────────────
class BruceExtractionV27(dspy.Signature):
    """
    /no_think
    Tu es un extracteur de mémoire BRUCE. Extrais TOUTES les informations utiles du texte.
    Sois généreux dans l'extraction — mieux vaut trop que trop peu, le dédup gère l'excès.
    Retourne du JSON valide uniquement. Si rien à extraire pour un champ, retourne [].
    """
    text:   str = dspy.InputField(desc="Extrait de conversation ou document homelab de Yann")
    source: str = dspy.InputField(desc="Source du document")

    lessons_json: str = dspy.OutputField(
        desc='JSON array: [{"lesson_type":"solution|warning|discovery|best_practice|pattern|debug_trace|architecture_decision|rule_canon|diagnostic","lesson_text":"...","importance":"critical|high|normal|low","confidence_score":0.0-1.0}]')
    knowledge_base_json: str = dspy.OutputField(
        desc='JSON array: [{"question":"...","answer":"...","category":"architecture|runbook|governance|infrastructure|tools|schema|pipeline|user_profile|ssh|configuration|docker|debugging|workflow|database|mcp","tags":["..."]}]')
    decisions_json: str = dspy.OutputField(
        desc='JSON array: [{"decision_text":"...","rationale":"...","importance":"critical|high|normal"}]')
    wishes_json: str = dspy.OutputField(
        desc='JSON array: [{"wish_text":"...","importance":"critical|high|normal"}]')
    user_profile_json: str = dspy.OutputField(
        desc='JSON array: [{"trait":"...","value":"...","category":"value|behavior|preference|usage|constraint"}]')
    conversation_qa_json: str = dspy.OutputField(
        desc='JSON array: [{"question":"...","answer":"...","category":"conversation-qa","tags":["..."]}]')
    summary: str = dspy.OutputField(desc="Résumé 1-2 phrases en français")


# ─── Module ────────────────────────────────────────────────────────────────────
class BruceExtractorV29(dspy.Module):
    def __init__(self):
        self.extractor = dspy.Predict(BruceExtractionV27)

    def forward(self, text, source):
        return self.extractor(text=text, source=source)


# ─── Metric v2.8 corrigée ─────────────────────────────────────────────────────
def safe_json(s):
    try:
        return json.loads(s) if isinstance(s, str) else (s or [])
    except:
        return []

def extraction_quality_metric(example, prediction, trace=None):
    """Metric v2.8 — sur-extraction OK, sous-extraction punie."""
    score = 0.0
    checks = 0

    fields = [
        ("lessons_json",         "lessons_json"),
        ("knowledge_base_json",  "knowledge_base_json"),
        ("decisions_json",       "decisions_json"),
        ("wishes_json",          "wishes_json"),
        ("conversation_qa_json", "conversation_qa_json"),
    ]

    for ex_field, pred_field in fields:
        gold = safe_json(getattr(example, ex_field, "[]"))
        pred = safe_json(getattr(prediction, pred_field, "[]"))
        checks += 1
        g, p = len(gold), len(pred)
        if g == 0 and p == 0:
            score += 1.0
        elif g == 0 and p > 0:
            score += 0.0  # hallucination
        elif p == 0 and g > 0:
            score += 0.0  # raté
        else:
            # Count: sur-extraction OK (p >= g = score 1.0)
            count_score = 1.0 if p >= g else p / g
            # Quality: longueur moyenne des textes
            quality_score = 0.0
            text_keys = ["lesson_text","answer","decision_text","wish_text","question","value"]
            lengths = []
            for item in (pred if isinstance(pred, list) else []):
                if isinstance(item, dict):
                    for tk in text_keys:
                        if tk in item and isinstance(item[tk], str):
                            lengths.append(len(item[tk]))
            if lengths:
                quality_score = min(sum(lengths)/len(lengths)/80.0, 1.0)
            # Structure: clés obligatoires
            required_map = {
                "lessons_json":         {"lesson_type","lesson_text","importance","confidence_score"},
                "knowledge_base_json":  {"question","answer","category","tags"},
                "decisions_json":       {"decision_text","rationale","importance"},
                "wishes_json":          {"wish_text","importance"},
                "conversation_qa_json": {"question","answer","category"},
            }
            struct_score = 0.0
            required = required_map.get(ex_field, set())
            if pred and isinstance(pred, list) and isinstance(pred[0], dict) and required:
                present = set(pred[0].keys()) & required
                struct_score = len(present) / len(required)
            score += count_score * 0.4 + quality_score * 0.3 + struct_score * 0.3

    # Bonus: JSON parseable
    checks += 1
    try:
        for f in ["lessons_json","knowledge_base_json","decisions_json","wishes_json","conversation_qa_json"]:
            json.loads(getattr(prediction, f, "[]"))
        score += 1.0
    except:
        pass

    # Bonus: summary quality
    checks += 1
    s = getattr(prediction, "summary", "")
    if s and 20 < len(s) < 500:
        score += 1.0
    elif s:
        score += 0.5

    # Bonus: user_profile
    checks += 1
    up_gold = safe_json(getattr(example, "user_profile_json", "[]"))
    up_pred = safe_json(getattr(prediction, "user_profile_json", "[]"))
    if len(up_gold) == 0 and len(up_pred) == 0:
        score += 1.0
    elif len(up_gold) > 0 and len(up_pred) > 0:
        score += min(len(up_gold), len(up_pred)) / max(len(up_gold), len(up_pred))
    else:
        score += 0.0

    return score / checks if checks > 0 else 0.0


# ─── Évaluation séquentielle (anti-threading) ─────────────────────────────────
def manual_evaluate(module, devset, metric, label="eval"):
    """Évaluation séquentielle qui bypasse les problèmes de threading dspy.Evaluate."""
    scores = []
    for i, example in enumerate(devset):
        t0 = time.time()
        try:
            pred = module(text=example.text, source=getattr(example, "source", ""))
            sc   = metric(example, pred)
            elapsed = time.time() - t0
            scores.append(sc)
            log.info(f"  [{label}] {i+1}/{len(devset)} score={sc:.3f} t={elapsed:.0f}s")
            save_progress(label, i+1, len(devset), score=round(sum(scores)/len(scores),3))
        except Exception as e:
            log.warning(f"  [{label}] {i+1}/{len(devset)} ERREUR: {e}")
            scores.append(0.0)
            save_progress(label, i+1, len(devset), score=0.0, extra={"error": str(e)})
        time.sleep(1)  # laisser le slot respirer
    avg = sum(scores)/len(scores) if scores else 0.0
    log.info(f"  [{label}] Score moyen: {avg:.3f} sur {len(scores)} exemples")
    return avg, scores


GOLD_EXAMPLES = [

    # ============================================================
    # TRAIN SET — indices 0-44 (45 exemples)
    # ============================================================

    # [TRAIN-00] SSH Start-Job — règle fondamentale
    dspy.Example(
        text="SSH via invoke_expression bloque le terminal PowerShell indéfiniment quand la commande distante prend du temps ou ne retourne pas. La solution est d'utiliser Start-Job + Wait-Job -Timeout 25 pour tout appel SSH. En cas de blocage: Stop-Job, puis Receive-Job pour récupérer ce qui a été capturé. Pour les scripts complexes, SCP en 2 étapes: d'abord copier le fichier localement, puis SCP vers la cible.",
        source="Session BRUCE 3 - debugging SSH PowerShell",
        lessons_json='[{"lesson_type":"solution","lesson_text":"SSH via invoke_expression bloque le terminal PowerShell indéfiniment. Solution: Start-Job + Wait-Job -Timeout 25 pour tout appel SSH. Stop-Job en fallback. Pour scripts complexes, SCP en 2 étapes.","importance":"critical","confidence_score":0.98}]',
        knowledge_base_json='[{"question":"Comment faire des appels SSH sans bloquer PowerShell?","answer":"Utiliser Start-Job + Wait-Job -Timeout 25. JAMAIS invoke_expression directe pour SSH. Pattern: $job = Start-Job { ssh -i $key user@host commande }; Wait-Job $job -Timeout 25 | Out-Null; Receive-Job $job","category":"ssh","tags":["ssh","powershell","start-job","timeout"]}]',
        decisions_json='[{"decision_text":"SSH toujours via Start-Job, jamais invoke_expression directe","rationale":"invoke_expression bloque le terminal indéfiniment si la commande SSH prend du temps","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="SSH PowerShell: toujours Start-Job + Wait-Job -Timeout 25. invoke_expression directe bloque indéfiniment."
    ).with_inputs("text", "source"),

    # [TRAIN-01] SUPABASE_URL double path — bug container
    dspy.Example(
        text="Bug découvert dans le container mcp-gateway: la variable d'environnement SUPABASE_URL contenait déjà /rest/v1 dans sa valeur, et le code dans le gateway ajoutait /rest/v1 une deuxième fois sur chaque requête. Résultat: toutes les requêtes retournaient 404 Not Found. Fix: retirer le suffixe /rest/v1 de la variable d'environnement SUPABASE_URL, le code le rajoute lui-même.",
        source="Session BRUCE debugging gateway",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Bug SUPABASE_URL double /rest/v1 dans container mcp-gateway: la variable d env contenait déjà /rest/v1, le code ajoutait /rest/v1 une 2e fois -> 404. Fix: retirer le suffixe de la variable d env, le code l ajoute automatiquement.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Pourquoi les requêtes Supabase retournent 404 depuis le gateway?","answer":"Double /rest/v1: la variable SUPABASE_URL contient déjà /rest/v1, et le code l ajoute une deuxième fois. Fix: SUPABASE_URL = http://192.168.2.146:8000 (sans suffixe). Le gateway ajoute /rest/v1/ lui-même dans le code.","category":"debugging","tags":["supabase","gateway","env","url"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Double /rest/v1 dans SUPABASE_URL cause 404. Fix: enlever le suffixe de la variable d'env."
    ).with_inputs("text", "source"),

    # [TRAIN-02] docker compose restart ne relit pas .env
    dspy.Example(
        text="Attention: docker compose restart ne relit PAS le fichier .env. Si tu modifies des variables d'environnement dans .env et que tu fais juste un restart, les conteneurs continuent avec les anciennes valeurs. Il faut faire docker compose down puis docker compose up -d pour que les nouvelles variables soient prises en compte. Cette erreur fait perdre du temps à chaque fois qu'on modifie la config.",
        source="Session BRUCE infrastructure",
        lessons_json='[{"lesson_type":"warning","lesson_text":"docker compose restart NE relit PAS le fichier .env. Si les variables d environnement changent, il faut docker compose down + up -d. Un simple restart ne suffit pas pour prendre en compte les nouvelles valeurs.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment appliquer les changements de variables .env dans docker compose?","answer":"docker compose restart ne relit PAS .env. Toujours faire docker compose down && docker compose up -d pour appliquer les changements de variables d environnement. Le restart conserve les anciennes valeurs en mémoire.","category":"docker","tags":["docker-compose","env","restart","configuration"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="docker compose restart ne relit pas .env. Toujours down + up -d pour les changements de variables."
    ).with_inputs("text", "source"),

    # [TRAIN-03] Disque critique .230
    dspy.Example(
        text="Diagnostic disque VM103 mcp-gateway sur 192.168.2.230: disque presque plein. 37GB total, 32GB utilisé soit 92% de capacité. Répartition: images Docker 18GB, logs applicatifs 4.2GB, répertoire /home/furycom 6GB incluant les venv Python. Actions requises: nettoyer les images Docker inutilisées avec docker image prune, mettre en place la rotation des logs, surveiller /home/furycom/venv-ingestion qui grossit.",
        source="Session BRUCE audit infrastructure",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"VM103 mcp-gateway (.230) disque critique: 37GB total, 32GB utilisé (92%). Docker images 18GB, logs 4.2GB, /home/furycom 6GB. Actions: docker image prune, rotation logs, surveiller venv-ingestion.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment gérer l espace disque critique sur le mcp-gateway .230?","answer":"Diagnostic: df -h pour voir occupation. Nettoyer images Docker inutilisées: docker image prune -a. Rotation logs: configurer logrotate ou limiter logs dans docker-compose (max-size). Surveiller /home/furycom/venv-ingestion (peut grossir à 4GB+).","category":"infrastructure","tags":["disque","docker","logs","mcp-gateway"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Disque .230 critique à 92%. Images Docker 18GB, logs 4.2GB. Nettoyer et rotation logs urgente."
    ).with_inputs("text", "source"),

    # [TRAIN-04] LiteLLM healthcheck curl absent
    dspy.Example(
        text="LiteLLM était en état unhealthy dans Docker. Le healthcheck utilisait CMD curl -f http://localhost:4100/health mais curl n'est pas installé dans l'image LiteLLM. Fix: remplacer par wget -q http://localhost:4100/health/liveliness ou python3 -c \"import urllib.request; urllib.request.urlopen('http://localhost:4100/health/liveliness')\". Aussi augmenter l'interval à 30s et le start_period à 60s pour éviter les faux positifs au démarrage.",
        source="Session BRUCE debugging LiteLLM",
        lessons_json='[{"lesson_type":"solution","lesson_text":"LiteLLM unhealthy: healthcheck utilisait curl absent de l image. Fix: utiliser wget ou python urllib. Augmenter interval à 30s et start_period à 60s pour éviter faux positifs au démarrage.","importance":"normal","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Comment corriger le healthcheck Docker de LiteLLM?","answer":"curl absent de l image LiteLLM. Remplacer par: wget -q -O /dev/null http://localhost:4100/health/liveliness || exit 1. Ou: python3 -c \"import urllib.request; urllib.request.urlopen(...)\" . Paramètres: interval 30s, start_period 60s, retries 3.","category":"docker","tags":["litellm","healthcheck","docker","curl"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="LiteLLM healthcheck: curl absent de l'image. Remplacer par wget ou python urllib. Interval 30s."
    ).with_inputs("text", "source"),

    # [TRAIN-05] Séquences PostgreSQL désalignées post-migration
    dspy.Example(
        text="Après une migration manuelle de données avec des IDs explicites, les séquences PostgreSQL ne sont pas mises à jour automatiquement. Le prochain INSERT sans ID explicite cause une erreur de collision de clé primaire car la séquence essaie d'utiliser un ID qui existe déjà. Fix: après chaque migration manuelle, exécuter SELECT setval('nom_sequence', (SELECT MAX(id) FROM table) + 1) pour chaque table migrée.",
        source="Session BRUCE migration Supabase",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Après migration manuelle avec IDs explicites, les séquences PostgreSQL ne sont pas alignées. Le prochain INSERT auto-increment cause une collision de clé primaire. Fix: SELECT setval sur chaque séquence au MAX(id)+1 après migration.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment corriger les séquences PostgreSQL après migration manuelle?","answer":"Exécuter pour chaque table: SELECT setval(pg_get_serial_sequence(\'table\', \'id\'), (SELECT MAX(id) FROM table) + 1). Ou: SELECT setval(\'nom_sequence\', MAX(id)+1) FROM table. À faire après toute migration avec IDs explicites.","category":"database","tags":["postgresql","sequences","migration","setval"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Séquences PostgreSQL désalignées après migration manuelle avec IDs. Fix: setval au MAX(id)+1."
    ).with_inputs("text", "source"),

    # [TRAIN-06] && invalide dans PowerShell
    dspy.Example(
        text="L'opérateur && ne fonctionne pas dans PowerShell pour chaîner des commandes. Dans PowerShell, il faut utiliser le point-virgule (;) pour enchaîner des commandes. Note importante: && fonctionne correctement dans bash sur un serveur distant via SSH, mais si la commande SSH est envoyée depuis PowerShell avec &&, PowerShell l'interprète localement et échoue. Attention au mélange des contextes.",
        source="Session BRUCE debugging PowerShell",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"Opérateur && invalide dans PowerShell. Utiliser point-virgule (;) pour chaîner les commandes. Attention au mélange: && fonctionne dans bash distant via SSH mais pas dans PowerShell local.","importance":"normal","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Comment chaîner des commandes dans PowerShell?","answer":"Utiliser le point-virgule (;) au lieu de &&. PowerShell n interpréte pas && comme bash. Exception: si la commande est envoyée en argument à ssh, le && s exécute sur le serveur distant en bash. Contextes différents: local=PowerShell, distant=bash.","category":"ssh","tags":["powershell","bash","chaining","&&"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="&& invalide dans PowerShell. Utiliser ; pour chaîner. && fonctionne seulement en bash distant."
    ).with_inputs("text", "source"),

    # [TRAIN-07] node_exporter UFW bloqué
    dspy.Example(
        text="Le node_exporter sur .32 était inaccessible depuis Prometheus sur .154. Sonnet avait diagnostiqué à tort le firewall Proxmox au niveau hyperviseur. La vraie cause était UFW sur la VM elle-même qui bloquait le port 9100. Fix: sudo ufw allow from 192.168.2.0/24 to any port 9100. Leçon: toujours vérifier UFW sur la VM en premier avant de suspecter le firewall hyperviseur.",
        source="Session BRUCE debugging monitoring",
        lessons_json='[{"lesson_type":"solution","lesson_text":"node_exporter .32 inaccessible depuis Prometheus .154: cause = ufw sur la VM bloquait port 9100, PAS firewall Proxmox hyperviseur. Fix: sudo ufw allow from 192.168.2.0/24 to any port 9100.","importance":"normal","confidence_score":1.0},{"lesson_type":"diagnostic","lesson_text":"Correction diagnostic: toujours vérifier ufw sur la VM elle-même AVANT de suspecter le firewall Proxmox/hyperviseur. Erreur fréquente de Sonnet.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment débloquer node_exporter quand Prometheus ne le voit pas?","answer":"Vérifier UFW sur la VM en premier: sudo ufw status. Si port 9100 absent: sudo ufw allow from 192.168.2.0/24 to any port 9100. Ne pas suspecter le firewall hyperviseur/Proxmox avant d avoir vérifié UFW local.","category":"infrastructure","tags":["node_exporter","ufw","prometheus","firewall"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="node_exporter bloqué par UFW sur la VM, pas par Proxmox. Fix: ufw allow port 9100 depuis 192.168.2.0/24."
    ).with_inputs("text", "source"),

    # [TRAIN-08] Règle canon: documenter avant d'avancer
    dspy.Example(
        text="Yann: C'est une règle absolue chez moi. On documente dans Supabase avant de passer à la prochaine tâche. Toujours. Pas à la fin de la session, pas quand t'as le temps. Maintenant. Si la session crashe dans 5 minutes et qu'on a rien documenté, c'est perdu pour toujours. Je préfère faire 3 tâches bien documentées plutôt que 10 tâches dont je me rappelle plus.",
        source="Session Opus 45 - règles Yann",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: Toujours consolider et documenter dans Supabase avant d avancer à la prochaine tâche. Ne jamais enchaîner sans avoir enregistré. Si la session crashe sans documentation, c est perdu à jamais. 3 tâches bien documentées > 10 non documentées.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Documentation dans Supabase obligatoire entre chaque tâche significative","rationale":"Si la session crashe, rien ne doit être perdu. Petites étapes validées plutôt que grandes sessions non documentées.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"valeur_documentation","value":"Yann exige documentation immédiate dans Supabase après chaque tâche. Pas à la fin, maintenant. Préfère moins de tâches bien documentées à beaucoup non documentées.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Règle canon Yann: documenter dans Supabase AVANT d'avancer. 3 tâches documentées > 10 non documentées."
    ).with_inputs("text", "source"),

    # [TRAIN-09] Ne pas modifier ce qui fonctionne
    dspy.Example(
        text="Yann: Ma règle numéro un c'est de ne jamais toucher ce qui marche. Si c'est stable, on n'y touche pas sauf raison explicite et approuvée par moi. Chaque amélioration non nécessaire c'est un risque de tout casser. J'ai perdu trop de temps à réparer des trucs qu'on avait cassés en voulant améliorer.",
        source="Session Opus 67 - principes Yann",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: Ne jamais modifier ce qui fonctionne sans raison explicite et approuvée. La stabilité prime sur l amélioration. Chaque amélioration non nécessaire risque de casser autre chose.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Ne pas modifier ce qui fonctionne sans raison explicite et approbation Yann","rationale":"Chaque changement non nécessaire risque de casser autre chose. Stabilité prioritaire. Trop de temps perdu à réparer des améliorations inutiles.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"valeur_stabilite","value":"Yann préfère la stabilité à l amélioration. Ne jamais toucher ce qui marche sans raison explicite approuvée.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Règle canon Yann: ne jamais modifier ce qui fonctionne sans raison explicite. Stabilité > amélioration."
    ).with_inputs("text", "source"),

    # [TRAIN-10] Hiérarchie confiance LLM BRUCE
    dspy.Example(
        text="La hiérarchie de confiance dans BRUCE du plus bas au plus haut: Scripts automatiques < vLLM local (7B) < ChatGPT conscience < Sonnet < Opus < Humain (Yann). En cas de conflit, la date récente gagne sauf si la source est trop basse dans la hiérarchie. Routeur de difficulté: évident -> script, subtil -> LLM, risque élevé -> Opus ou humain. Le rejeté est archivé, jamais effacé.",
        source="Session Opus 89 - gouvernance BRUCE",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"HIÉRARCHIE LLM BRUCE: Scripts < vLLM local < ChatGPT < Sonnet < Opus < Humain (Yann). Date récente gagne sauf source trop basse. Routeur difficulté: évident->script, subtil->LLM, risque->Opus/humain. Rejeté=archivé jamais effacé.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quelle est la hiérarchie de confiance des sources dans BRUCE?","answer":"Du plus bas au plus haut: Scripts < vLLM 7B local < ChatGPT conscience < Claude Sonnet < Claude Opus < Humain Yann. Conflit: date récente gagne sauf source trop basse. Rejeté=archivé pas effacé.","category":"governance","tags":["hierarchie","confiance","llm","governance"]}]',
        decisions_json='[{"decision_text":"Hiérarchie de confiance LLM avec résolution par date et niveau de source","rationale":"Un script ne doit pas renverser une décision Opus ou humaine. Le rejeté est archivé, pas effacé.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Hiérarchie BRUCE: Scripts < vLLM < ChatGPT < Sonnet < Opus < Yann. Date récente gagne entre niveaux."
    ).with_inputs("text", "source"),

    # [TRAIN-11] Règle zéro tolérance qualité données
    dspy.Example(
        text="Yann: La base doit être parfaite. Ce qui rentre dans Supabase doit être parfait. Je tolère zéro erreur. On ne déclare pas victoire après un seul audit. Si t'as trouvé 10 problèmes et corrigé, tu fais un deuxième passage. Et un troisième si nécessaire. La base c'est la fondation de tout ce que BRUCE construit dessus. Un mauvais fondation = tout s'effondre.",
        source="Session Opus 103 - qualité données",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: La base doit être parfaite. Ce qui y entre doit être parfait. Zéro tolérance pour le contenu sous-standard. Ne pas déclarer victoire après un seul audit. La base est la fondation de tout.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Zéro tolérance qualité sur les données Supabase BRUCE","rationale":"La base est la fondation de tout. Contenu sous-standard pollue tout ce qui se construit dessus. Plusieurs audits nécessaires, pas un seul.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"valeur_qualite","value":"Zéro tolérance qualité. La base doit être parfaite. Plusieurs passes d audit, jamais déclarer victoire trop tôt.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Zéro tolérance qualité données Supabase. Plusieurs audits. La base est la fondation de tout BRUCE."
    ).with_inputs("text", "source"),

    # [TRAIN-12] BRUCE agit seulement si rollback certain
    dspy.Example(
        text="Yann est très clair là-dessus: BRUCE n'agit de façon autonome que si le rollback est garanti. Rollback garanti = backup réel vérifié + pipeline testé au vert. Une procédure sur papier qui n'a pas été testée ne vaut pas un rollback. Gradation des permissions: lecture seule d'abord, puis actions approuvées cas par cas, puis automatisation progressive. Le niveau d'autonomie augmente avec les succès prouvés.",
        source="Session Opus 112 - autonomie BRUCE",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: BRUCE agit SEULEMENT si rollback certain. Rollback certain = sauvegarde réelle + pipeline testé au vert. Procédure papier non testée ne vaut pas rollback. Gradation: lecture seule -> actions approuvées -> automatisation progressive.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"BRUCE n agit de façon autonome que si le rollback est garanti et testé","rationale":"Sauvegarde réelle + pipeline testé requis. Pas de confiance dans des procédures non testées. Autonomie croît avec succès prouvés.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"valeur_rollback","value":"Yann exige un rollback réel et testé avant toute action autonome BRUCE. Gradation: lecture seule -> approuvé -> automatisé.","category":"constraint"}]',
        conversation_qa_json='[]',
        summary="BRUCE agit en autonome seulement si rollback réel et testé. Gradation: lecture -> approuvé -> automatisé."
    ).with_inputs("text", "source"),

    # [TRAIN-13] Pipeline écriture staging_queue
    dspy.Example(
        text="L'architecture du pipeline d'écriture BRUCE: toute écriture passe par staging_queue (avec table_cible + contenu_json), puis conflict_detector.py vérifie les doublons, puis validate.py applique les quality gates, et finalement les données vont dans les tables canoniques. JAMAIS d'écriture directe dans les tables canoniques. Cette règle est absolue et ne souffre aucune exception.",
        source="Session Opus 78 - architecture pipeline",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Pipeline écriture BRUCE: staging_queue (table_cible + contenu_json) -> conflict_detector.py -> validate.py quality gates -> tables canon. Jamais d écriture directe dans les tables canoniques. Règle absolue sans exception.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment fonctionne le pipeline d écriture BRUCE?","answer":"Toujours passer par staging_queue: POST /rest/v1/staging_queue avec {table_cible, contenu_json, author_system, notes}. Puis conflict_detector.py, validate.py quality gates, et insertion dans table canonique. JAMAIS d INSERT direct dans les tables canon.","category":"pipeline","tags":["staging","pipeline","ecriture","validate"]}]',
        decisions_json='[{"decision_text":"Écriture Supabase uniquement via staging_queue, jamais directe","rationale":"Assure détection doublons, audit trail, et quality gates. Intégrité garantie.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Pipeline écriture: staging_queue -> conflict_detector -> validate.py -> tables canon. Jamais d'écriture directe."
    ).with_inputs("text", "source"),

    # [TRAIN-14] Architecture multi-projets BRUCE
    dspy.Example(
        text="Architecture multi-projets BRUCE en 3 couches: (1) champ project_scope sur les tables canoniques avec valeurs homelab/musique/domotique/general, (2) un registre project_keywords_registry dans current_state qui mappe les mots-clés à leurs scopes, (3) un context_router dans session/init qui filtre le contexte par scope selon le sujet de session. Les requêtes ambiguës sont routées vers general.",
        source="Session Opus 134 - architecture multi-projets",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Architecture multi-projets BRUCE en 3 couches: (1) champ project_scope sur tables canon (homelab/musique/domotique/general), (2) registre project_keywords_registry dans current_state, (3) context_router filtrant par scope dans session/init. Ambiguë -> general.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment BRUCE gère-t-il plusieurs projets simultanément?","answer":"3 couches: (1) project_scope sur tables (homelab/musique/domotique/general), (2) project_keywords_registry dans current_state pour le mapping, (3) context_router dans session/init filtre par scope. Requêtes ambiguës -> general.","category":"architecture","tags":["multi-projets","scope","routing","context"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Multi-projets BRUCE: 3 couches (project_scope, keywords_registry, context_router). Ambiguë -> general."
    ).with_inputs("text", "source"),

    # [TRAIN-15] embed_worker et validate_service systemd
    dspy.Example(
        text="Les services embed_worker et validate_service sur .230 tournent maintenant en tant que services systemd utilisateur (pas tmux). Créés via systemctl --user. linger activé pour survivre aux déconnexions. Watchdog vérifie l'état via systemctl --user is-active. Important: les scripts cron qui appellent systemctl --user doivent exporter XDG_RUNTIME_DIR=/run/user/$(id -u) sinon systemctl ne trouve pas le bus utilisateur.",
        source="Session Opus 1085 - systemd migration",
        lessons_json='[{"lesson_type":"solution","lesson_text":"embed_worker et validate_service migré tmux->systemd user sur .230. Services systemd user: bruce-embed-worker.service, bruce-validate-svc.service. Linger activé. CRITIQUE: cron qui appelle systemctl --user doit exporter XDG_RUNTIME_DIR=/run/user/$(id -u).","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment vérifier et gérer les services systemd user sur .230?","answer":"systemctl --user status bruce-embed-worker bruce-validate-svc. Restart: systemctl --user restart bruce-embed-worker. Logs: journalctl --user -u bruce-embed-worker. Pour cron: exporter XDG_RUNTIME_DIR=/run/user/$(id -u) avant d appeler systemctl --user.","category":"infrastructure","tags":["systemd","embed_worker","validate_service","cron"]}]',
        decisions_json='[{"decision_text":"Migrer embed_worker et validate_service de tmux vers systemd user","rationale":"Les services tmux meurent au reboot silencieusement. systemd avec linger garantit la persistance.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="embed_worker et validate_service: services systemd user sur .230. Cron doit exporter XDG_RUNTIME_DIR."
    ).with_inputs("text", "source"),

    # [TRAIN-16] Discoverabilité bruce_tools via RAG
    dspy.Example(
        text="Pour rendre les outils BRUCE trouvables par le RAG sémantique, une colonne trigger_text a été ajoutée à bruce_tools. C'est un tableau de phrases qui décrivent quand utiliser l'outil, en langage naturel. L'embed_worker indexe ces phrases comme des chunks RAG normaux. Les scores de recherche sémantique sont entre 0.70 et 0.79 pour les requêtes pertinentes. Ça rend les outils BRUCE trouvables par question naturelle.",
        source="Session Sonnet 99 - RAG bruce_tools",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Discoverabilité bruce_tools: colonne trigger_text (tableau de phrases) ajoutée. embed_worker indexe comme chunks RAG. Scores recherche sémantique 0.70-0.79. Rend les outils trouvables par question naturelle.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment les outils BRUCE sont-ils trouvables par recherche sémantique?","answer":"Colonne trigger_text dans bruce_tools contient des phrases en langage naturel. embed_worker les indexe comme chunks RAG. Recherche sémantique avec semantic_search_advanced retourne l outil avec score 0.70-0.79 pour requêtes pertinentes.","category":"tools","tags":["bruce_tools","rag","trigger_text","discoverabilite"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="trigger_text dans bruce_tools indexé par embed_worker = outils BRUCE trouvables par question naturelle."
    ).with_inputs("text", "source"),

    # [TRAIN-17] Backup Supabase n8n workflow 90
    dspy.Example(
        text="Le backup automatique de Supabase .146 est configuré dans le workflow n8n numéro 90 (id=8LZlfNd6dikzyJWb). Cron quotidien. Le workflow fait un pg_dump de la base furycom_supabase sur .146 et stocke le fichier avec un timestamp. Le cron système sur .146 a été désactivé pour éviter les doublons. À tester manuellement depuis l'UI n8n pour valider le round-trip complet.",
        source="Session Opus 1083 - backup Supabase",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Backup Supabase .146: workflow n8n #90 (8LZlfNd6dikzyJWb) actif. Cron quotidien pg_dump. Cron système .146 désactivé pour éviter doublons. Tester manuellement depuis UI n8n pour valider.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment fonctionne le backup automatique de Supabase BRUCE?","answer":"Workflow n8n #90 id=8LZlfNd6dikzyJWb. Cron quotidien. pg_dump de furycom_supabase sur .146. Fichier horodaté. Cron système .146 désactivé (double emploi). Valider: n8n UI -> workflow 90 -> Execute.","category":"runbook","tags":["backup","supabase","n8n","pg_dump"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Backup Supabase: workflow n8n #90 cron quotidien pg_dump. Cron système .146 désactivé."
    ).with_inputs("text", "source"),

    # [TRAIN-18] validateBruceAuth n'est pas un middleware
    dspy.Example(
        text="Attention piège dans le code gateway: validateBruceAuth n'est PAS un middleware Express au sens classique. C'est une fonction qui doit être appelée dans le handler de la route: const auth = validateBruceAuth(req); if (!auth.ok) return res.status(401).json({error: auth.error}). Si on l'utilise comme middleware (req, res, next), ça bloque la requête indéfiniment parce que next() n'est jamais appelé.",
        source="Session Opus 1085 - code gateway",
        lessons_json='[{"lesson_type":"warning","lesson_text":"validateBruceAuth: PAS un middleware Express. Doit être appelé dans le handler: const auth = validateBruceAuth(req); if (!auth.ok) return res.status(401)... Utiliser comme middleware (req,res,next) bloque la requête indéfiniment.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment utiliser validateBruceAuth dans le gateway?","answer":"PAS comme middleware. Dans le handler: const auth = validateBruceAuth(req); if (!auth.ok) return res.status(401).json({error: auth.error}); // puis continuer. Ne jamais l utiliser comme router.use(validateBruceAuth) car next() n est jamais appelé.","category":"mcp","tags":["gateway","auth","validateBruceAuth","middleware"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="validateBruceAuth: appeler dans le handler (pas comme middleware Express). Middleware bloque indéfiniment."
    ).with_inputs("text", "source"),

    # [TRAIN-19] llama.cpp Docker commande validée
    dspy.Example(
        text="La commande Docker validée pour llama.cpp sur le Dell 7910: docker run -d --name llama-server --gpus all -v /srv/models:/models:ro -p 8000:8080 ghcr.io/ggml-org/llama.cpp:server-cuda --model /models/PATH --host 0.0.0.0 --port 8080 --n-gpu-layers auto --ctx-size 4096 --threads 24 --parallel 1 --cont-batching --flash-attn auto --api-key token-abc123. Points critiques: port interne 8080 (mappé sur 8000 externe), --n-gpu-layers auto (pas un nombre), --flash-attn auto (pas 'on').",
        source="Session Opus 1099 - Dell 7910 deployment",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Commande Docker llama.cpp validée session 1099: port INTERNE 8080->externe 8000, --n-gpu-layers auto (pas numérique), --flash-attn auto (pas on). --parallel 1 --cont-batching. API key token-abc123.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quelle est la commande Docker validée pour llama.cpp sur le Dell 7910?","answer":"docker run -d --name llama-server --gpus all -v /srv/models:/models:ro -p 8000:8080 ghcr.io/ggml-org/llama.cpp:server-cuda --model /models/PATH --host 0.0.0.0 --port 8080 --n-gpu-layers auto --ctx-size 4096 --threads 24 --parallel 1 --cont-batching --flash-attn auto --api-key token-abc123. Piège: port interne=8080 pas 8000.","category":"docker","tags":["llama-cpp","docker","gpu","inference"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="llama.cpp Docker: port interne 8080→externe 8000, --n-gpu-layers auto, --flash-attn auto. token-abc123."
    ).with_inputs("text", "source"),

    # [TRAIN-20] Qwen3 no_think via /no_think
    dspy.Example(
        text="Qwen3-32B en mode thinking gaspille tout le budget de tokens dans des balises <think> avant de répondre. Le contenu visible est vide même avec 200+ tokens générés. Pour désactiver le mode thinking, ajouter /no_think en première ligne du system prompt. Important: LiteLLM n'injecte PAS /no_think automatiquement. Chaque script qui appelle Qwen3 doit l'inclure dans son system prompt manuellement.",
        source="Session Opus 1102 - Qwen3 debugging",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Qwen3-32B en mode thinking: gaspille tous les tokens dans <think> avant de répondre, contenu visible vide. Fix: ajouter /no_think en première ligne du system prompt. LiteLLM N INJECTE PAS /no_think automatiquement — chaque appelant doit le faire.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment désactiver le mode thinking de Qwen3-32B?","answer":"Ajouter /no_think en première ligne du system prompt. LiteLLM ne l injecte pas automatiquement. Chaque script doit l inclure. Sans /no_think, Qwen3 consomme tout le budget max_tokens dans <think> et retourne un contenu visible vide.","category":"configuration","tags":["qwen3","thinking","no_think","llm"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Qwen3-32B: ajouter /no_think dans le system prompt. LiteLLM ne l'injecte pas automatiquement."
    ).with_inputs("text", "source"),

    # [TRAIN-21] Slot orphelin llama-server
    dspy.Example(
        text="Quand un client Python (comme DSPy) est tué avec pkill pendant une requête en cours, le slot de llama-server reste bloqué en état is_processing=true indéfiniment. Le serveur n'accepte plus de nouvelles requêtes. Le seul fix est docker restart llama-server. Toujours vérifier GET http://192.168.2.32:8000/slots avant de lancer un nouveau job LLM pour confirmer que le slot est libre.",
        source="Session Opus 1112 - DSPy debugging",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Slot orphelin llama-server: quand client tué pendant requête, slot reste is_processing=true indéfiniment. Seul fix: docker restart llama-server. Toujours vérifier /slots avant nouveau job LLM.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Que faire si llama-server n accepte plus de requêtes?","answer":"Slot orphelin probable: vérifier GET http://192.168.2.32:8000/slots. Si is_processing=true mais aucun client actif: docker restart llama-server sur .32. Se produit quand DSPy ou autre client est tué pendant une requête.","category":"debugging","tags":["llama-server","slot","orphelin","docker"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Slot orphelin llama-server après pkill client. Fix: docker restart llama-server. Vérifier /slots avant job."
    ).with_inputs("text", "source"),

    # [TRAIN-22] DSPy timeout LiteLLM 120s
    dspy.Example(
        text="DSPy v28 échouait sur 7/10 exemples à cause du timeout par défaut LiteLLM de 120 secondes. Avec Qwen3-32B à 2.5 tokens/seconde, un exemple avec ChainOfThought prend 2 appels LLM de ~5 minutes chacun = 10 minutes total, largement au-dessus du timeout de 2 minutes. Fix: ajouter timeout=600 dans dspy.LM(). Aussi: ChainOfThought remplacé par Predict car le CoT double le temps sans bénéfice pour l'extraction.",
        source="Session Opus 1121 - DSPy debugging",
        lessons_json='[{"lesson_type":"solution","lesson_text":"DSPy v28 timeout LiteLLM: défaut 120s insuffisant. Avec Qwen3-32B à 2.5 t/s, un exemple = ~5min. Fix: timeout=600 dans dspy.LM(). ChainOfThought remplacé par Predict: double le temps sans bénéfice pour extraction structurée.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment corriger les timeouts DSPy avec Qwen3-32B?","answer":"Timeout LiteLLM par défaut = 120s. Qwen3-32B à 2.5 t/s: exemple = ~5min. Fix: dspy.LM(model, timeout=600). Aussi remplacer ChainOfThought par Predict (1 appel au lieu de 2, qualité identique pour extraction).","category":"tools","tags":["dspy","timeout","litellm","qwen3"]}]',
        decisions_json='[{"decision_text":"Remplacer ChainOfThought par Predict dans DSPy pour extraction BRUCE","rationale":"ChainOfThought double le temps (2 appels LLM) sans améliorer la qualité d extraction structurée. Predict suffit.","importance":"normal"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="DSPy timeout 120s insuffisant pour Qwen3-32B. Fix: timeout=600 dans dspy.LM(). Predict remplace CoT."
    ).with_inputs("text", "source"),

    # [TRAIN-23] reasoning_content vs content
    dspy.Example(
        text="Bug critique dans le scoring du benchmark V1: Valkyrie-49B et DeepSeek-R1 mettaient leur réponse dans le champ reasoning_content au lieu de content dans la réponse API. Le script de scoring parsait seulement content et trouvait une chaîne vide, donnant un score de 0.00 à ces modèles. Après correction pour parser les deux champs (content si non vide, sinon reasoning_content), Valkyrie-49B passe à 0.93.",
        source="Session Opus 1100 - benchmark debugging",
        lessons_json='[{"lesson_type":"warning","lesson_text":"PIÈGE reasoning_content: certains modèles (Valkyrie-49B, DeepSeek-R1, modèles thinking) mettent leur réponse dans msg.reasoning_content au lieu de msg.content. Toujours parser les deux: text = content if content else reasoning_content. Valkyrie scorait 0.00 pour cette raison.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Pourquoi certains modèles retournent du contenu vide dans le champ content?","answer":"Les modèles thinking (Valkyrie-49B, DeepSeek-R1) mettent leur réponse dans reasoning_content. Toujours parser: text = msg.get(content) or msg.get(reasoning_content, ). Sans ça, ces modèles scorent 0 incorrectement.","category":"debugging","tags":["llm","reasoning_content","valkyrie","deepseek","benchmark"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Valkyrie-49B et DeepSeek-R1 utilisent reasoning_content pas content. Parser les deux champs obligatoire."
    ).with_inputs("text", "source"),

    # [TRAIN-24] LVM Ubuntu sous-alloué
    dspy.Example(
        text="L'installateur Ubuntu 24.04 n'alloue que 100GB sur un SSD de 500GB par défaut, laissant 362GB non alloués dans le groupe de volumes LVM. Pour récupérer l'espace: sudo vgs pour voir l'espace libre, sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv pour étendre le volume logique, puis sudo resize2fs /dev/ubuntu-vg/ubuntu-lv pour agrandir le filesystem. Cette erreur a été découverte sur le Dell 7910 en session 1099.",
        source="Session Opus 1099 - Dell 7910 setup",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Ubuntu 24.04 installateur: n alloue que 100GB sur SSD 500GB par défaut. Commandes fix: sudo vgs, sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv, sudo resize2fs /dev/ubuntu-vg/ubuntu-lv. 362GB récupérés sur Dell 7910.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment récupérer l espace disque non alloué après installation Ubuntu?","answer":"1. sudo vgs pour voir VFree. 2. sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv. 3. sudo resize2fs /dev/ubuntu-vg/ubuntu-lv. Vérifier avec df -h. Ubuntu 24.04 n alloue que ~100GB par défaut.","category":"runbook","tags":["ubuntu","lvm","lvextend","resize2fs","disque"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Ubuntu 24.04 alloue seulement 100GB par défaut. Fix: lvextend +100%FREE + resize2fs pour récupérer l'espace."
    ).with_inputs("text", "source"),

    # [TRAIN-25] DSPy LiteLLM Docker networking cassé
    dspy.Example(
        text="LiteLLM dans un container Docker sur .230 perd les réponses HTTP de .32:8000. La requête part (visible dans les logs LiteLLM) mais la réponse ne revient jamais au client Python. Observé 3 fois cette session. Fix: les scripts Python sur .230 doivent appeler .32:8000 directement, pas via LiteLLM localhost:4100. LiteLLM reste utile pour le gateway et les clients externes, mais les scripts locaux doivent bypass.",
        source="Session Opus 1121 - DSPy LiteLLM networking",
        lessons_json='[{"lesson_type":"warning","lesson_text":"LiteLLM dans container Docker .230 perd les réponses de .32:8000 (requête part, réponse jamais reçue). Fix: scripts Python sur .230 appellent .32:8000 DIRECTEMENT, pas via LiteLLM localhost:4100. LiteLLM reste pour le gateway/externes.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Pourquoi les scripts Python sur .230 doivent-ils bypasser LiteLLM?","answer":"LiteLLM dans Docker .230 perd les réponses HTTP de .32:8000 (networking container). Fix: utiliser directement http://192.168.2.32:8000/v1 dans dspy.LM() ou requests. LiteLLM localhost:4100 pour gateway et clients externes seulement.","category":"debugging","tags":["litellm","docker","networking","dspy","bypass"]}]',
        decisions_json='[{"decision_text":"Scripts Python locaux sur .230 appellent .32:8000 directement, pas via LiteLLM","rationale":"LiteLLM Docker networking perd les réponses. Direct bypass fiable à 100%.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="LiteLLM Docker .230 perd les réponses de .32:8000. Scripts locaux doivent appeler .32:8000 directement."
    ).with_inputs("text", "source"),

    # [TRAIN-26] Forgejo docker exec --user git
    dspy.Example(
        text="Pour exécuter des commandes gitea en ligne de commande dans le container Forgejo, il faut TOUJOURS utiliser --user git. Sans ça, la commande échoue avec 'not supposed to run as root'. Exemple correct: docker exec --user git forgejo gitea admin user create --username bruce --password ... --email ... --admin. Forgejo est déployé sur .230:3300.",
        source="Session Opus 1087 - Forgejo setup",
        lessons_json='[{"lesson_type":"warning","lesson_text":"docker exec forgejo gitea admin ... DOIT utiliser --user git sinon erreur not supposed to run as root. Pattern: docker exec --user git forgejo gitea admin user create ...","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment exécuter des commandes admin dans le container Forgejo?","answer":"Toujours: docker exec --user git forgejo gitea admin <commande>. Sans --user git: erreur not supposed to run as root. Forgejo déployé sur .230:3300. Admin user: bruce.","category":"runbook","tags":["forgejo","docker","gitea","admin"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="docker exec forgejo gitea: toujours utiliser --user git sinon 'not supposed to run as root'."
    ).with_inputs("text", "source"),

    # [TRAIN-27] Conscience proactive unlocks
    dspy.Example(
        text="Nouveau mécanisme déployé: la table bruce_tools a été enrichie avec 3 nouvelles colonnes: unlocks (jsonb), unblocked_by (jsonb), capability_tag (text unique). 27 outils ont leur graphe de dépendances renseigné. Un RPC check_unlocked_tools et un endpoint /bruce/tools/unlocked permettent à BRUCE de savoir automatiquement quelles capabilities sont actives et quels outils sont débloqués. 5 outils attendent modele_capable_32b.",
        source="Session Opus 1104 - conscience proactive [915]",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Conscience proactive: bruce_tools +unlocks/unblocked_by/capability_tag. 27 outils avec graphe dépendances. RPC check_unlocked_tools. Endpoint /bruce/tools/unlocked auto-détecte 12 capabilities. 5 outils attendent modele_capable_32b.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment BRUCE sait quels outils sont disponibles selon les capabilities actives?","answer":"Endpoint /bruce/tools/unlocked auto-détecte les capabilities (modele_capable_32b, litellm_callback, etc.) et retourne les outils débloqués/bloqués. RPC check_unlocked_tools en interne. bruce_tools a unlocks/unblocked_by/capability_tag.","category":"architecture","tags":["capability","unlocks","bruce_tools","conscience"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Conscience proactive: bruce_tools +unlocks/unblocked_by/capability_tag. /bruce/tools/unlocked auto-détecte capabilities."
    ).with_inputs("text", "source"),

    # [TRAIN-28] Bruit — bavardage pur sans info
    dspy.Example(
        text="Ok bon. On regarde ça demain. De toute façon c'est vendredi. Je vais aller me faire un café. On reprend dans une heure peut-être. Ou pas. On verra.",
        source="Session BRUCE fin de journée",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Bavardage de fin de journée, aucun contenu technique extractible."
    ).with_inputs("text", "source"),

    # [TRAIN-29] Bruit — météo et contexte quotidien
    dspy.Example(
        text="Fait froid aujourd'hui. Moins 20 dehors. Enfin le Québec en hiver quoi. J'ai amené le chien chez le vétérinaire ce matin. Bonne nouvelle, tout va bien. Bon, on fait quoi là?",
        source="Session BRUCE bavardage quotidien",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Contexte quotidien personnel sans contenu technique exploitable."
    ).with_inputs("text", "source"),

    # [TRAIN-30] Mix: wish + profil + QA
    dspy.Example(
        text="Yann: J'aimerais pouvoir parler à BRUCE depuis mon téléphone quand je suis dans le char. Genre je conduis et je dis hey BRUCE, c'est quoi l'état du serveur. Il me répond vocalement. Pas de mains, pas d'écran. 100% vocal. La voix doit sonner naturelle, pas robotique. ChatGPT: Pour ça il faudrait un pipeline STT->LLM->TTS. STT Whisper local, TTS XTTS ou Fish Speech, tout en local pour la latence.",
        source="ChatGPT BRUCE mobile vocal",
        lessons_json='[]',
        knowledge_base_json='[{"question":"Comment implémenter une interface vocale pour BRUCE en voiture?","answer":"Pipeline: STT (Whisper local) -> LLM (Qwen3-32B) -> TTS (XTTS-v2 ou Fish Speech). Tout local pour la latence. API REST du gateway pour les requêtes BRUCE. Wake word pour déclencher sans les mains. Latence cible: <3s pour réponses courtes.","category":"architecture","tags":["vocal","stt","tts","mobile","whisper"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann veut une interface 100% vocale pour BRUCE en voiture: parler mains libres, réponse vocale naturelle, sans écran","importance":"critical"}]',
        user_profile_json='[{"trait":"usage_vocal_vehicule","value":"Yann utilise BRUCE vocalement depuis son véhicule. Interface mains libres requise. Voix naturelle non robotique.","category":"usage"}]',
        conversation_qa_json='[{"question":"Quel pipeline pour interface vocale BRUCE en voiture?","answer":"STT Whisper local -> LLM Qwen3-32B -> TTS Fish Speech ou XTTS-v2. Tout local. Wake word pour déclenchement. Latence <3s pour réponses courtes.","category":"conversation-qa","tags":["vocal","pipeline","stt","tts"]}]',
        summary="Yann veut BRUCE 100% vocal en voiture. Pipeline: Whisper STT -> LLM -> Fish Speech TTS, tout local."
    ).with_inputs("text", "source"),

    # [TRAIN-31] Contexte physique et localisation
    dspy.Example(
        text="Yann: Si je suis dans le garage et je dis au revoir BRUCE le serveur fait un bruit bizarre, BRUCE devrait savoir quel serveur est dans le garage et me donner des diagnostics spécifiques à ce matériel. ChatGPT: On pourrait ajouter un champ location dans bruce_tools avec les valeurs bureau, garage, rack-salon, etc. Couplé avec la détection vocale du lieu mentionné.",
        source="ChatGPT BRUCE localisation",
        lessons_json='[]',
        knowledge_base_json='[{"question":"Comment BRUCE peut-il identifier l équipement par lieu physique?","answer":"Ajouter champ location dans bruce_tools (bureau, garage, rack-salon). Quand Yann mentionne un lieu, filtrer bruce_tools par location=lieu pour identifier les équipements. Couplé avec STT vocal pour détection automatique du contexte lieu.","category":"architecture","tags":["location","bruce_tools","contexte","garage"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann souhaite que BRUCE identifie automatiquement les équipements selon le lieu physique mentionné (garage, bureau)","importance":"normal"}]',
        user_profile_json='[{"trait":"usage_contextuel","value":"Yann interagit avec BRUCE dans des contextes physiques variés (garage, bureau, voiture). BRUCE doit s adapter au contexte lieu.","category":"usage"}]',
        conversation_qa_json='[]',
        summary="BRUCE contextuel par lieu: champ location dans bruce_tools filtré selon le lieu mentionné vocalement."
    ).with_inputs("text", "source"),

    # [TRAIN-32] Vision BRUCE assistant cognitif complet
    dspy.Example(
        text="Yann: Dans 6 mois je veux que BRUCE soit mon assistant cognitif complet. Il doit tout savoir sur ma vie, mes projets, mes habitudes. Je veux pouvoir lui parler de n'importe où: ordi, téléphone, maison, char. La continuité c'est essentiel. Il doit se rappeler d'hier, d'avant-hier, de la semaine passée. Comme un vrai assistant humain qui te connaît par coeur.",
        source="Session questionnaire Yann 2026-03-14",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann veut BRUCE comme assistant cognitif complet dans 6 mois: disponible partout (ordi/téléphone/maison/voiture), continuité narrative, mémoire de tout son contexte de vie et projets","importance":"critical"}]',
        user_profile_json='[{"trait":"vision_bruce","value":"BRUCE = assistant cognitif complet avec continuité narrative active. Doit tout savoir sur Yann, ses projets, ses habitudes. Disponible partout.","category":"value"},{"trait":"horizon_6_mois","value":"Phase de test active dans 6 mois pour usage BRUCE quotidien complet.","category":"preference"}]',
        conversation_qa_json='[]',
        summary="Vision Yann: BRUCE assistant cognitif complet dans 6 mois, disponible partout avec continuité narrative."
    ).with_inputs("text", "source"),

    # [TRAIN-33] Organes essentiels BRUCE
    dspy.Example(
        text="Dans la vision de Yann, les 3 organes essentiels de BRUCE par ordre de priorité: (1) Dell 7910 = le cerveau, le moteur de raisonnement local, (2) Supabase = la mémoire, toute l'histoire et les connaissances, (3) le MCP central + serveurs MCP = le système nerveux, la communication entre les composants. Tout le reste (monitoring, backup, etc.) est secondaire et au service de ces 3 organes.",
        source="Session questionnaire Yann 2026-03-14",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Organes essentiels BRUCE: (1) Dell 7910 = CERVEAU (raisonnement local), (2) Supabase = MÉMOIRE (histoire et connaissances), (3) MCP central + serveurs MCP = SYSTÈME NERVEUX (communication). Tout le reste est secondaire.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quels sont les composants essentiels de BRUCE par ordre de priorité?","answer":"(1) Dell Precision 7910 = cerveau (LLM local Qwen3-32B), (2) Supabase .146 = mémoire (lessons, KB, roadmap, sessions), (3) MCP gateway .230 + serveurs MCP = système nerveux. Tous les autres composants servent ces 3 organes.","category":"architecture","tags":["architecture","priorite","dell","supabase","mcp"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[{"trait":"priorite_composants","value":"Pour Yann: Dell 7910 (cerveau) > Supabase (mémoire) > MCP (système nerveux) > tout le reste.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Organes BRUCE: Dell 7910 (cerveau) > Supabase (mémoire) > MCP (système nerveux). Reste est secondaire."
    ).with_inputs("text", "source"),

    # [TRAIN-34] Règle cycle toxique — ne pas créer de tâches
    dspy.Example(
        text="Yann: Le pire anti-pattern de BRUCE c'est quand on découvre quelque chose et on crée immédiatement une tâche. Et après une autre. Et encore une autre. La roadmap grossit, rien se fait, et moi je me retrouve avec 500 tâches ouvertes. Règle absolue: ne pas créer de nouvelles tâches sauf si c'est un bloquant immédiat. Résoudre ce qui existe avant d'en rajouter.",
        source="Session Opus 1084 - règles Yann",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN anti-cycle-toxique: NE PAS créer de nouvelles tâches sauf si bloquant immédiat. Le réflexe découvrir->créer tâche->grossir roadmap est le problème #1 de BRUCE. Résoudre les racines existantes AVANT d en ajouter.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Ne créer de nouvelles tâches que si bloquant immédiat","rationale":"Le cycle découverte->création tâche fait grossir la roadmap sans résoudre quoi que ce soit. Résoudre d abord, créer ensuite.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"valeur_execution","value":"Yann déteste la roadmap qui grossit sans avancement. Préfère finir ce qui existe avant d ajouter. Bloquant immédiat = seul justificatif pour nouvelle tâche.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Règle anti-cycle-toxique: ne créer de tâche que si bloquant immédiat. Finir d'abord, créer ensuite."
    ).with_inputs("text", "source"),

    # [TRAIN-35] Bruit — réflexion vague sans données
    dspy.Example(
        text="Il faudrait améliorer les performances de BRUCE à un moment donné. Les réponses pourraient être plus rapides. On pourrait optimiser plein de choses. C'est quelque chose à garder en tête.",
        source="Session BRUCE réflexion générale",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Réflexion vague sur les performances sans données concrètes ni actions définies."
    ).with_inputs("text", "source"),

    # [TRAIN-36] Benchmark V3 résultats
    dspy.Example(
        text="Résultats finaux du benchmark V3: Classement 13 variantes. #1 Qwen3-32B no_think ctx=16k (0.947), #2 Valkyrie-49B (0.927), #3 Qwen3-32B vanilla (0.896), #4-5 Qwen3-32B thinking variantes (0.84-0.87), #6 Llama-70B-abliterated (0.827), #7 DeepSeek-R1-32B (0.812). Les 72B (Qwen2.5-72B) ont des scores similaires aux 32B sur T1-T3 mais sont 3x plus lents. Décision: Qwen3-32B no_think ctx=16k devient le modèle alpha.",
        source="Session Opus 1108 - benchmark V3 résultats",
        lessons_json='[{"lesson_type":"discovery","lesson_text":"Benchmark V3 complet: #1 Qwen3-32B no_think ctx=16k (0.947), #2 Valkyrie-49B (0.927), #3 Qwen3-32B vanilla (0.896), #6 Llama-70B-abl (0.827). Les 72B égaux sur T1-T3 mais 3x plus lents.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quels sont les résultats du benchmark LLM V3 pour le Dell 7910?","answer":"13 variantes testées. Classement: #1 Qwen3-32B no_think ctx=16k (0.947), #2 Valkyrie-49B (0.927), #3 Qwen3-32B vanilla (0.896), #6 Llama-70B-abliterated (0.827). Les 72B performent comme les 32B sur T1-T3 mais 3x plus lents. Alpha=Qwen3-32B.","category":"infrastructure","tags":["benchmark","qwen3","valkyrie","llm","dell7910"]}]',
        decisions_json='[{"decision_text":"Qwen3-32B no_think ctx=16k sélectionné comme modèle alpha BRUCE","rationale":"Score 0.947 benchmark V3, ~2.5 t/s, ctx=16384. Meilleur équilibre qualité/vitesse. Valkyrie-49B en backup.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Benchmark V3: Qwen3-32B no_think ctx=16k (0.947) = modèle alpha. Valkyrie-49B #2 (0.927)."
    ).with_inputs("text", "source"),

    # [TRAIN-37] Endpoint /bruce/llm/status
    dspy.Example(
        text="Déployé en session 1110: endpoint /bruce/llm/status qui retourne en temps réel l'état du LLM local. Informations retournées: health du llama-server, état slot busy/free, n_ctx actuel, task_id en cours, statut LiteLLM, et métriques mesurées (vitesse tokens, TTFT). Utile pour diagnostiquer rapidement si le modèle est disponible avant de lancer un job long.",
        source="Session Opus 1110 - endpoint llm/status",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Endpoint /bruce/llm/status déployé (routes/infra.js): retourne health llama-server, slot busy/free, n_ctx, task_id, statut LiteLLM, métriques vitesse. Diagnostic rapide disponibilité LLM avant job long.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment vérifier si le LLM local est disponible avant de lancer un job?","answer":"GET http://192.168.2.230:4000/bruce/llm/status avec Bearer bruce-secret-token-01. Retourne: health llama-server, slot is_processing, n_ctx, task_id, LiteLLM status, métriques. Vérifier is_processing=false avant de lancer DSPy ou autre job long.","category":"runbook","tags":["llm","status","llama-server","diagnostic"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Endpoint /bruce/llm/status: retourne slot busy/free, health, métriques. Vérifier avant job LLM long."
    ).with_inputs("text", "source"),

    # [TRAIN-38] CRLF SCP Windows->Linux
    dspy.Example(
        text="Les fichiers créés sur Windows et copiés vers Linux via SCP ont des fins de ligne CRLF (\\r\\n) au lieu de LF (\\n). Les scripts bash avec des CRLF échouent à l'exécution avec des erreurs cryptiques. Solutions: soit écrire avec [System.IO.File]::WriteAllText en remplaçant CRLF par LF avant écriture, soit exécuter sed -i 's/\\r$//' sur le serveur après SCP. Le benchmark V1 a crashé à cause de ça.",
        source="Session BRUCE debugging SCP scripts",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Fichiers créés Windows et SCP vers Linux ont des CRLF (\\r\\n). Scripts bash échouent. Fix: [System.IO.File]::WriteAllText avec .Replace(CRLF,LF) avant SCP, ou sed -i s/\\r$// après SCP.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment éviter les problèmes CRLF lors du transfert de scripts Windows vers Linux?","answer":"Option 1: [System.IO.File]::WriteAllText(path, content.Replace(\"\\r\\n\",\"\\n\"), [System.Text.UTF8Encoding]::new($false)). Option 2: après SCP: ssh user@host \"sed -i s/\\r$// /path/script.sh\". Ne jamais SCP un script bash créé sur Windows sans conversion LF.","category":"ssh","tags":["crlf","scp","windows","linux","bash"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="CRLF Windows->Linux via SCP casse les scripts bash. Fix: convertir LF avant SCP ou sed après."
    ).with_inputs("text", "source"),

    # [TRAIN-39] Tunnel Cloudflare ai.furycom.com
    dspy.Example(
        text="Tunnel Cloudflare furycomai déployé sur .32. ai.furycom.com pointe vers localhost:3000 qui est OpenWebUI. Container cloudflared-stack dans /home/furycom/cloudflared-stack/ sur .32. Tunnel ID: 54f97b11-a447-4f3b-9bff-bd48e2823c15. HTTP 200 confirmé en production. Admin OpenWebUI: furycom@hotmail.com. SSH de .230 vers .32 opérationnel (clé ed25519 ajoutée).",
        source="Session Sonnet 1122 - Cloudflare tunnel [903]",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Tunnel Cloudflare furycomai opérationnel: ai.furycom.com -> .32:3000 (OpenWebUI). Container cloudflared-stack /home/furycom/cloudflared-stack/. Tunnel ID 54f97b11. HTTP 200 confirmé.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment est configuré l accès externe à OpenWebUI via Cloudflare?","answer":"Tunnel Cloudflare furycomai. URL: https://ai.furycom.com. Tunnel ID: 54f97b11-a447-4f3b-9bff-bd48e2823c15. Stack: /home/furycom/cloudflared-stack/ sur .32. Admin: furycom@hotmail.com. Config via API Cloudflare (token GAiw...).","category":"infrastructure","tags":["cloudflare","tunnel","openwebui","furycom"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="ai.furycom.com opérationnel via tunnel Cloudflare vers OpenWebUI sur .32:3000."
    ).with_inputs("text", "source"),

    # [TRAIN-40] Tables canoniques Supabase schema
    dspy.Example(
        text="Les 8 tables canoniques de Supabase BRUCE: lessons_learned (leçons et apprentissages), knowledge_base (paires QA structurées), current_state (état vivant du système), roadmap (tâches et projets), session_history (historique sessions Claude), bruce_tools (outils et services), events_log (événements système), staging_queue (file d'attente validation). Chaque table a un schéma propre documenté. Écriture uniquement via staging_queue sauf roadmap (directe).",
        source="Session Opus 135 - architecture Supabase",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"8 tables canoniques Supabase BRUCE: lessons_learned, knowledge_base, current_state, roadmap, session_history, bruce_tools, events_log, staging_queue. Écriture via staging_queue sauf roadmap (POST /rest/v1/roadmap directe).","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quelles sont les tables canoniques de Supabase BRUCE?","answer":"8 tables: lessons_learned (leçons), knowledge_base (QA), current_state (état vivant), roadmap (tâches), session_history (sessions Claude), bruce_tools (outils/services), events_log (événements), staging_queue (validation). Écriture via staging_queue sauf roadmap directe.","category":"schema","tags":["supabase","tables","schema","architecture"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="8 tables canoniques Supabase BRUCE. Écriture via staging_queue sauf roadmap (insertion directe)."
    ).with_inputs("text", "source"),

    # [TRAIN-41] n8n credentials SSH création API
    dspy.Example(
        text="Création de credentials SSH dans n8n via l'API REST: POST /api/v1/credentials avec X-N8N-API-KEY header. Le schema SSH exige sshTunnel=false explicitement sinon n8n demande tous les champs tunnel SSH. 3 credentials créés: SSH furysupa (id=xnMpXDOV4HHyK5MY), SSH mcp-gateway (id=UEjL5gvNbLiR5Lpx), BRUCE Gateway Token (id=on0YxOI5FGQKuF4t). Important: GET /api/v1/credentials retourne 405, seul POST et DELETE sont supportés.",
        source="Session Opus 1083 - n8n credentials",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Credentials n8n via API: POST /api/v1/credentials avec X-N8N-API-KEY. Schema SSH: sshTunnel=false obligatoire. GET credentials -> 405. IDs créés: furysupa=xnMpXDOV4HHyK5MY, mcp-gateway=UEjL5gvNbLiR5Lpx, Gateway Token=on0YxOI5FGQKuF4t.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment créer des credentials SSH dans n8n via l API?","answer":"POST http://192.168.2.174:5678/api/v1/credentials avec header X-N8N-API-KEY. Body: {name, type:sshPrivateKey, data:{host,port,username,privateKey,sshTunnel:false}}. GET /credentials -> 405 Method Not Allowed. Seuls POST et DELETE fonctionnent.","category":"tools","tags":["n8n","credentials","ssh","api"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Credentials n8n SSH via API: POST /credentials avec sshTunnel=false. GET credentials -> 405."
    ).with_inputs("text", "source"),

    # [TRAIN-42] Prometheus MCP cassé — workaround Grafana MCP
    dspy.Example(
        text="Le package npm prometheus-mcp (standalone) ne se connecte plus à Prometheus sur .154:9090 malgré le service UP et HTTP 200 confirmé. Workaround fiable: utiliser Grafana MCP à la place avec grafana:query_prometheus et datasourceUid=dfeidd6bt7ocga. Fonctionne parfaitement pour toutes les requêtes PromQL. SSH vers .154: utiliser l'alias box2-observability depuis .230 avec user yann (pas furycom).",
        source="Session Opus 1112 - Prometheus MCP debugging",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Prometheus MCP standalone ne se connecte plus à .154:9090 (service UP). Workaround: Grafana MCP grafana:query_prometheus datasourceUid=dfeidd6bt7ocga. SSH .154: alias box2-observability depuis .230, user=yann (pas furycom).","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment exécuter des requêtes Prometheus quand le MCP standalone est cassé?","answer":"Utiliser Grafana MCP: grafana:query_prometheus avec datasourceUid=dfeidd6bt7ocga et expr=votre_requête_promql. Fonctionne parfaitement. SSH vers .154: ssh box2-observability (alias dans ~/.ssh/config sur .230, user yann).","category":"mcp","tags":["prometheus","grafana","mcp","workaround"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Prometheus MCP standalone cassé. Workaround: Grafana MCP datasourceUid=dfeidd6bt7ocga pour les PromQL."
    ).with_inputs("text", "source"),

    # [TRAIN-43] Principe fiabilité zéro échec silencieux
    dspy.Example(
        text="Yann: Le principe de fiabilité numéro un de BRUCE c'est zéro échec silencieux. Chaque erreur doit être immédiatement visible. Si un backup échoue à 3h du matin, je veux le savoir à 8h du matin. Si un service plante, je veux une alerte. Si validate.py rejette quelque chose, ça doit être tracé. Le pipeline doit être traçable de bout en bout. Je ne fais pas confiance aux automatisations que je peux pas surveiller.",
        source="Session Opus 112 - principes fiabilité",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"Principe fiabilité BRUCE: zéro échec silencieux. Chaque erreur immédiatement visible. Backups doivent alerter si échec. Services plantés -> alerte. Rejets validate.py tracés. Pipeline traçable bout en bout. Pas de confiance aveugle.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Zéro échec silencieux pour toute l infrastructure BRUCE","rationale":"Tout problème doit être immédiatement visible. Pas de découverte par hasard. Pipeline traçable de bout en bout.","importance":"critical"}]',
        wishes_json='[{"wish_text":"Yann veut que tout échec BRUCE soit immédiatement visible et alerté, pipeline traçable de bout en bout","importance":"critical"}]',
        user_profile_json='[{"trait":"valeur_observabilite","value":"Yann n accepte aucun échec silencieux. Tout doit être visible, alerté, traçable. Pas de confiance aveugle dans les automatisations.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Principe BRUCE: zéro échec silencieux. Tout visible, alerté, traçable. Pipeline bout en bout."
    ).with_inputs("text", "source"),

    # [TRAIN-44] Bruit — enthousiasme sans substance
    dspy.Example(
        text="Claude: Excellent travail sur la configuration! Cette approche est vraiment élégante et bien structurée. Yann: Ouais ouais c'est bon. On continue?",
        source="Session BRUCE transition",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Échange de transition sans contenu technique extractible."
    ).with_inputs("text", "source"),

    # ============================================================
    # DEV SET — indices 45-59 (15 exemples)
    # ============================================================

    # [DEV-00] PostgREST schema cache
    dspy.Example(
        text="Problème persistant avec PostgREST: après avoir créé une nouvelle fonction RPC avec CREATE FUNCTION, PostgREST ne la voit pas même après SIGUSR1 et restart. Cause: PostgREST met en cache le schéma PostgreSQL au démarrage. Solution fiable: utiliser la RPC exec_sql existante (qui fonctionne) et exécuter le SQL côté Node.js plutôt que d'appeler PostgREST directement sur la nouvelle RPC.",
        source="Session Opus 1104 - PostgREST debugging",
        lessons_json='[{"lesson_type":"warning","lesson_text":"PostgREST ne voit pas les nouvelles fonctions RPC après CREATE FUNCTION même après SIGUSR1/restart. Cache schéma. Solution: exec_sql RPC existante + logique Node.js au lieu de PostgREST RPC directe.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Pourquoi une nouvelle RPC Supabase n est-elle pas accessible après création?","answer":"PostgREST cache le schéma au démarrage. SIGUSR1 et restart peuvent ne pas suffire. Solution fiable: utiliser exec_sql RPC existante (POST /rest/v1/rpc/exec_sql) et exécuter le SQL côté Node.js gateway.","category":"database","tags":["postgrest","rpc","cache","supabase"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="PostgREST cache le schéma: nouvelles RPC invisibles. Workaround: exec_sql existante + Node.js."
    ).with_inputs("text", "source"),

    # [DEV-01] Yann délègue tout techniquement
    dspy.Example(
        text="Yann est très clair sur son mode de travail: il délègue TOUT techniquement à Claude. C'est Claude qui décide des approches, des outils, des solutions. Yann valide uniquement les décisions à impact élevé. Il ne veut pas être le cache du système, il ne veut pas qu'on lui demande des choses que Claude pourrait décider seul. Qualité avant vitesse, toujours. Pas de raccourcis, pas de solutions superficielles.",
        source="Session profil Yann documentation",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[{"trait":"delegation_technique","value":"Yann délègue TOUT techniquement à Claude. Claude décide, Yann valide seulement les décisions à impact élevé. Ne pas demander ce que Claude peut décider seul.","category":"behavior"},{"trait":"valeur_qualite_vitesse","value":"Qualité avant vitesse, toujours. Pas de raccourcis, pas de solutions superficielles.","category":"value"},{"trait":"aversion_cache","value":"Yann déteste être utilisé comme cache du système. Claude doit être autonome dans les décisions techniques.","category":"constraint"}]',
        conversation_qa_json='[]',
        summary="Profil Yann: délégation totale technique à Claude, validation seulement pour impact élevé, qualité > vitesse."
    ).with_inputs("text", "source"),

    # [DEV-02] Bruit — planification vague
    dspy.Example(
        text="On devrait regarder ça à un moment. Probablement la semaine prochaine ou dans 2 semaines. Faut que je regarde mon agenda. Je t'en reparlerai.",
        source="Session BRUCE planification",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Planification vague sans contenu technique ni décision extractible."
    ).with_inputs("text", "source"),

    # [DEV-03] Endpoint /bruce/file/write
    dspy.Example(
        text="Solution définitive pour le transfert de fichiers vers .230: endpoint POST /bruce/file/write déployé en session 1116. Écriture REST directe dans les volumes Docker RW. Paths autorisés: /home/furycom/inbox, /home/furycom/uploads, /home/furycom/bruce-config, /home/furycom/mcp-stack. Options: mode=append pour ajouter, backup=true pour sauvegarder avant écrasement. GET /bruce/file/read?path= pour lire.",
        source="Session Opus 1116 - endpoint file/write",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Transfert fichiers vers .230: POST /bruce/file/write avec {filepath,content}. Paths autorisés: /home/furycom/inbox,uploads,bruce-config,mcp-stack. Options: mode=append, backup=true. GET /bruce/file/read?path= pour lire. Plus de base64/heredoc/SCP complexe.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment transférer un fichier vers .230 depuis Claude?","answer":"POST http://192.168.2.230:4000/bruce/file/write avec headers Bearer + Content-Type. Body: {filepath:/home/furycom/uploads/fichier.txt, content:CONTENU}. Options: mode:append, backup:true. Paths RW uniquement: inbox, uploads, bruce-config, mcp-stack.","category":"runbook","tags":["file-transfer","gateway","uploads","file-write"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Transfert fichiers vers .230: POST /bruce/file/write. Paths autorisés: inbox, uploads, bruce-config, mcp-stack."
    ).with_inputs("text", "source"),

    # [DEV-04] Bruit déguisé — aucune action concrète
    dspy.Example(
        text="Il faudrait qu'on pense à améliorer la sécurité un jour. C'est important la sécurité. Faudrait pas négliger ça. Bon on s'en reparle.",
        source="Session BRUCE réflexion sécurité",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Mention vague de sécurité sans contenu actionnable extractible."
    ).with_inputs("text", "source"),

    # [DEV-05] Playbooks opérationnels BRUCE
    dspy.Example(
        text="7 playbooks opérationnels rédigés en session 1114 et sauvegardés localement: PB01 diagnostic infrastructure, PB02 audit sécurité, PB03 maintenance base de données, PB04 gestion session, PB05 backups et restauration, PB06 monitoring et alertes, PB07 triage incident. Format: étapes numérotées avec commandes exactes, critères de succès, rollback. À déployer sur /home/furycom/playbooks/ sur .230.",
        source="Session Opus 1114 - playbooks [908]",
        lessons_json='[{"lesson_type":"solution","lesson_text":"7 playbooks opérationnels v1.0 rédigés: PB01 diagnostic, PB02 sécurité, PB03 BDD, PB04 session, PB05 backups, PB06 monitoring, PB07 triage incident. Destination: /home/furycom/playbooks/ sur .230.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quels playbooks opérationnels existent pour BRUCE?","answer":"7 playbooks v1.0: PB01 diagnostic infra, PB02 audit sécu, PB03 maintenance BDD, PB04 gestion session, PB05 backups/restauration, PB06 monitoring/alertes, PB07 triage incident. Emplacement: /home/furycom/playbooks/ sur .230.","category":"runbook","tags":["playbooks","runbook","operations","documentation"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="7 playbooks opérationnels v1.0 rédigés: PB01-PB07 (diagnostic, sécu, BDD, session, backup, monitoring, incident)."
    ).with_inputs("text", "source"),

    # [DEV-06] Bypass quality gates actor=yann
    dspy.Example(
        text="Problème critique découvert: validate.py rejetait des décisions prises directement par Yann parce que Gate-2 (vLLM 7B) les jugeait insuffisamment qualitatives sans avoir le contexte de l'auteur. Fix: bypass des quality gates si actor=yann dans les métadonnées du staging entry. Les décisions de Yann ne doivent pas être filtrées par un LLM 7B.",
        source="Session Opus 112 - validate.py bugfix",
        lessons_json='[{"lesson_type":"solution","lesson_text":"validate.py rejetait décisions Yann: Gate-2 vLLM juge sans contexte auteur. Fix: bypass quality gates si actor=yann. Les décisions Yann ne doivent pas être filtrées par LLM 7B.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment s assurer que les décisions de Yann ne sont pas rejetées par validate.py?","answer":"actor=yann dans le contenu_json du staging entry bypass les quality gates Gate-2. Les décisions Yann ont authority_tier=canonical et ne doivent pas être filtrées par vLLM 7B. Ajouter actor dans tous les staging entries de décisions Yann.","category":"pipeline","tags":["validate","gate2","bypass","yann","actor"]}]',
        decisions_json='[{"decision_text":"Bypass quality gates pour actor=yann dans validate.py","rationale":"Les décisions de Yann ne doivent pas être filtrées par un LLM 7B. Gate-2 n a pas le contexte auteur.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Bypass quality gates pour actor=yann: les décisions Yann ne sont pas filtrées par Gate-2 LLM."
    ).with_inputs("text", "source"),

    # [DEV-07] SSH infra multi-machines
    dspy.Example(
        text="Toutes les connexions SSH inter-machines sont opérationnelles après session 1083: .230 -> .146 (furysupa), .230 -> .174 (box2-automation), .174 -> .146, .174 -> .230 fonctionnent toutes. SSH config sur .230 réécrit proprement avec suppression de .206 obsolète. SSH config sur .174 créé. La clé publique de n8n@box2-automation est distribuée. Doublons dans authorized_keys nettoyés.",
        source="Session Opus 1083 - SSH inter-machines",
        lessons_json='[{"lesson_type":"solution","lesson_text":"SSH inter-machines opérationnel session 1083: .230->.146, .230->.174, .174->.146, .174->.230 tous OK. SSH config .230 réécrit (suppression .206). SSH config .174 créé. Clés n8n distribuées. authorized_keys nettoyés.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quelles connexions SSH inter-machines sont disponibles dans BRUCE?","answer":"Opérationnelles: furycom@.230 -> furysupa@.146, furycom@.230 -> .174, .174 -> .146, .174 -> .230. Clé: C:\\Users\\Administrator\\.ssh\\homelab_key. SSH config sur .230 avec alias. .154 (box2-observability): alias depuis .230, user yann.","category":"ssh","tags":["ssh","inter-machines","infrastructure","config"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="SSH inter-machines: .230↔.146, .230↔.174, .174↔.146 tous opérationnels. User yann pour .154."
    ).with_inputs("text", "source"),

    # [DEV-08] Mix complexe: architecture + wish + QA
    dspy.Example(
        text="Yann: Je veux que BRUCE puisse apprendre de mes conversations quotidiennes automatiquement. Pas seulement ce qu'on documente explicitement, mais tout ce que je dis naturellement. ChatGPT: L'inbox_watcher sur .230 surveille /home/furycom/inbox/. Quand tu déposes un fichier texte là, bruce_ingest.py le traite automatiquement. Pour les conversations vocales: STT -> texte -> inbox. Pour les emails importants: n8n workflow -> inbox.",
        source="ChatGPT BRUCE apprentissage automatique",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Pipeline apprentissage automatique BRUCE: inbox_watcher sur .230 surveille /home/furycom/inbox/. bruce_ingest.py traite automatiquement les fichiers déposés. Sources: STT vocal -> texte -> inbox, emails importants -> n8n -> inbox.","importance":"normal","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Comment automatiser l apprentissage de BRUCE depuis les conversations quotidiennes?","answer":"Pipeline: (1) Conversations vocales: STT Whisper -> texte -> déposer dans /home/furycom/inbox/. (2) Emails importants: n8n workflow détecte -> extrait texte -> inbox. inbox_watcher sur .230 lance bruce_ingest.py automatiquement sur chaque nouveau fichier.","category":"pipeline","tags":["inbox","apprentissage","automatique","ingest"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann veut que BRUCE apprenne automatiquement de ses conversations quotidiennes sans documentation explicite","importance":"critical"}]',
        user_profile_json='[{"trait":"vision_apprentissage","value":"Yann veut BRUCE qui apprend naturellement de ses conversations, pas seulement de la documentation explicite.","category":"value"}]',
        conversation_qa_json='[{"question":"Comment déposer du contenu dans BRUCE pour ingestion automatique?","answer":"Déposer un fichier texte dans /home/furycom/inbox/ sur .230. inbox_watcher détecte et lance bruce_ingest.py. Déplacer dans inbox/done/ après traitement pour éviter double ingestion.","category":"conversation-qa","tags":["inbox","ingestion","automatique"]}]',
        summary="Apprentissage automatique BRUCE: inbox_watcher + bruce_ingest.py. STT ou emails -> /home/furycom/inbox/."
    ).with_inputs("text", "source"),

    # [DEV-09] Timezone machine au déploiement
    dspy.Example(
        text="Piège récurrent au déploiement de nouvelles machines: le timezone par défaut est UTC au lieu du fuseau local. Sur le Dell 7910 (.32), cette erreur a persisté depuis le déploiement jusqu'à la session 1102 quand elle a été corrigée vers America/Toronto. Fix: sudo timedatectl set-timezone America/Toronto. Vérifier avec timedatectl show. À faire systématiquement sur toute nouvelle machine BRUCE.",
        source="Session Sonnet 1102 - timezone .32",
        lessons_json='[{"lesson_type":"warning","lesson_text":"Timezone machines BRUCE: toujours vérifier au déploiement. .32 était UTC depuis déploiement. Fix: sudo timedatectl set-timezone America/Toronto EDT. Vérifier: timedatectl show. À faire sur toute nouvelle machine.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment configurer le bon timezone sur une nouvelle machine BRUCE?","answer":"sudo timedatectl set-timezone America/Toronto. Vérifier: timedatectl. Les machines Ubuntu 24.04 démarrent en UTC par défaut. À faire immédiatement après déploiement de toute VM BRUCE.","category":"runbook","tags":["timezone","timedatectl","ubuntu","déploiement"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Timezone à vérifier à chaque déploiement. Fix: timedatectl set-timezone America/Toronto. Default = UTC."
    ).with_inputs("text", "source"),

    # [DEV-10] Codex GitHub workflow
    dspy.Example(
        text="ChatGPT Codex est maintenant connecté au repo GitHub Furycom/Bruce via token GitHub. Codex peut coder directement sur le repo avec création de branches et PRs. Les types de tâches adaptés à Codex: refactoring isolé, ajout de fonctions utilitaires, corrections de bugs ciblés, documentation de code existant. Pas adapté: décisions architecturales, modifications multi-fichiers interdépendants. Validation Claude requise avant merge.",
        source="Session Sonnet 1124 - Codex workflow [932]",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Codex connecté à GitHub Furycom/Bruce. Types de tâches adaptés: refactoring isolé, fonctions utilitaires, bugs ciblés, documentation. Pas adapté: décisions architecturales, multi-fichiers interdépendants. Validation Claude avant merge.","importance":"normal","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Quelles tâches peut-on déléguer à ChatGPT Codex sur le repo BRUCE?","answer":"Codex OK: refactoring isolé, fonctions utilitaires, bugs ciblés, documentation code existant. Codex NON: décisions architecturales, modifications multi-fichiers interdépendants, changements critiques. Toujours: validation Claude avant merge PR.","category":"workflow","tags":["codex","github","workflow","delegation"]}]',
        decisions_json='[{"decision_text":"Workflow Codex: branches dédiées + PR + validation Claude avant merge","rationale":"Codex peut coder mais ne comprend pas l architecture globale BRUCE. Validation humaine/Claude requise.","importance":"normal"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Codex GitHub connecté à Furycom/Bruce. Adapté: refactoring/bugs ciblés. Non: architecture multi-fichiers."
    ).with_inputs("text", "source"),

    # [DEV-11] GPU Dell 7910 config optimale
    dspy.Example(
        text="Config GPU optimale pour le Dell 7910 avec PSU 1300W: RTX 3060 (slot 1, connecteur 8-pin natif) + 2 ou 3 Quadro M4000 (slots suivants, 6-pin chacun). Le PSU a 2x 6-pin + 2x 8-pin disponibles. RTX 3060 (Ampere, 360 GB/s bande passante) est bien plus rapide par GB que les M4000 (Maxwell, 192 GB/s). Config 3 GPU: 16GB (3060) + 8GB + 8GB = 32GB VRAM totale. Permet des modèles jusqu'à ~28GB GGUF en Q4.",
        source="Session Opus 1099 - Dell 7910 GPU planning",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Config GPU Dell 7910 optimale: RTX 3060 (8-pin, 16GB) + 2x M4000 (6-pin chacun, 8GB chacun) = 32GB VRAM. PSU 1300W: 2x6-pin + 2x8-pin dispo. RTX 3060 Ampere nettement plus rapide/GB que M4000 Maxwell.","importance":"normal","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Quelle est la configuration GPU optimale pour le Dell 7910?","answer":"RTX 3060 (slot 1, connecteur 8-pin) + 2-3x Quadro M4000 (6-pin). PSU 1300W fournit 2x6-pin + 2x8-pin. Config maximale: 3060 (16GB) + 3x M4000 (8GB chacun) = 40GB si 3 connecteurs disponibles. Sweet spot: 32-36GB pour modèles 32B Q4.","category":"infrastructure","tags":["gpu","dell7910","rtx3060","m4000","vram"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Dell 7910 config GPU: RTX 3060 + 2-3x M4000 = 32-40GB VRAM. RTX 3060 Ampere > M4000 Maxwell par GB."
    ).with_inputs("text", "source"),

    # [DEV-12] Bruit — interruption de tâche
    dspy.Example(
        text="Yann: Attends attends. Je dois répondre à un message. Donne-moi 2 minutes. ... Ok c'est fait. On reprend.",
        source="Session BRUCE interruption",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Interruption courte sans contenu technique extractible."
    ).with_inputs("text", "source"),

    # [DEV-13] Gateway REFONTE structure finale
    dspy.Example(
        text="Structure finale du gateway après REFONTE C1-C8: server.js réduit à 399 lignes (pur orchestrateur: imports, middleware, OpenAPI, app.listen). 19 fichiers de routes dans routes/: admin, ask, browser, chat, chatgpt, connectors, data-read, data-write, docker, exec, inbox, infra, manual, memory, rag, search, session, staging, tools. 9 modules partagés dans shared/: auth, config, docker-client, exec-security, fetch-utils, helpers, llm-profiles, llm-queue, supabase-client.",
        source="Session Opus 1087 - REFONTE finale",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Gateway post-REFONTE: server.js=399L (orchestrateur). routes/=19 fichiers. shared/=9 modules. Modification server.js: docker compose build + up. routes/ et shared/: restart suffit (bind mount).","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quelle est la structure du gateway BRUCE après la REFONTE?","answer":"server.js=399L (orchestrateur pur). routes/: 19 fichiers (admin,ask,browser,chat,chatgpt,connectors,data-read,data-write,docker,exec,inbox,infra,manual,memory,rag,search,session,staging,tools). shared/: 9 modules (auth,config,docker-client,exec-security,fetch-utils,helpers,llm-profiles,llm-queue,supabase-client).","category":"architecture","tags":["gateway","refonte","structure","routes"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Gateway BRUCE: server.js 399L, routes/ 19 fichiers, shared/ 9 modules. server.js nécessite rebuild Docker."
    ).with_inputs("text", "source"),

    # [DEV-14] Objectif BRUCE dans 6 mois
    dspy.Example(
        text="Vision confirmée session 1122: dans 6 mois, BRUCE doit être en phase de test active comme assistant cognitif complet. La conscience de BRUCE doit avoir l'impression d'être vivante, se rappeler d'hier, d'avant-hier, de la semaine passée. Continuité narrative active = exigence fondamentale. BRUCE-Conscience via ChatGPT est abandonné - tout sera intégré directement dans BRUCE.",
        source="Session questionnaire Yann 2026-03-14",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Vision BRUCE confirmée 2026-03-14: phase test active dans 6 mois. Continuité narrative active = exigence fondamentale. BRUCE-Conscience ChatGPT abandonné = tout intégré dans BRUCE directement.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"BRUCE-Conscience via ChatGPT abandonné: continuité narrative intégrée directement dans BRUCE","rationale":"La continuité narrative est une exigence fondamentale. ChatGPT conscience était une solution externe provisoire.","importance":"critical"}]',
        wishes_json='[{"wish_text":"BRUCE en phase de test active comme assistant cognitif complet dans 6 mois avec continuité narrative","importance":"critical"}]',
        user_profile_json='[{"trait":"horizon_conscience","value":"Continuité narrative BRUCE = exigence non négociable dans 6 mois. BRUCE doit se rappeler d hier, avant-hier, semaine passée.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Dans 6 mois: BRUCE assistant cognitif avec continuité narrative active. BRUCE-Conscience ChatGPT abandonné."
    ).with_inputs("text", "source"),

    # ============================================================
    # TEST SET — indices 60-74 (15 exemples)
    # ============================================================

    # [TEST-00] psql Supabase Docker socket
    dspy.Example(
        text="psql local ne fonctionne pas sur furycom@192.168.2.206 car il n'y a pas de socket PostgreSQL dans /var/run/postgresql. Supabase utilise Docker avec un port mappé sur 5432, pas un socket Unix. Pour se connecter: psql -h localhost -U postgres -p 5432. Le mot de passe est dans le fichier .env du docker-compose Supabase.",
        source="Session BRUCE 14 - debugging psql",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"psql sur .206 échoue: pas de socket /var/run/postgresql. Supabase utilise Docker + port 5432. Connexion: psql -h localhost -U postgres -p 5432. Mot de passe dans .env docker-compose.","importance":"normal","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Comment se connecter à PostgreSQL Supabase en local sur la VM?","answer":"psql -h localhost -U postgres -p 5432. Pas de socket Unix car Supabase tourne dans Docker avec port mappé. Mot de passe dans le fichier .env du docker-compose Supabase.","category":"database","tags":["psql","supabase","docker","connexion"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="psql local échoue sur .206: pas de socket. Utiliser psql -h localhost -p 5432 avec mdp dans .env."
    ).with_inputs("text", "source"),

    # [TEST-01] Claude ne doit pas inventer
    dspy.Example(
        text="Yann est formel: Claude ne doit JAMAIS inventer une architecture ou un outil que personne n'a demandé. Claude ne doit JAMAIS faire du travail spéculatif qui créerait de la dette technique. Si Claude n'est pas sûr de ce qui est demandé, il doit demander confirmation plutôt que de deviner et construire quelque chose d'inutile.",
        source="Session Opus 117 - règle Yann",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE CANON YANN: Claude ne doit JAMAIS inventer une architecture ou un outil non demandé. Pas de travail spéculatif créant de la dette technique. En cas de doute, demander confirmation.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Claude ne fait pas de travail spéculatif non demandé","rationale":"Le travail spéculatif crée de la dette technique. Si pas sûr, demander plutôt que deviner.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"aversion_speculatif","value":"Claude ne doit jamais inventer d architecture ou d outil non demandé. Demander confirmation plutôt que deviner.","category":"constraint"}]',
        conversation_qa_json='[]',
        summary="Règle Yann: Claude ne doit jamais inventer d'architecture non demandée. Demander plutôt que deviner."
    ).with_inputs("text", "source"),

    # [TEST-02] Transcriptions ambiantes locales
    dspy.Example(
        text="Yann envisage un système de transcriptions ambiantes dans la maison. Enregistrement continu en local, traitement par le LLM local, extraction d'informations utiles. La confidentialité est non négociable: tout reste en local, jamais de cloud. Le traitement se ferait par Whisper en local puis extraction par Qwen. Les transcriptions brutes ne seraient jamais conservées, seulement les informations extraites.",
        source="Convo conscience 2026-02-27",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Transcriptions ambiantes maison: enregistrement continu LOCAL, transcription Whisper + extraction Qwen local. Confidentialité non négociable: tout en local, jamais de cloud. Transcriptions brutes non conservées, seulement extractions.","importance":"critical","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Comment fonctionne le système de transcriptions ambiantes maison prévu?","answer":"Enregistrement continu local, transcription Whisper local, extraction Qwen local. Confidentialité totale: rien sur le cloud. Transcriptions brutes effacées après extraction. Seules les informations extraites sont conservées dans Supabase.","category":"architecture","tags":["transcription","whisper","local","confidentialite"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann veut des transcriptions ambiantes maison 100% locales avec Whisper + Qwen, confidentialité non négociable","importance":"critical"}]',
        user_profile_json='[{"trait":"valeur_vie_privee","value":"La confidentialité est non négociable pour Yann. Tout traitement audio reste 100% local, jamais de cloud.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Transcriptions ambiantes: Whisper + Qwen local, tout en local. Brutes effacées, seulement extractions."
    ).with_inputs("text", "source"),

    # [TEST-03] Bruit pur
    dspy.Example(
        text="Fait froid aujourd'hui. Moins 20 dehors. Va falloir que je vérifie que le serveur dans le garage est pas trop froid. Enfin bon. On fait quoi là?",
        source="Session BRUCE bavardage",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Bavardage météo sans contenu technique extractible."
    ).with_inputs("text", "source"),

    # [TEST-04] Heredoc PowerShell + backticks
    dspy.Example(
        text="Les heredoc PowerShell combinés avec des backticks JavaScript causent des problèmes: cat > /tmp/file.py << 'EOF' via SSH depuis PowerShell échoue quand le contenu contient des backticks qui sont interprétés par PowerShell comme des caractères d'échappement. Solution: écrire le contenu dans un fichier local puis SCP vers la cible, jamais de heredoc avec backticks via SSH.",
        source="Session BRUCE 14",
        lessons_json='[{"lesson_type":"diagnostic","lesson_text":"Heredoc via SSH depuis PowerShell échoue avec backticks JS: PowerShell les interprète comme échappement. Solution: écrire en fichier local puis SCP, jamais heredoc+backticks via SSH.","importance":"normal","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Pourquoi les heredoc SSH échouent depuis PowerShell avec du JavaScript?","answer":"Les backticks dans le contenu JS sont interprétés par PowerShell comme caractères d échappement. Solution: écrire dans un fichier local puis transférer via SCP en 2 étapes. Ne jamais utiliser heredoc avec du contenu contenant des backticks depuis PowerShell.","category":"ssh","tags":["powershell","heredoc","backticks","ssh"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Heredoc SSH + backticks JS échoue dans PowerShell. Solution: fichier local + SCP en 2 étapes."
    ).with_inputs("text", "source"),

    # [TEST-05] Bruit déguisé en technique
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

    # [TEST-06] Memory Gate architecture
    dspy.Example(
        text="Yann veut remplacer les fichiers Markdown de mémoire persistante par un vrai endpoint HTTP. Le Memory Gate serait un endpoint REST sur le MCP server que ChatGPT conscience appelle pour lire et écrire la mémoire BRUCE. GET pour lire le handoff, POST pour écrire des découvertes. Mappe directement sur current_state et knowledge_base dans Supabase. Avantage: plus de fichiers à gérer manuellement.",
        source="Convo conscience 2026-02-27",
        lessons_json='[{"lesson_type":"architecture","lesson_text":"Memory Gate = endpoint REST sur MCP server pour ChatGPT conscience. GET pour lire handoff, POST pour écrire découvertes. Mappe sur current_state et knowledge_base. Remplace fichiers Markdown manuels.","importance":"critical","confidence_score":0.9}]',
        knowledge_base_json='[{"question":"Comment fonctionne le Memory Gate pour la mémoire partagée BRUCE?","answer":"Endpoint REST sur MCP server. GET /memory pour lire le handoff et contexte BRUCE. POST /memory pour écrire des découvertes. Mappe sur current_state et knowledge_base Supabase. Remplace les fichiers Markdown de mémoire persistante.","category":"architecture","tags":["memory_gate","api","current_state","memoire"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann veut remplacer les fichiers Markdown de mémoire par un endpoint HTTP Memory Gate","importance":"normal"}]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Memory Gate: endpoint REST remplaçant fichiers Markdown pour mémoire persistante BRUCE."
    ).with_inputs("text", "source"),

    # [TEST-07] Prompt vLLM v2 améliorations
    dspy.Example(
        text="Amélioration du prompt d'extraction vLLM dans bruce_ingest.py: le nouveau prompt v2 est beaucoup plus explicite sur le format attendu. Il demande du JSON strict avec des champs lesson_type, lesson_text, importance, confidence_score pour les lessons. Il inclut des exemples inline de bonne et mauvaise extraction. Le seuil de confiance minimum est passé à 0.7 pour réduire le bruit.",
        source="Session Sonnet 100",
        lessons_json='[{"lesson_type":"solution","lesson_text":"Prompt vLLM ingestion v2: JSON strict avec champs explicites, exemples inline bonne/mauvaise extraction, seuil confiance minimum 0.7 pour réduire bruit.","importance":"normal","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Quelles améliorations dans le prompt vLLM d extraction v2?","answer":"Format JSON strict demandé. Champs explicites: lesson_type, lesson_text, importance, confidence_score. Exemples inline de bonne et mauvaise extraction. Seuil confiance minimum 0.7 pour réduire bruit.","category":"pipeline","tags":["vllm","prompt","ingestion","extraction"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Prompt extraction vLLM v2: JSON strict, exemples inline, seuil confiance 0.7."
    ).with_inputs("text", "source"),

    # [TEST-08] Mix: wish + technique + QA contextuel
    dspy.Example(
        text="Yann: J'aimerais que quand je parle à BRUCE depuis mon téléphone, il comprenne le contexte de ce que je fais. Genre si je suis dans le garage et je dis hey BRUCE le serveur fait un bruit bizarre, il devrait savoir quel serveur est dans le garage et me guider. ChatGPT: Pour ça il faudrait un inventaire physique lié aux emplacements. Un champ location dans bruce_tools avec les valeurs bureau, garage, rack1, rack2.",
        source="ChatGPT BRUCE domotique",
        lessons_json='[]',
        knowledge_base_json='[{"question":"Comment BRUCE pourrait comprendre le contexte physique de l utilisateur?","answer":"Ajouter un champ location dans bruce_tools avec les emplacements physiques (bureau, garage, rack1, rack2). Quand Yann mentionne un lieu, BRUCE filtre les équipements par location pour comprendre le contexte.","category":"architecture","tags":["location","contexte","bruce_tools","garage"]}]',
        decisions_json='[]',
        wishes_json='[{"wish_text":"Yann souhaite que BRUCE comprenne le contexte physique quand il parle depuis un lieu et identifie automatiquement les équipements concernés","importance":"normal"}]',
        user_profile_json='[{"trait":"usage_contextuel_physique","value":"Yann veut interagir avec BRUCE depuis son téléphone en contexte physique (garage, bureau). BRUCE doit identifier les équipements du lieu.","category":"usage"}]',
        conversation_qa_json='[{"question":"Comment BRUCE peut comprendre de quel serveur on parle selon le lieu?","answer":"Inventaire physique avec champ location dans bruce_tools. Quand Yann dit garage, filtrer par location=garage pour identifier les équipements concernés.","category":"conversation-qa","tags":["location","contexte","garage"]}]',
        summary="BRUCE contextuel par lieu: champ location dans bruce_tools filtré selon lieu mentionné."
    ).with_inputs("text", "source"),

    # [TEST-09] API n8n header X-N8N-API-KEY
    dspy.Example(
        text="Pour accéder à l'API n8n depuis PowerShell, il faut utiliser le header X-N8N-API-KEY et non pas un bearer token classique. L'API key se trouve dans les settings n8n. Exemple: Invoke-RestMethod avec header X-N8N-API-KEY. Le endpoint de base est http://192.168.2.174:5678/api/v1. On peut lister les workflows, les exécutions, les credentials.",
        source="Session Sonnet 81",
        lessons_json='[{"lesson_type":"solution","lesson_text":"API n8n via PowerShell: header X-N8N-API-KEY (pas bearer token). API key dans settings n8n. Endpoint: http://192.168.2.174:5678/api/v1. Lister workflows, exécutions, credentials.","importance":"normal","confidence_score":0.95}]',
        knowledge_base_json='[{"question":"Comment accéder à l API n8n depuis PowerShell?","answer":"Utiliser header X-N8N-API-KEY (pas bearer token). API key dans settings n8n. Endpoint base: http://192.168.2.174:5678/api/v1. Endpoints: /workflows, /executions, /credentials.","category":"tools","tags":["n8n","api","powershell","credential"]}]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="API n8n: header X-N8N-API-KEY, endpoint .174:5678/api/v1. Pas de bearer token."
    ).with_inputs("text", "source"),

    # [TEST-10] Règle priorisation par levier
    dspy.Example(
        text="Yann a décidé en session 1084 que la roadmap BRUCE doit être priorisée par effet de levier, pas par sévérité classique. L'effet de levier c'est l'impact multiplicateur sur le reste du système. Une tâche qui débloque 5 autres tâches est prioritaire sur une tâche critique isolée. Attaquer ce qui débloque le plus de valeur en aval.",
        source="Session Opus 1084 - règle priorisation",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE PRIORISATION BRUCE: par EFFET DE LEVIER (impact multiplicateur sur le reste), pas par sévérité classique. Une tâche qui débloque 5 autres > une tâche critique isolée. Attaquer ce qui débloque le plus de valeur en aval.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[]',
        decisions_json='[{"decision_text":"Roadmap BRUCE priorisée par effet de levier, pas par sévérité classique","rationale":"Une tâche qui débloque 5 autres a plus d impact qu une tâche critique isolée. Maximiser la valeur débloquée en aval.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[{"trait":"philosophie_priorisation","value":"Yann priorise par levier (impact multiplicateur). Pas par sévérité. Ce qui débloque le plus en aval passe en premier.","category":"value"}]',
        conversation_qa_json='[]',
        summary="Règle Yann: roadmap par effet de levier (impact multiplicateur), pas sévérité classique."
    ).with_inputs("text", "source"),

    # [TEST-11] Bruit — validation courte
    dspy.Example(
        text="Yann: C'est bon. Parfait. Go.",
        source="Session BRUCE validation",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Validation courte sans contenu extractible."
    ).with_inputs("text", "source"),

    # [TEST-12] Mix: architecture + lesson + decision  
    dspy.Example(
        text="LightRAG est déployé sur .230 port 9621 avec une stack 3 containers: pgvector:pg17 sur port 5434, embed-adapter FastAPI sur port 8082, et le serveur LightRAG depuis ghcr.io. Les 3 conteneurs sont dans le réseau lightrag-net. 30 entités extraites lors du test initial. Requêtes hybrides (mode hybrid) opérationnelles. Important: OPENAI_LLM_MAX_TOKENS doit être <= 2000 avec Qwen 7B (context window 8192 avec ~5000 tokens prompt).",
        source="Session Opus 1090 - LightRAG déploiement [440]",
        lessons_json='[{"lesson_type":"solution","lesson_text":"LightRAG déployé .230:9621. Stack: pgvector:pg17:5434, embed-adapter FastAPI:8082, lightrag ghcr.io. Réseau lightrag-net. 30 entités. CRITICAL: OPENAI_LLM_MAX_TOKENS <= 2000 avec Qwen 7B (prompt ~5000 tokens sur ctx 8192).","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment est déployé LightRAG dans BRUCE?","answer":"Stack 3 containers sur .230: pgvector:pg17 (port 5434), embed-adapter FastAPI (port 8082), LightRAG server (port 9621). Réseau lightrag-net. Config: OPENAI_LLM_MAX_TOKENS=2000 max avec Qwen 7B (context window 8192).","category":"infrastructure","tags":["lightrag","pgvector","deploy","graphrag"]}]',
        decisions_json='[{"decision_text":"OPENAI_LLM_MAX_TOKENS limitée à 2000 pour LightRAG avec Qwen 7B","rationale":"Context window 8192 avec ~5000 tokens prompt. Dépasser 2000 cause ContextWindowExceededError.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="LightRAG déployé .230:9621 (3 containers). MAX_TOKENS <= 2000 avec Qwen 7B sur ctx 8192."
    ).with_inputs("text", "source"),

    # [TEST-13] user_profile complet — profil étendu
    dspy.Example(
        text="Yann préfère Claude Opus pour tout le travail architectural et les décisions importantes. Il déteste Claude Code et l'utilise uniquement pour les déploiements SSH lourds. Son mode de travail est souvent vocal (depuis son véhicule). Il pense en systèmes et en vision globale, pas en détails d'implémentation. Il s'intéresse au résultat final, pas au processus. Signal d'approbation = 'go'.",
        source="Session documentation profil Yann",
        lessons_json='[]',
        knowledge_base_json='[]',
        decisions_json='[]',
        wishes_json='[]',
        user_profile_json='[{"trait":"preference_modele","value":"Préfère Opus pour tout travail architectural et décisions. Déteste Claude Code, l utilise uniquement pour SSH lourds.","category":"preference"},{"trait":"mode_vocal","value":"Utilise souvent BRUCE vocalement depuis son véhicule. Signal approbation = go.","category":"usage"},{"trait":"pensee_systemes","value":"Pense en systèmes et vision globale. S intéresse au résultat, pas au processus ou détails implémentation.","category":"behavior"}]',
        conversation_qa_json='[]',
        summary="Profil Yann: Opus préféré, déteste Code, mode vocal véhicule, pense en systèmes, signal go = approbation."
    ).with_inputs("text", "source"),

    # [TEST-14] SQL ConvertTo-Json règle obligatoire
    dspy.Example(
        text="Règle SQL permanente BRUCE: pour toute requête SQL vers Supabase, utiliser EXCLUSIVEMENT le gateway /tools/supabase/exec-sql avec ConvertTo-Json. Pattern correct: $body = @{ sql = 'SELECT * FROM table WHERE col = value' } | ConvertTo-Json -Compress. Ne jamais construire le JSON manuellement avec des quotes imbriquées. ConvertTo-Json gère automatiquement l'échappement des quotes simples SQL. Évite 100% des erreurs d'échappement.",
        source="Session Opus 2026-03-08 - règle SQL",
        lessons_json='[{"lesson_type":"rule_canon","lesson_text":"RÈGLE SQL PERMANENTE: toujours $body = @{ sql = SQL_ICI } | ConvertTo-Json -Compress pour les requêtes Supabase gateway. JAMAIS JSON manuel avec quotes imbriquées. ConvertTo-Json gère l échappement automatiquement. 100% fiable.","importance":"critical","confidence_score":1.0}]',
        knowledge_base_json='[{"question":"Comment construire le body JSON pour une requête SQL vers le gateway BRUCE?","answer":"$body = @{ sql = SELECT ... WHERE col = valeur } | ConvertTo-Json -Compress. JAMAIS de JSON manuel avec guillemets imbriqués. Le -Compress de ConvertTo-Json échappe automatiquement les quotes simples SQL. Puis: Invoke-RestMethod gateway /tools/supabase/exec-sql -Body $body.","category":"database","tags":["sql","convertto-json","gateway","supabase","powershell"]}]',
        decisions_json='[{"decision_text":"SQL vers Supabase uniquement via ConvertTo-Json, jamais JSON manuel","rationale":"ConvertTo-Json gère l échappement automatiquement. JSON manuel avec quotes imbriquées = erreurs garanties.","importance":"critical"}]',
        wishes_json='[]',
        user_profile_json='[]',
        conversation_qa_json='[]',
        summary="Règle SQL BRUCE: toujours ConvertTo-Json pour les requêtes. Jamais JSON manuel avec quotes imbriquées."
    ).with_inputs("text", "source"),

]

# ============================================================
# SPLITS (sans contamination)
# ============================================================
TRAIN_SET = GOLD_EXAMPLES[0:45]   # indices 0-44
DEV_SET   = GOLD_EXAMPLES[45:60]  # indices 45-59
TEST_SET  = GOLD_EXAMPLES[60:75]  # indices 60-74

# Vérification

# ─── Splits propres (zéro contamination) ─────────────────────────────────────
TRAIN_SET = GOLD_EXAMPLES[0:45]   # 45 exemples
DEV_SET   = GOLD_EXAMPLES[45:60]  # 15 exemples (validation pendant MIPRO)
TEST_SET  = GOLD_EXAMPLES[60:75]  # 15 exemples (évaluation finale, jamais vus)

assert len(TRAIN_SET) == 45
assert len(DEV_SET)   == 15
assert len(TEST_SET)  == 15
# Vérification zéro overlap
_train_t = {ex.text[:50] for ex in TRAIN_SET}
_dev_t   = {ex.text[:50] for ex in DEV_SET}
_test_t  = {ex.text[:50] for ex in TEST_SET}
assert not (_train_t & _test_t), "CONTAMINATION TRAIN/TEST"
assert not (_train_t & _dev_t),  "CONTAMINATION TRAIN/DEV"
assert not (_dev_t & _test_t),   "CONTAMINATION DEV/TEST"
log.info(f"✅ Splits validés: TRAIN={len(TRAIN_SET)} DEV={len(DEV_SET)} TEST={len(TEST_SET)}")

# ─── Main ─────────────────────────────────────────────────────────────────────
def check_llm_slot():
    """Vérifie que le slot llama-server est libre avant de démarrer."""
    import urllib.request, urllib.error
    try:
        req = urllib.request.Request(
            f"{LLM_BASE_URL.replace('/v1','')}/slots",
            headers={"Authorization": f"Bearer {LLM_API_KEY}"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            slots = json.loads(resp.read())
            busy = [s for s in slots if s.get("is_processing")]
            if busy:
                log.warning(f"⚠️  Slot llama-server occupé: {busy[0].get('id')} task={busy[0].get('id_task')}")
                log.warning("Vérifier avec: curl http://192.168.2.32:8000/slots")
                log.warning("Fix si bloqué: docker restart llama-server sur .32")
                return False
            log.info(f"✅ Slot llama-server libre ({len(slots)} slot(s))")
            return True
    except Exception as e:
        log.warning(f"Impossible de vérifier les slots: {e}. On continue quand même.")
        return True


def warm_up_llm():
    """Warm-up HTTP: un appel simple pour vérifier que le LLM répond."""
    import urllib.request
    log.info("Warm-up LLM...")
    payload = json.dumps({
        "model": MODEL_NAME.replace("openai/",""),
        "messages": [{"role":"user","content":"/no_think Dis juste: OK"}],
        "max_tokens": 10
    }).encode()
    req = urllib.request.Request(
        f"{LLM_BASE_URL}/chat/completions",
        data=payload,
        headers={"Authorization":f"Bearer {LLM_API_KEY}","Content-Type":"application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            log.info(f"✅ LLM warm-up OK: {data['choices'][0]['message']['content'][:50]}")
            return True
    except Exception as e:
        log.error(f"❌ LLM warm-up échoué: {e}")
        return False


def save_optimized_program(program, score, phase):
    """Sauvegarde le programme optimisé en JSON."""
    path = f"{RESULTS_DIR}/program_{phase}_score{score:.3f}.json"
    try:
        program.save(path)
        log.info(f"Programme sauvegardé: {path}")
    except Exception as e:
        log.warning(f"Impossible de sauvegarder le programme: {e}")


def main():
    # ─── Lockfile ───────────────────────────────────────────────────────────
    lock_fh = acquire_lock()
    log.info("=" * 70)
    log.info("BRUCE DSPy Optimizer v2.9 — Démarrage")
    log.info(f"PID: {os.getpid()}")
    log.info(f"LLM: {LLM_BASE_URL} model={MODEL_NAME}")
    log.info(f"TRAIN={len(TRAIN_SET)} DEV={len(DEV_SET)} TEST={len(TEST_SET)}")
    log.info("=" * 70)

    save_progress("startup", 0, 0)

    # ─── Vérification slot ──────────────────────────────────────────────────
    if not check_llm_slot():
        log.error("Slot llama-server occupé. Lancer 'docker restart llama-server' sur .32 puis relancer.")
        sys.exit(1)

    # ─── Warm-up ────────────────────────────────────────────────────────────
    if not warm_up_llm():
        log.error("LLM non accessible. Vérifier llama-server sur .32:8000.")
        sys.exit(1)

    # ─── Configure DSPy ─────────────────────────────────────────────────────
    log.info(f"Configuration DSPy: model={MODEL_NAME} timeout={TIMEOUT_SEC}s max_tokens={MAX_TOKENS}")
    lm = dspy.LM(
        model=MODEL_NAME,
        api_base=LLM_BASE_URL,
        api_key=LLM_API_KEY,
        max_tokens=MAX_TOKENS,
        timeout=TIMEOUT_SEC,
    )
    dspy.configure(lm=lm)

    # ─── Phase 1: BASELINE sur DEV ──────────────────────────────────────────
    log.info("")
    log.info("─" * 70)
    log.info("PHASE 1: BASELINE (non-optimisé) sur DEV set")
    log.info(f"  {len(DEV_SET)} exemples × ~300s/ex ≈ {len(DEV_SET)*300//60} minutes estimées")
    log.info("─" * 70)

    baseline_module = BruceExtractorV29()
    save_progress("baseline", 0, len(DEV_SET))

    t_baseline_start = time.time()
    baseline_score, baseline_scores = manual_evaluate(
        baseline_module, DEV_SET, extraction_quality_metric, label="BASELINE"
    )
    t_baseline = time.time() - t_baseline_start

    log.info(f"✅ BASELINE terminé: score={baseline_score:.3f} en {t_baseline/60:.1f}min")
    save_progress("baseline_done", len(DEV_SET), len(DEV_SET), score=baseline_score,
                  extra={"time_min": round(t_baseline/60, 1), "scores": baseline_scores})

    with open(f"{RESULTS_DIR}/baseline_results.json", "w") as f:
        json.dump({
            "phase": "baseline",
            "score": baseline_score,
            "scores": baseline_scores,
            "time_min": round(t_baseline/60, 1),
            "n_examples": len(DEV_SET)
        }, f, indent=2)

    # ─── Phase 2: MIPROv2 sur TRAIN ─────────────────────────────────────────
    log.info("")
    log.info("─" * 70)
    log.info("PHASE 2: MIPROv2 heavy optimization sur TRAIN set")
    log.info(f"  {len(TRAIN_SET)} exemples train / {len(DEV_SET)} exemples val")
    log.info("  Durée estimée: 4-8 heures")
    log.info("─" * 70)
    save_progress("mipro_start", 0, len(TRAIN_SET))

    optimizer = dspy.MIPROv2(
        metric=extraction_quality_metric,
        auto="heavy",
        verbose=True,
        num_threads=1,       # Single thread — slot unique llama-server
    )

    t_mipro_start = time.time()
    try:
        optimized_program = optimizer.compile(
            BruceExtractorV29(),
            trainset=TRAIN_SET,
            valset=DEV_SET,
            # num_trials=40,  # REMOVED: conflicts with auto=heavy (DSPy 3.x)
            minibatch=False,
            requires_permission_to_run=False,
        )
        t_mipro = time.time() - t_mipro_start
        log.info(f"✅ MIPROv2 terminé en {t_mipro/3600:.1f}h")
        save_progress("mipro_done", len(TRAIN_SET), len(TRAIN_SET),
                      extra={"time_h": round(t_mipro/3600, 2)})
    except Exception as e:
        log.error(f"❌ MIPROv2 échoué: {e}")
        log.info("Sauvegarde du programme baseline comme fallback...")
        optimized_program = baseline_module
        save_progress("mipro_failed", 0, 0, extra={"error": str(e)})

    # ─── Phase 3: Évaluation post-MIPROv2 sur DEV ───────────────────────────
    log.info("")
    log.info("─" * 70)
    log.info("PHASE 3: Évaluation post-MIPROv2 sur DEV set")
    log.info("─" * 70)
    save_progress("eval_dev", 0, len(DEV_SET))

    optimized_score_dev, optimized_scores_dev = manual_evaluate(
        optimized_program, DEV_SET, extraction_quality_metric, label="POST-MIPRO-DEV"
    )
    log.info(f"✅ Post-MIPROv2 DEV: {baseline_score:.3f} → {optimized_score_dev:.3f} "
             f"(Δ={optimized_score_dev - baseline_score:+.3f})")

    # ─── Phase 4: Évaluation finale sur TEST (jamais vu) ────────────────────
    log.info("")
    log.info("─" * 70)
    log.info("PHASE 4: Évaluation finale sur TEST set (jamais vu pendant optimization)")
    log.info("─" * 70)
    save_progress("eval_test", 0, len(TEST_SET))

    final_score_test, final_scores_test = manual_evaluate(
        optimized_program, TEST_SET, extraction_quality_metric, label="FINAL-TEST"
    )
    log.info(f"✅ Score final TEST: {final_score_test:.3f}")

    # ─── Résumé ─────────────────────────────────────────────────────────────
    log.info("")
    log.info("=" * 70)
    log.info("RÉSULTATS FINAUX DSPy v2.9")
    log.info("=" * 70)
    log.info(f"  Baseline DEV:     {baseline_score:.3f}")
    log.info(f"  Post-MIPROv2 DEV: {optimized_score_dev:.3f}  (Δ={optimized_score_dev-baseline_score:+.3f})")
    log.info(f"  Final TEST:       {final_score_test:.3f}  (référence honnête, jamais vu)")
    log.info("")

    # Sauvegarder résultats
    results = {
        "version": "v2.9",
        "baseline_dev": baseline_score,
        "optimized_dev": optimized_score_dev,
        "delta_dev": round(optimized_score_dev - baseline_score, 3),
        "final_test": final_score_test,
        "n_train": len(TRAIN_SET),
        "n_dev": len(DEV_SET),
        "n_test": len(TEST_SET),
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    with open(f"{RESULTS_DIR}/final_results_v29.json", "w") as f:
        json.dump(results, f, indent=2)

    save_progress("done", 0, 0, score=final_score_test, extra=results)
    log.info(f"Résultats sauvegardés dans {RESULTS_DIR}/final_results_v29.json")
    log.info("=" * 70)

    # Sauvegarder le programme optimisé
    save_optimized_program(optimized_program, final_score_test, "final")

    # Nettoyer lockfile
    lock_fh.close()
    if os.path.exists(LOCK_FILE):
        os.unlink(LOCK_FILE)

    log.info("✅ DSPy v2.9 terminé avec succès.")
    return results


if __name__ == "__main__":
    main()
