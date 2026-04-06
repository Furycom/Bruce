'use strict';
const { Router } = require('express');
const { execSync } = require('child_process');
const { validateBruceAuth, requireScope } = require('../shared/auth');
const { validateExecCommand, auditLog } = require('../shared/exec-security');

const router = Router();

router.post('/bruce/exec', async (req, res) => {
  const auth = validateBruceAuth(req, 'exec');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });

  const { command, timeout = 15000 } = req.body || {};
  if (!command) return res.status(400).json({ ok: false, error: 'command required' });

  const cmd = String(command).trim();
  const check = validateExecCommand(cmd);

  if (!check.allowed) {
    auditLog('/bruce/exec', req.headers['x-session-id'], 'local', cmd, 'refused', 0);
    return res.status(403).json({ ok: false, error: 'Command refused', reason: check.reason });
  }

  const t0 = Date.now();
  try {
    const maxTimeout = Math.min(parseInt(timeout, 10) || 15000, 30000);
    const output = execSync(cmd, {
      timeout: maxTimeout,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ms = Date.now() - t0;
    auditLog('/bruce/exec', req.headers['x-session-id'], 'local', cmd, 'ok', ms);
    const resp = {
      ok: true,
      command: cmd,
      output: (output || '').substring(0, 50000),
      duration_ms: ms,
    };
    // [S1327-A1] Propager warning WARNLIST si present
    if (check.warning) resp.warning = check.warning;
    res.json(resp);
  } catch (e) { console.error(`[exec.js] operation failed:`, e.message);
    const ms = Date.now() - t0;
    auditLog('/bruce/exec', req.headers['x-session-id'], 'local', cmd, 'error', ms);
    const errResp = {
      ok: false,
      command: cmd,
      error: e.message,
      stderr: (e.stderr || '').substring(0, 10000),
      exit_code: e.status || null,
      duration_ms: ms,
    };
    // [PA1-S1329] Propager warning WARNLIST meme en cas d erreur d execution
    if (check.warning) errResp.warning = check.warning;
    res.status(500).json(errResp);
  }
});

module.exports = router;
