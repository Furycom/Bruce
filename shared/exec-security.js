'use strict';
const { SUPABASE_URL, SUPABASE_KEY } = require('./config');

// ── Whitelist: patterns autorisés (regex) ──
const WHITELIST = [
  /^docker\s+(ps|logs|inspect|stats|images|top|port|diff)\b/,
  /^docker\s+compose\s+(ps|logs|config)\b/,
  /^docker\s+run\s/,
  /^docker\s+pull\s/,
  /^docker\s+compose\s+(up|down|restart|pull)\b/,
  /^docker\s+(stop|start|restart)\s/,
  /^docker\s+kill\s+-s\s+SIG(HUP|TERM|USR1)\s/,
  /^docker\s+update\s/,
  /^docker\s+rm\s/,
  /^(cat|head|tail|wc|ls|find|stat|du|file)\b/,
  /^(df|free|uptime|hostname|whoami|uname|lsb_release|id|date)\b/,
  /^(pgrep|pidof)\b/,
  /^ps\s+(aux|ef|--no-headers)\b/,
  /^top\s+-bn1\b/,
  /^kill\s/,
  /^pkill\s/,
  /^systemctl\s+(status|is-active|is-enabled|list-units|show|stop|start|restart|disable|enable)\b/,
  /^systemctl\s+--user\s+(status|stop|start|restart|disable|enable)\b/,
  /^journalctl\s/,
  /^(ip\s+(a|addr|r|route|link)|ss\s|netstat\s)/,
  /^curl\s+-s\b/,
  /^\/home\/furycom\/scripts\//,
  /^\.\/bruce_/,
  /^(grep|egrep|awk)\b/,
  /^sed\s+(-n\s+)?['"]?[0-9]/,
  /^tee\s/,
  /^cp\s/,
  /^mkdir\s/,
  /^pct\s+(set|status|list|config)\b/,
  /^qm\s+(set|status|list|config|start|stop)\b/,
  /^python3\s/,
  /^pip\s/,
  /^\/home\/furycom\/venv-ingestion\/bin\/(python3|pip)\s/,
  /^sudo\s+apt\s+(install|update|list)\b/,
  /^pvesm\s/,
  /^vzdump\s/,
  /^qm\s+(snapshot|rollback|delsnapshot)\b/,
  /^lsblk\b/,
  /^mount\s+-t\s+(nfs|cifs|ext4|xfs)\b/,
  /^umount\s/,
  /^screen\s/,
  /^crontab\s+-l\b/,
  /^mv\s/,
  /^chmod\s+[0-7]{3}\b/,
  /^docker\s+cp\s/,
  /^docker\s+exec\s/,
];

// ── Blacklist: patterns interdits avec messages ACTIONNABLES ──
const BLACKLIST = [
  { pat: /rm\s+(-rf?|--force)\b/, msg: 'Suppression récursive interdite — opération irréversible.' },
  { pat: /mkfs\b/, msg: 'Formatage de disque interdit.' },
  { pat: /dd\s+if=/, msg: 'Copie bas-niveau disque interdite.' },
  { pat: />\\s*\/dev\/sd/, msg: 'Écriture sur périphérique bloc interdite.' },
  { pat: /chmod\s+777\b/, msg: 'chmod 777 interdit. Utiliser chmod 755 ou 644.' },
  { pat: /^(shutdown|reboot|poweroff)\b/, msg: 'Arrêt/redémarrage système interdit depuis la gateway.' },
  { pat: /init\s+[06]/, msg: 'Changement de runlevel interdit.' },
  { pat: /\|.*\|/, msg: 'Double pipe interdit. Décomposer en commandes séparées.' },
  { pat: /;\s*rm\b/, msg: 'Commande enchaînée avec rm interdite.' },
  { pat: /`/, msg: 'Backtick (substitution de commande) interdit. Utiliser une variable ou un fichier intermédiaire.' },
  { pat: /\$\(/, msg: 'Substitution $() interdite. SOLUTION: lire la valeur dans un fichier (cat /path/to/file) ou écrire un script via bruce_file_write et l exécuter directement.' },
  { pat: /\\\"/, msg: 'JSON inline avec guillemets échappés interdit (\\"). SOLUTION CANON: (1) Écrire le JSON dans un fichier via bruce_file_write vers /home/furycom/uploads/payload.json, (2) puis curl -s -X PATCH URL -d @/home/furycom/uploads/payload.json. Ne jamais imbriquer du JSON en inline.' },
  { pat: /sed\s+-i\b/, msg: 'sed -i (édition en place) interdit. Lire le fichier, modifier le contenu, et réécrire via bruce_file_write.' },
  { pat: />[\s]/, msg: 'Redirection de sortie (>) interdite. Utiliser bruce_file_write pour écrire des fichiers.' },
  { pat: />>/, msg: 'Redirection append (>>) interdite. Utiliser bruce_file_write en mode append.' },
  { pat: /docker\s+run\s+.*--privileged\b/, msg: 'docker run --privileged interdit.' },
  { pat: /docker\s+(rmi|system\s+prune|volume\s+rm)\b/, msg: 'Suppression images/volumes Docker interdite.' },
  { pat: /kill\s+-9\b/, msg: 'kill -9 interdit. Utiliser kill -TERM (signal 15) ou pkill -TERM.' },
  // [C4] python3 -c inline detruit par PowerShell (guillemets manges)
  { pat: /python3\s+-c\s/, msg: '[C4] python3 -c inline interdit. PowerShell detruit les guillemets et caracteres speciaux. SOLUTION: ecrire le script via bruce_file_write vers /home/furycom/uploads/script.py puis executer python3 /home/furycom/uploads/script.py.' },
];

// ── Warnlist: commandes autorisées mais avec avertissement contextuel ──
const WARNLIST = [
  // [1232] Patch .py — vérifier registre canonique avant toute modification
  {
    pat: /(?:cp|mv|chmod|chown)\s+.*\.py\b/i,
    warning: '[1232] ATTENTION: modification de script .py détectée. RÈGLE CANON: (1) Vérifier le script actif: GET /bruce/scripts/active. (2) Après le patch: mettre à jour le registre: ssh furymcp python3 /home/furycom/uploads/init_registry_1232.py. (3) Bumper la VERSION dans le fichier patché. Scripts canoniques: screensaver=/home/furycom/bruce_screensaver.py, ingest=/home/furycom/bruce_ingest.py.',
  },
  {
    pat: /^docker\s+(compose\s+restart|restart\s)/,
    warning: '[A1] ATTENTION: "docker compose restart" ne relit PAS le fichier .env — la config reste celle du démarrage précédent. Si vous venez de modifier un .env: utilisez "docker compose down && docker compose up -d --force-recreate" à la place. Le restart simple est correct uniquement pour recharger du code (routes JS, scripts) sans changement de variables d environnement.',
  },
  // [A4] grep/find exploratoire sans consulter KB
  {
    pat: /^(grep|find)\s+.*(\/app|\/home|\/etc|\/var)\b/,
    warning: '[A4] ATTENTION: commande exploratoire detectee. REGLE CANON: consulter la KB (homelab-semantic-search-advanced ou kb_search) AVANT toute exploration. L information existe peut-etre deja.',
  },
  // [B4] SSH vers .32 sans jump
  {
    pat: /ssh\s+.*192\.168\.2\.32\b/,
    warning: '[B4] ATTENTION: SSH vers .32 (furycomai) necessite la cle homelab_key et le jump via .230. Depuis Claude Desktop: utiliser l alias furycomai. Via ssh_exec gateway: host=192.168.2.32 utilise la cle du container automatiquement.',
  },
  // [C2] urllib avec filtres PostgREST dans le container
  {
    pat: /urllib.*(?:supabase|postgrest|8000)/i,
    warning: '[C2] ATTENTION: urllib ne supporte pas les filtres PostgREST complexes dans le container gateway (erreur 400). SOLUTION CANON: ecrire un script Python avec requests sur le HOST .230 via SSH, ou utiliser curl -s directement.',
  },
  // [C3] requests absent du container gateway
  {
    pat: /(?:import\s+requests|from\s+requests\s+import)/,
    warning: '[C3] ATTENTION: le module requests N EST PAS installe dans le container gateway. Scripts Python Supabase = TOUJOURS sur le host .230 via SSH (requests y est installe). Dans le container: utiliser urllib ou curl -s.',
  },
];

function validateExecCommand(cmd) {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return { allowed: false, reason: 'Empty command' };

  if (/&&/.test(trimmed)) {
    const parts = trimmed.split(/\s*&&\s*/);
    for (const part of parts) {
      const result = validateExecCommand(part.trim());
      if (!result.allowed) {
        return { allowed: false, reason: `Chained command blocked: "${part.trim()}" — ${result.reason}` };
      }
    }
    return { allowed: true };
  }

  for (const entry of BLACKLIST) {
    if (entry.pat.test(trimmed)) {
      return { allowed: false, reason: entry.msg };
    }
  }

  // Vérifier warnlist avant whitelist pour enrichir la réponse
  let contextWarning = null;
  for (const entry of WARNLIST) {
    if (entry.pat.test(trimmed)) {
      contextWarning = entry.warning;
      break;
    }
  }

  for (const pat of WHITELIST) {
    if (pat.test(trimmed)) {
      return contextWarning ? { allowed: true, warning: contextWarning } : { allowed: true };
    }
  }

  const firstWord = trimmed.split(/\s+/)[0];
  return {
    allowed: false,
    reason: `Commande "${firstWord}" non autorisée. ALTERNATIVES: (1) Écrire un script .js via bruce_file_write puis node /home/furycom/uploads/script.js, (2) Écrire un script .py puis python3 /home/furycom/uploads/script.py, (3) Vérifier KB#1224 pour les patterns SSH canon.`,
  };
}

function auditLog(endpoint, caller, host, cmd, result, durationMs) {
  return;
}

module.exports = { validateExecCommand, auditLog, WHITELIST, BLACKLIST, WARNLIST };
