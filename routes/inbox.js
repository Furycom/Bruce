// routes/inbox.js — [773] C7 REFONTE
// Routes: /bruce/inbox/check, /bruce/inbox/ingest, /bruce/archive/check, /bruce/archive/ingest
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { validateBruceAuth } = require('../shared/auth');
const { BRUCE_AUTH_TOKEN, INBOX_RUNNER_URL } = require('../shared/config');

router.get('/bruce/inbox/check', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const INBOX_DIR = '/home/furycom/inbox';

  try {
    if (!fs.existsSync(INBOX_DIR)) {
      fs.mkdirSync(INBOX_DIR, { recursive: true });
    }
    const files = fs.readdirSync(INBOX_DIR)
      .filter(f => !f.startsWith('.') && f !== 'done')
      .map(f => {
        const fp = path.join(INBOX_DIR, f);
        const stat = fs.statSync(fp);
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      });
    return res.json({ ok: true, count: files.length, files, inbox_dir: INBOX_DIR });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

router.post('/bruce/inbox/ingest', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  // [FIX session 1002] Proxy to host inbox_http_runner.py on port 4002
  const RUNNER_URL = INBOX_RUNNER_URL;
  try {
    const resp = await fetch(RUNNER_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (BRUCE_AUTH_TOKEN || 'bruce-secret-token-01'), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(180000)
    });
    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'inbox runner unreachable: ' + String(e.message), hint: 'Verify tmux inboxrun on .230 port 4002' });
  }
});

router.get('/bruce/archive/check', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const ARCHIVE_DIR = '/home/furycom/archive_inbox';

  try {
    if (!fs.existsSync(ARCHIVE_DIR)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      return res.json({ ok: true, count: 0, files: [], archive_dir: ARCHIVE_DIR });
    }
    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => !f.startsWith('.') && (f.endsWith('.txt') || f.endsWith('.md') || f.endsWith('.log')));
    return res.json({ ok: true, count: files.length, files, archive_dir: ARCHIVE_DIR });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

router.post('/bruce/archive/ingest', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const ARCHIVE_DIR = '/home/furycom/archive_inbox';
  const SCRIPT = '/home/furycom/bruce_ingest.py';
  const VENV_PYTHON = '/home/furycom/venv-ingestion/bin/python3';
  const SENT_DIR = '/home/furycom/archive_inbox_sent';

  try {
    if (!fs.existsSync(ARCHIVE_DIR)) {
      return res.json({ ok: true, ingested: 0, result: 'Archive inbox vide', files: [] });
    }
    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => !f.startsWith('.') && (f.endsWith('.txt') || f.endsWith('.md') || f.endsWith('.log')));
    if (files.length === 0) {
      return res.json({ ok: true, ingested: 0, result: 'Archive inbox vide', files: [] });
    }

    if (!fs.existsSync(SENT_DIR)) fs.mkdirSync(SENT_DIR, { recursive: true });

    const results = [];
    for (const file of files) {
      const filePath = `${ARCHIVE_DIR}/${file}`;
      const sourceLabel = `archive-n8n/${file}`;
      await new Promise((resolve) => {
        const proc = spawn(VENV_PYTHON, [SCRIPT, filePath, '--source', sourceLabel, '--archive'], {
          timeout: 300000
        });
        proc.on('error', (err) => { console.error('[P1-SPAWN-ERR] VENV_PYTHON:', err.message); resolve(); });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', (code) => {
          const ok = code === 0 || stdout.includes('TERMIN') || stdout.includes('staging');
          if (ok) {
            const dest = `${SENT_DIR}/${file}`;
            try { fs.renameSync(filePath, dest); } catch(e) { console.error('[inbox.js][/bruce/archive/ingest] erreur silencieuse:', e.message || e); }
          }
          results.push({ file, ok, code, output: stdout.slice(0, 500) });
          resolve();
        });
      });
    }

    const success = results.filter(r => r.ok).length;
    return res.json({ ok: true, ingested: success, total: files.length, files, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

module.exports = router;
