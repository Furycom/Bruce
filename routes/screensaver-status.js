// routes/screensaver-status.js — [1480] S1450 Screensaver real-time status
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const { BRUCE_SSH_KEY_PATH, BRUCE_SSH_HOSTS } = require('../shared/config');
const { execFile } = require('child_process');
const router = Router();

const SCREENSAVER_HOST = '192.168.2.230';
const STATE_FILE = '/home/furycom/logs/screensaver_state.json';

const JOB_NAMES = {
  staging_purge: 'Nettoyage staging',
  audit_log_rotation: 'Rotation des logs',
  ingestion: 'Ingestion de fichiers',
  dedup: 'Dédoublonnage',
  lesson_review: 'Revue des lessons',
  kb_audit: 'Audit des KB',
  session_summary: 'Résumé de sessions',
  lightrag: 'Indexation LightRAG',
  canon_nomination: 'Nomination canon',
  cross_table_coherence: 'Cohérence inter-tables',
  canon_vrc: 'Vérification VRC',
  vrc_pipeline: 'Pipeline VRC',
  coherence: 'Cohérence données',
};

const JOB_ORDER = [
  'staging_purge', 'audit_log_rotation', 'ingestion', 'dedup',
  'lesson_review', 'kb_audit', 'session_summary', 'lightrag',
  'canon_nomination', 'cross_table_coherence', 'canon_vrc', 'vrc_pipeline', 'coherence'
];

function sshExec(command, timeout) {
  timeout = timeout || 8000;
  const hostConf = BRUCE_SSH_HOSTS[SCREENSAVER_HOST];
  if (!hostConf) return Promise.reject(new Error('No SSH config for ' + SCREENSAVER_HOST));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('SSH timeout')), timeout);
    execFile('ssh', [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
      '-i', hostConf.keyPath || BRUCE_SSH_KEY_PATH,
      `${hostConf.user}@${SCREENSAVER_HOST}`,
      command
    ], { timeout }, (err, stdout, stderr) => {
      clearTimeout(t);
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}


// [1460] S1451 — Response cache 30s
let _ssCache = { data: null, ts: 0 };
const SS_TTL = 30000;

router.get('/bruce/screensaver-status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  // [1460] Cache — return cached if fresh
  if (_ssCache.data && (Date.now() - _ssCache.ts) < SS_TTL) {
    return res.json({ ..._ssCache.data, cached: true });
  }

  try {
    // 1. Check process
    let processAlive = false;
    let processPid = null;
    let processUptime = null;
    try {
      const psOut = await sshExec("ps aux | grep 'bruce_screensaver.py --loop' | grep -v grep | head -1");
      if (psOut) {
        processAlive = true;
        const parts = psOut.split(/\s+/);
        processPid = parts[1] || null;
        // Parse CPU time from ps aux (column 9 = START or TIME)
        processUptime = parts[9] || null;
      }
    } catch (e) { /* process not found */ }

    // 2. Read state file
    let state = null;
    try {
      const stateRaw = await sshExec('cat ' + STATE_FILE);
      state = JSON.parse(stateRaw);
    } catch (e) { /* state file not accessible */ }

    // 3. Build response
    const currentJobIndex = state ? state.current_job_index : null;
    const currentJobKey = currentJobIndex != null ? JOB_ORDER[currentJobIndex] || `job_${currentJobIndex}` : null;
    const currentJobName = currentJobKey ? (JOB_NAMES[currentJobKey] || currentJobKey) : null;

    // Job health summary
    const jobs = [];
    if (state && state.jobs) {
      JOB_ORDER.forEach((key, idx) => {
        const j = state.jobs[key] || {};
        const disabledUntil = j.disabled_until || 0;
        const now = Math.floor(Date.now() / 1000);
        const isDisabled = disabledUntil > now;
        const isCurrent = idx === currentJobIndex;
        jobs.push({
          key,
          name: JOB_NAMES[key] || key,
          failures: j.failures || 0,
          lastError: j.last_error || null,
          disabled: isDisabled,
          disabledFor: isDisabled ? Math.round((disabledUntil - now) / 60) + ' min' : null,
          current: isCurrent,
        });
      });
    }

    // Metrics
    const metrics = state ? state.metrics || {} : {};

    const _ssResult = {
      ok: true,
      process: { alive: processAlive, pid: processPid, uptime: processUptime },
      currentJob: { index: currentJobIndex, key: currentJobKey, name: currentJobName },
      totalCycles: metrics.cycles || 0,
      totalBatches: metrics.batches || 0,
      itemsUpdated: metrics.items_updated || 0,
      itemsArchived: metrics.items_archived || 0,
      duplicatesArchived: metrics.duplicates_archived || 0,
      canonNominations: metrics.canon_nominations || 0,
      vrcEvaluations: metrics.vrc_evaluations || 0,
      lightragInserts: metrics.lightrag_inserts || 0,
      jobs,
      generated_at: new Date().toISOString(),
    };
    _ssCache = { data: _ssResult, ts: Date.now() };
    res.json(_ssResult);
  } catch (err) {
    console.error('[screensaver-status] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
