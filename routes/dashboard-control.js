// routes/dashboard-control.js — [S1447] Full dashboard control via gateway
// Routes: GET  /bruce/dashboard/component   — Read a source file
//         POST /bruce/dashboard/component   — Write a source file
//         POST /bruce/dashboard/deploy      — Build + deploy + git commit
//         GET  /bruce/dashboard/status      — Version, health, file list
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const { BRUCE_SSH_KEY_PATH, BRUCE_SSH_HOSTS } = require('../shared/config');
const { execFile } = require('child_process');
const router = Router();

const DASHBOARD_IP = '192.168.2.12';
const DASHBOARD_BASE = '/home/yann/bruce-dashboard';
const DASHBOARD_SRC = DASHBOARD_BASE + '/src';
const DASHBOARD_URL = 'http://192.168.2.12:8029';

// Allowed file paths (relative to src/) — prevent directory traversal
const ALLOWED_DIRS = ['components/', ''];
const ALLOWED_EXTENSIONS = ['.jsx', '.js', '.css', '.json'];

function validateFilePath(name) {
  if (!name || typeof name !== 'string') return null;
  // Prevent traversal
  if (name.includes('..') || name.includes('~') || name.startsWith('/')) return null;
  // Must have allowed extension
  const hasExt = ALLOWED_EXTENSIONS.some(ext => name.endsWith(ext));
  if (!hasExt) return null;
  // Must be in allowed directory
  const inAllowed = ALLOWED_DIRS.some(dir => name.startsWith(dir) || !name.includes('/'));
  if (!inAllowed) return null;
  return DASHBOARD_SRC + '/' + name;
}

