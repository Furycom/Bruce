'use strict';
const { SUPABASE_URL, SUPABASE_KEY } = require('./config');

// ── Whitelist: patterns autorisés (regex) ──
const WHITELIST = [
  // Docker (read-only)
  /^docker\s+(ps|logs|inspect|stats|images|top|port|diff)\b/,
  /^docker\s+compose\s+(ps|logs|config)\b/,
  // [1237] Docker (write-controlled) — needed for node_exporter deployment etc.
  /^docker\s+run\s/,
  /^docker\s+pull\s/,
  /^docker\s+compose\s+(up|down|restart|pull)\b/,
  /^docker\s+(stop|start|restart)\s/,
  /^docker\s+kill\s+-s\s+SIG(HUP|TERM|USR1)\s/,
  // [1237] Docker update (resource limits)
  /^docker\s+update\s/,
  // Filesystem read (cat, head, tail, wc, ls, find, stat, du, file)
  /^(cat|head|tail|wc|ls|find|stat|du|file)\b/,
  // System info (df, free, uptime, hostname, whoami, uname, lsb_release, id, date)
  /^(df|free|uptime|hostname|whoami|uname|lsb_release|id|date)\b/,
  // Process inspection (pgrep, ps, top -bn1, pidof)
  /^(pgrep|pidof)\b/,
  /^ps\s+(aux|ef|--no-headers)\b/,
  /^top\s+-bn1\b/,
  // Service status (read-only systemctl)
  /^systemctl\s+(status|is-active|is-enabled|list-units|show)\b/,
  /^journalctl\s/,
  // Network read (ip, ss, netstat)
  /^(ip\s+(a|addr|r|route|link)|ss\s|netstat\s)/,
  // Curl (safe fetches)
  /^curl\s+-s\b/,
  // User scripts
  /^\/home\/furycom\/scripts\//,
  /^\.\/bruce_/,
  // Grep/awk/sed read-only (no -i for sed)
  /^(grep|egrep|awk)\b/,
  /^sed\s+(-n\s+)?['"]?[0-9]/,  // sed with line numbers only, not sed -i
  // [1237] tee for writing config files via SSH (needed for prometheus.yml etc.)
  /^tee\s/,
  // [1237] cp for file operations
  /^cp\s/,
  // [1237] mkdir for directory creation
  /^mkdir\s/,
  // [1237] Proxmox VM management (RAM redistribution)
  /^pct\s+(set|status|list|config)\b/,
  /^qm\s+(set|status|list|config|start|stop)\b/,
];

// ── Blacklist: patterns interdits (regex) ──
const BLACKLIST = [
  /rm\s+(-rf?|--force)\b/,
  /mkfs\b/,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /chmod\s+777\b/,
  // [1237] Only block bare system-level shutdown/reboot, not qm subcommands
  /^(shutdown|reboot|poweroff)\b/,
  /init\s+[06]/,
  // [995] && autorise si chaque partie passe la whitelist individuellement
  /\|.*\|/,                        // double pipe interdit (single pipe OK)
  /;\s*rm\b/,                      // injection via ;
  /`/,                             // backtick injection
  /\$\(/,                          // command substitution
  /\\"/,                           // guillemets imbriqués
  /sed\s+-i\b/,                    // in-place edit forbidden
  />\s/,                           // output redirect forbidden
  />>/,                            // append redirect forbidden
  // [1237] Docker security: block dangerous docker commands
  /docker\s+run\s+.*--privileged\b/,     // no privileged containers
  /docker\s+(rmi|system\s+prune|volume\s+rm)\b/, // no destructive docker ops
];

/**
 * Validates whether an exec command is allowed using blacklist and whitelist rules.
 * @param {string} cmd - Raw shell command to validate.
 * @returns {{ allowed: boolean, reason?: string }} Validation result with an optional deny reason.
 */
function validateExecCommand(cmd) {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return { allowed: false, reason: 'Empty command' };

  // [995] Handle && chaining: split and validate each part independently
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

  // Check blacklist first (higher priority)
  for (const pat of BLACKLIST) {
    if (pat.test(trimmed)) {
      return { allowed: false, reason: `Blocked by blacklist: ${pat}` };
    }
  }

  // Check whitelist
  for (const pat of WHITELIST) {
    if (pat.test(trimmed)) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: 'Command not in whitelist' };
}

/**
 * Writes an exec audit entry to Supabase in fire-and-forget mode.
 */
function auditLog(endpoint, caller, host, cmd, result, durationMs) {
  // DISABLED: table bruce_audit_log inexistante/vidée, voir [840].
  return;
}

module.exports = { validateExecCommand, auditLog, WHITELIST, BLACKLIST };
