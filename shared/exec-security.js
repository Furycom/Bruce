'use strict';
const { SUPABASE_URL, SUPABASE_KEY } = require('./config');

// ── Whitelist: patterns autorisés (regex) ──
const WHITELIST = [
  // Docker (read-only)
  /^docker\s+(ps|logs|inspect|stats|images|top|port|diff)\b/,
  /^docker\s+compose\s+(ps|logs|config)\b/,
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
  /\|.*\|/,                        // double pipe interdit (single pipe OK)
  /;\s*rm\b/,                      // injection via ;
  /`/,                             // backtick injection
  /\$\(/,                          // command substitution
  /\\"/,                           // guillemets imbriqués
  /sed\s+-i\b/,                    // in-place edit forbidden
  />\s/,                           // output redirect forbidden
  />>/,                            // append redirect forbidden
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
  }).catch((error) => { console.error(`[exec-security.js] operation failed:`, error.message); }); // fire-and-forget
}

module.exports = { validateExecCommand, auditLog, WHITELIST, BLACKLIST };