function sshExec(command, timeout) {
  timeout = timeout || 15000;
  const hostConf = BRUCE_SSH_HOSTS[DASHBOARD_IP];
  if (!hostConf) return Promise.reject(new Error('No SSH config for ' + DASHBOARD_IP));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('SSH timeout')), timeout);
    const args = [
      '-i', BRUCE_SSH_KEY_PATH,
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5',
      hostConf.user + '@' + DASHBOARD_IP,
      command
    ];
    execFile('ssh', args, { timeout, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      clearTimeout(t);
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// ============================================================
// GET /bruce/dashboard/component?name=components/SystemCard.jsx
// Read a source file from the dashboard
// ============================================================
router.get('/bruce/dashboard/component', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const name = req.query.name;
  const fullPath = validateFilePath(name);
  if (!fullPath) return res.status(400).json({ ok: false, error: 'Invalid file path: ' + name });

  try {
    const content = await sshExec('cat ' + fullPath, 10000);
    const lines = content.split('\n').length;
    return res.json({ ok: true, name, path: fullPath, lines, content });
  } catch (e) {
    return res.status(404).json({ ok: false, error: 'File not found or SSH error: ' + e.message });
  }
});

// ============================================================
// POST /bruce/dashboard/component
// Write a source file to the dashboard
// Body: { name: "components/SystemCard.jsx", content: "..." }
// Handles CRLF conversion automatically
// ============================================================
router.post('/bruce/dashboard/component', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const { name, content } = req.body || {};
  const fullPath = validateFilePath(name);
  if (!fullPath) return res.status(400).json({ ok: false, error: 'Invalid file path: ' + name });
  if (!content || typeof content !== 'string') return res.status(400).json({ ok: false, error: 'content is required' });

  try {
    // Write content to a temp file on .230, SCP to .12, then clean CRLF
    const fs = require('fs');
    const tmpFile = '/tmp/dashboard_upload_' + Date.now() + '.tmp';
    // Normalize line endings to LF before writing
    const cleanContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    fs.writeFileSync(tmpFile, cleanContent, 'utf-8');

    // SCP to .12
    const hostConf = BRUCE_SSH_HOSTS[DASHBOARD_IP];
    await new Promise((resolve, reject) => {
      const args = [
        '-i', BRUCE_SSH_KEY_PATH,
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
        tmpFile,
        hostConf.user + '@' + DASHBOARD_IP + ':' + fullPath
      ];
      execFile('scp', args, { timeout: 15000 }, (err, stdout, stderr) => {
        // Clean up temp file
        try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });

    // Verify the file was written
    const verify = await sshExec('wc -l < ' + fullPath, 5000);
    const writtenLines = parseInt(verify.trim()) || 0;

    return res.json({ ok: true, name, path: fullPath, lines: writtenLines, message: 'Component written successfully' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Write failed: ' + e.message });
  }
});

// ============================================================
// POST /bruce/dashboard/deploy
// Build, deploy, and git commit the dashboard
// Body: { message: "commit message" } (optional)
// ============================================================
router.post('/bruce/dashboard/deploy', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const commitMsg = (req.body && req.body.message) ? String(req.body.message).slice(0, 200) : 'auto-deploy via gateway';
  const startMs = Date.now();

  try {
    // Run the deploy script
    const deployOutput = await sshExec(
      'cd ' + DASHBOARD_BASE + ' && bash deploy-and-version.sh "' + commitMsg.replace(/"/g, '\\"') + '"',
      60000  // 60s timeout for docker build
    );

    // Health check the dashboard after deploy
    let healthOk = false;
    try {
      // Wait a moment for container to start
      await new Promise(r => setTimeout(r, 3000));
      const healthCheck = await sshExec('curl -s -o /dev/null -w "%{http_code}" ' + DASHBOARD_URL + '/', 8000);
      healthOk = healthCheck.trim() === '200';
    } catch (e) { /* health check failed */ }

    // Get current git info
    let version = 'unknown';
    try {
      const gitInfo = await sshExec('cd ' + DASHBOARD_BASE + ' && git log -1 --format="%h %s" 2>/dev/null', 5000);
      version = gitInfo.trim();
    } catch (e) { /* ignore */ }

    return res.json({
      ok: true,
      elapsed_ms: Date.now() - startMs,
      message: commitMsg,
      version,
      health: healthOk,
      deploy_output: deployOutput.trim().split('\n').slice(-8).join('\n'),  // last 8 lines
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      elapsed_ms: Date.now() - startMs,
      error: 'Deploy failed: ' + e.message,
    });
  }
});

// ============================================================
// GET /bruce/dashboard/status
// Current state: version, health, file list, last deploy
// ============================================================
router.get('/bruce/dashboard/status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    const [fileList, gitLog, healthCode, containerStatus] = await Promise.all([
      // List all source files
      sshExec('find ' + DASHBOARD_SRC + ' -name "*.jsx" -o -name "*.js" -o -name "*.css" | sort', 8000)
        .then(out => out.trim().split('\n').map(f => f.replace(DASHBOARD_SRC + '/', '')))
        .catch(() => []),
      // Last 5 git commits
      sshExec('cd ' + DASHBOARD_BASE + ' && git log -5 --format="%h|%s|%cr" 2>/dev/null', 5000)
        .then(out => out.trim().split('\n').map(line => {
          const [hash, msg, when] = line.split('|');
          return { hash, msg, when };
        }))
        .catch(() => []),
      // Health check
      sshExec('curl -s -o /dev/null -w "%{http_code}" ' + DASHBOARD_URL + '/', 5000)
        .then(out => parseInt(out.trim()))
        .catch(() => 0),
      // Docker container status
      sshExec('cd ' + DASHBOARD_BASE + ' && docker compose ps --format "{{.Name}}|{{.Status}}" 2>/dev/null', 5000)
        .catch(() => 'unknown'),
    ]);

    return res.json({
      ok: true,
      url: DASHBOARD_URL,
      health: healthCode === 200,
      http_status: healthCode,
      container: typeof containerStatus === 'string' ? containerStatus.trim() : 'unknown',
      files: fileList,
      recent_commits: gitLog,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
