'use strict';
const { SUPABASE_URL, SUPABASE_KEY } = require('./config');

// ── Whitelist: patterns autorisés (regex) ──
const WHITELIST = [
  // Docker (read-only)
  /^docker\s+(ps|logs|inspect|stats|images|top|port|diff)\b/,
  /^docker\s+compose\s+(ps|logs|config)\b/,
  // [1237] Docker (write-controlled)
  /^docker\s+run\s/,
  /^docker\s+pull\s/,
  /^docker\s+compose\s+(up|down|restart|pull)\b/,
  /^docker\s+(stop|start|restart)\s/,
  /^docker\s+kill\s+-s\s+SIG(HUP|TERM|USR1)\s/,
  // [1237] Docker update (resource limits)
  /^docker\s+update\s/,
  // [1242] Docker rm (cleanup orphelins)
  /^docker\s+rm\s/,
  // Filesystem read
  /^(cat|head|tail|wc|ls|find|stat|du|file)\b/,
  // System info
  /^(df|free|uptime|hostname|whoami|uname|lsb_release|id|date)\b/,
  // Process inspection
  /^(pgrep|pidof)\b/,
  /^ps\s+(aux|ef|--no-headers)\b/,
  /^top\s+-bn1\b/,
  // [1242] Process control (kill screensaver, pkill)
  /^kill\s/,
  /^pkill\s/,
  // Service management (read + stop/start for screensaver control)
  /^systemctl\s+(status|is-active|is-enabled|list-units|show|stop|start|restart|disable|enable)\b/,
  /^systemctl\s+--user\s+(status|stop|start|restart|disable|enable)\b/,
  /^journalctl\s/,
  // Network read
  /^(ip\s+(a|addr|r|route|link)|ss\s|netstat\s)/,
  // Curl (safe fetches)
  /^curl\s+-s\b/,
  // User scripts
  /^\/home\/furycom\/scripts\//,
  /^\.\/bruce_/,
  // Grep/awk/sed read-only
  /^(grep|egrep|awk)\b/,
  /^sed\s+(-n\s+)?['"]?[0-9]/,
  // [1237] tee, cp, mkdir
  /^tee\s/,
  /^cp\s/,
  /^mkdir\s/,
  // [1237] Proxmox VM management
  /^pct\s+(set|status|list|config)\b/,
  /^qm\s+(set|status|list|config|start|stop)\b/,
  // [1115] Python/pip for DSPy ingestion
  /^python3\s/,
  /^pip\s/,
  /^\/home\/furycom\/venv-ingestion\/bin\/(python3|pip)\s/,
  // [1115] sudo apt install (package management)
  /^sudo\s+apt\s+(install|update|list)\b/,
];

// ── Blacklist: patterns interdits (regex) ──
const BLACKLIST = [
  /rm\s+(-rf?|--force)\b/,
  /mkfs\b/,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /chmod\s+777\b/,
  /^(shutdown|reboot|poweroff)\b/,
  /init\s+[06]/,
  /\|.*\|/,
  /;\s*rm\b/,
  /`/,
  /\$\(/,
  /\\"/,
  /sed\s+-i\b/,
  />\s/,
  />>/,
  /docker\s+run\s+.*--privileged\b/,
  /docker\s+(rmi|system\s+prune|volume\s+rm)\b/,
  // [1242] Block kill -9 (too aggressive) but allow kill -TERM and kill PID
  /kill\s+-9\b/,
];

function validateExecCommand(cmd) {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return { allowed: false, reason: 'Empty command' };

  if (/&&/.test(trimmed)) {
    const parts = trimmed.split(/\s*&&\s*/);
    for (const part of parts) {
      const result = validateExecCommand(part.trim());
      if (!result.allowed) {
        return { allowed: false, reason: `Chained command blocked: "${part.trim()}" - ${result.reason}` };
      }
    }
    return { allowed: true };
  }

  for (const pat of BLACKLIST) {
    if (pat.test(trimmed)) {
      return { allowed: false, reason: `Blocked by blacklist: ${pat}` };
    }
  }

  for (const pat of WHITELIST) {
    if (pat.test(trimmed)) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: 'Command not in whitelist' };
}

function auditLog(endpoint, caller, host, cmd, result, durationMs) {
  return;
}

module.exports = { validateExecCommand, auditLog, WHITELIST, BLACKLIST };
