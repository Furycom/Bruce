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
 * Validates whether an exec command is allowed using blacklist and whitelist rules.
 * @param {string} cmd - Raw shell command to validate.
 * @returns {{ allowed: boolean, reason?: string }} Validation result with an optional deny reason.
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
 * Writes an exec audit entry to Supabase in fire-and-forget mode.
 * Currently returns immediately because logging is disabled.
 * @param {string} endpoint - API endpoint that triggered the exec action.
 * @param {string} caller - Caller identity or client type.
 * @param {string} host - Target host for the command execution context.
 * @param {string} cmd - Executed command string.
 * @param {string} result - Execution outcome label.
 * @param {number} durationMs - Command duration in milliseconds.
 * @returns {void} No return value.
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
