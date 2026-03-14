'use strict';
const { SUPABASE_URL, SUPABASE_KEY } = require('./config');

// ── Whitelist: patterns autorisés (regex) ──
const WHITELIST = [
  /^docker\s+(ps|logs|inspect|stats|images|top|port|diff)\b/,
  /^docker\s+compose\s+(ps|logs|config)\b/,
  /^(cat|head|tail|wc|ls|df|free|uptime|hostname|whoami)\b/,
  /^curl\s+-s\b/,
  /^\/home\/furycom\/scripts\//,
  /^\.\/bruce_/,
];

// ── Blacklist: patterns interdits (regex) ──
const BLACKLIST = [
  /rm\s+(-rf?|--force)\b/,
  /mkfs\b/,
  /dd\s+if=/,
  />\s*\/dev\/sd/,
  /chmod\s+777\b/,
  /shutdown|reboot|poweroff|init\s+[06]/,
  /&&/,                            // chaînage interdit
  /\|.*\|/,                        // double pipe interdit
  /;\s*rm\b/,                      // injection via ;
  /`/,                             // backtick injection
  /\$\(/,                          // command substitution
  /\\"/,                           // guillemets imbriqués
];

/**
 * Valide une commande exec.
 * @param {string} cmd - Commande à valider
 * @returns {{ allowed: boolean, reason?: string }}
 */
function validateExecCommand(cmd) {
  const trimmed = (cmd || '').trim();
  if (!trimmed) return { allowed: false, reason: 'Empty command' };

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
 * Log audit entry to Supabase bruce_audit_log (fire-and-forget).
 */
function auditLog(endpoint, caller, host, cmd, result, durationMs) {
  // DISABLED: table bruce_audit_log inexistante/vidée, voir [840].
  return;
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  const base = String(SUPABASE_URL).replace(/\/+$/, '');
  const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
  const url = useRestV1
    ? base.replace(/\/rest\/v1$/, '') + '/rest/v1/bruce_audit_log'
    : base + '/bruce_audit_log';

  const row = {
    timestamp: new Date().toISOString(),
    endpoint,
    caller: caller || null,
    host: host || 'local',
    cmd: cmd || null,
    result: result || 'ok',
    duration_ms: durationMs || null,
  };

  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
    },
    body: JSON.stringify(row),
  }).catch(() => {}); // fire-and-forget
}

module.exports = { validateExecCommand, auditLog, WHITELIST, BLACKLIST };
