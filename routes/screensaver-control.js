// routes/screensaver-control.js — [S1482] Unified screensaver control
// SOLE CONTROLLER: n8n WF102 (bruce_llm_watchdog.py)
// systemd bruce-screensaver.service DISABLED permanently
// Auth n8n: X-N8N-API-KEY (KB documented)
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const { BRUCE_SSH_KEY_PATH } = require('../shared/config');
const { execFile } = require('child_process');
const router = Router();

const HOST_IP = '172.18.0.1';
const HOST_USER = 'furycom';
const FLAG_FILE = '/home/furycom/logs/llm_claimed.json';
const WATCHDOG_LOG = '/home/furycom/logs/llm_watchdog.log';
const SCREENSAVER_LOG = '/home/furycom/logs/screensaver.log';
const SCREEN_NAME = 'screensaver';
const SCREENSAVER_CMD = 'python3 /home/furycom/bruce_screensaver.py --loop';

// n8n API — KB documented: header X-N8N-API-KEY, key from bruce_api_keys
const N8N_BASE = 'http://192.168.2.174:5678/api/v1';
const N8N_API_KEY = process.env.N8N_API_KEY || 'n8n_api_bruce_bd1caf5b4aa74a228edd99c9bd43a4f8';
const N8N_WF_ID = 'PN1UGw6f6LkuhgEC'; // WF102 bruce_llm_watchdog

function n8nHeaders() {
  return { 'X-N8N-API-KEY': N8N_API_KEY, 'Accept': 'application/json', 'Content-Type': 'application/json' };
}

function hostExec(command, timeout) {
  timeout = timeout || 12000;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('SSH timeout')), timeout);
    execFile('ssh', [
      '-i', BRUCE_SSH_KEY_PATH,
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=5',
      HOST_USER + '@' + HOST_IP, command
    ], { timeout, maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      clearTimeout(t);
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

async function n8nGetWf() {
  try {
    const r = await fetch(N8N_BASE + '/workflows/' + N8N_WF_ID, { headers: n8nHeaders() });
    if (r.ok) return await r.json();
  } catch(e) {}
  return null;
}

async function n8nSetActive(active) {
  try {
    const endpoint = active ? 'activate' : 'deactivate';
    const r = await fetch(N8N_BASE + '/workflows/' + N8N_WF_ID + '/' + endpoint, {
      method: 'POST', headers: n8nHeaders()
    });
    return r.ok;
  } catch(e) { return false; }
}

// --- GET /bruce/screensaver/status ---
router.get('/bruce/screensaver/status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    // Gather all data in one SSH call
    const out = await hostExec([
      'screen -ls 2>/dev/null | grep -q "' + SCREEN_NAME + '" && echo RUNNING || echo STOPPED',
      'cat ' + FLAG_FILE + ' 2>/dev/null || echo "{}"',
      'echo "---M---"',
      'grep "Metrics=" ' + SCREENSAVER_LOG + ' 2>/dev/null | tail -1',
      'echo "---W---"',
      'tail -20 ' + WATCHDOG_LOG + ' 2>/dev/null',
      'echo "---P---"',
      'pgrep -af bruce_screensaver.py 2>/dev/null | grep -v pgrep | grep -v ssh || echo NONE',
      'echo "---L---"',
      'tail -' + (req.query.log_lines || '50') + ' ' + SCREENSAVER_LOG + ' 2>/dev/null',
    ].join('; '), 12000);

    const mSplit = out.split('---M---');
    const header = mSplit[0].split('\n');
    const running = header[0] === 'RUNNING';
    let flag = {};
    try { flag = JSON.parse(header.slice(1).join('\n').trim()); } catch(e) {}

    const wSplit = (mSplit[1] || '').split('---W---');

    // Parse metrics
    let metrics = {};
    const mLine = (wSplit[0] || '').trim();
    const mm = mLine.match(/Metrics=(\{[^}]+\})/);
    if (mm) try { metrics = JSON.parse(mm[1].replace(/'/g, '"')); } catch(e) {}

    // Split PIDs and log from watchdog section
    const pSplit = (wSplit[1] || '').split('---P---');
    const wdRaw = (pSplit[0] || '').trim();
    const lSplit = (pSplit[1] || '').split('---L---');
    const pidRaw = (lSplit[0] || '').trim();
    const logRaw = (lSplit[1] || '').trim();

    // Parse watchdog events
    const wdLines = wdRaw.split('\n').filter(l => l.trim());
    const events = [];
    for (const line of wdLines) {
      const ts = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (!ts) continue;
      if (line.includes('Auto-start') && line.includes('successfully')) events.push({ ts: ts[1], type: 'start' });
      else if (line.includes('skipping') || line.includes('Restart=no')) events.push({ ts: ts[1], type: 'skip' });
      else if (line.includes('idle')) {
        const idleM = line.match(/idle for (\d+)min/);
        events.push({ ts: ts[1], type: 'idle', minutes: idleM ? parseInt(idleM[1]) : null });
      }
    }

    // Parse PIDs
    const pids = [];
    if (pidRaw && pidRaw !== 'NONE') {
      for (const line of pidRaw.split('\n')) {
        const m = line.match(/^(\d+)\s+(.+)/);
        if (m) pids.push({ pid: parseInt(m[1]), cmd: m[2].trim() });
      }
    }

    // Parse log lines
    const logLines = logRaw ? logRaw.split('\n').filter(l => l.trim()) : [];

    // n8n WF102 active status
    const wf = await n8nGetWf();
    const autoEnabled = wf ? wf.active : null;

    // Uptime estimate
    let lastStartTs = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'start') { lastStartTs = events[i].ts; break; }
    }

    res.json({
      ok: true,
      running,
      auto_enabled: autoEnabled,
      claimed: !!flag.claimed,
      claimed_by: flag.claimed_by || null,
      last_start: lastStartTs,
      pids,
      ghost_warning: pids.length > 1 ? 'Plusieurs processus detectes — utiliser Kill All' : null,
      log_tail: logLines,
      metrics: {
        cycles: metrics.cycles || 0,
        batches: metrics.batches || 0,
        items_updated: metrics.items_updated || 0,
        items_archived: metrics.items_archived || 0,
        duplicates_archived: metrics.duplicates_archived || 0,
        canon_nominations: metrics.canon_nominations || 0,
        vrc_evaluations: metrics.vrc_evaluations || 0,
        lightrag_inserts: metrics.lightrag_inserts || 0,
      },
      recent_events: events.slice(-5),
    });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// --- POST /bruce/screensaver/stop ---
router.post('/bruce/screensaver/stop', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const claimJson = JSON.stringify({ claimed: true, claimed_by: 'dashboard', timestamp: Math.floor(Date.now()/1000), action: 'claim' });
    await hostExec("echo '" + claimJson + "' > " + FLAG_FILE, 5000);
    await hostExec('/home/furycom/screensaver_stop.sh', 5000);
    await new Promise(r => setTimeout(r, 1500));
    const check = await hostExec('screen -ls 2>/dev/null | grep -q screensaver && echo RUNNING || echo STOPPED', 5000);
    res.json({ ok: true, action: 'stopped', running: check === 'RUNNING' });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// --- POST /bruce/screensaver/start ---
router.post('/bruce/screensaver/start', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const releaseJson = JSON.stringify({ claimed: false, claimed_by: 'dashboard', timestamp: Math.floor(Date.now()/1000), action: 'release' });
    await hostExec("echo '" + releaseJson + "' > " + FLAG_FILE, 5000);
    await hostExec('/home/furycom/screensaver_start.sh', 5000);
    await new Promise(r => setTimeout(r, 2000));
    const check = await hostExec('screen -ls 2>/dev/null | grep -q screensaver && echo RUNNING || echo STOPPED', 5000);
    res.json({ ok: true, action: 'started', running: check === 'RUNNING' });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// --- POST /bruce/screensaver/restart-toggle ---
router.post('/bruce/screensaver/restart-toggle', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const enable = req.body.enable !== undefined ? !!req.body.enable : true;
  try {
    const ok = await n8nSetActive(enable);
    if (!ok) return res.json({ ok: false, error: 'n8n API call failed' });
    // Auto toggle only controls n8n WF — does NOT affect running screensaver
    if (enable) {
      // Release claim so watchdog can restart if needed
      const releaseJson = JSON.stringify({ claimed: false, claimed_by: 'dashboard-auto-on', timestamp: Math.floor(Date.now()/1000), action: 'release' });
      await hostExec("echo '" + releaseJson + "' > " + FLAG_FILE, 5000);
    }
    const wf = await n8nGetWf();
    res.json({ ok: true, auto_enabled: wf ? wf.active : enable });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// POST /bruce/screensaver/kill — Force kill ALL screensaver processes
router.post('/bruce/screensaver/kill', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    // Claim flag
    const claimJson = JSON.stringify({ claimed: true, claimed_by: 'dashboard-kill', timestamp: Math.floor(Date.now()/1000), action: 'kill' });
    await hostExec("echo '" + claimJson + "' > " + FLAG_FILE, 5000);
    // Kill everything: screen sessions + all matching processes
    await hostExec('/home/furycom/screensaver_stop.sh', 5000);
    // Also sudo kill any remaining
    await hostExec('sudo pkill -9 -f bruce_screensaver.py 2>/dev/null; screen -wipe 2>/dev/null; true', 5000);
    await new Promise(r => setTimeout(r, 2000));
    // Verify
    const check = await hostExec('pgrep -af bruce_screensaver.py 2>/dev/null | grep -v pgrep | grep -v ssh || echo NONE', 5000);
    const remaining = check === 'NONE' ? [] : check.split('\n').filter(l => l.match(/^\d+/));
    res.json({ ok: true, action: 'kill_all', remaining_pids: remaining.length, running: remaining.length > 0 });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

module.exports = router;
