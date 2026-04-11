// routes/screensaver-status.js — [1480] S1464 FIXED job order alignment with Python
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const { BRUCE_SSH_KEY_PATH, BRUCE_SSH_HOSTS } = require('../shared/config');
const { execFile } = require('child_process');
const router = Router();

const SCREENSAVER_HOST = '192.168.2.230';
const STATE_FILE = '/home/furycom/logs/screensaver_state.json';

// MUST match bruce_screensaver.py exactly:
// Phase 0 (housekeeping): staging_purge, audit_log_rotation  (run before pipeline_stage_index=0)
// Phase 1 (PIPELINE_STAGES index 0-5): dedup, cross_table_coherence, lesson_review, kb_audit, canon_nomination, vrc_pipeline
// Phase 2 (AUXILIARY_JOBS index 6-8): ingestion, session_summary, lightrag
const HOUSEKEEPING = ['staging_purge', 'audit_log_rotation'];
const PIPELINE = ['dedup', 'cross_table_coherence', 'lesson_review', 'kb_audit', 'canon_nomination', 'vrc_pipeline'];
const AUXILIARY = ['ingestion', 'session_summary', 'lightrag'];
const ALL_STAGES = [...PIPELINE, ...AUXILIARY]; // index 0-8 = pipeline_stage_index
const ALL_JOBS = [...HOUSEKEEPING, ...PIPELINE, ...AUXILIARY]; // for display

const JOB_NAMES = {
  staging_purge: 'Nettoyage staging',
  audit_log_rotation: 'Rotation logs',
  dedup: 'Dédoublonnage',
  cross_table_coherence: 'Cohérence inter-tables',
  lesson_review: 'Revue lessons',
  kb_audit: 'Audit KB',
  canon_nomination: 'Nomination canon',
  vrc_pipeline: 'Vérification VRC',
  ingestion: 'Ingestion fichiers',
  session_summary: 'Résumé sessions',
  lightrag: 'Indexation RAG',
  canon_vrc: 'Vérification VRC (ancien)',
  coherence: 'Cohérence données',
};

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

function computeTimingSummary(jobTimings, currentStageStartedAt, cycleStartedAt, lastCycleDuration) {
  const now = Date.now() / 1000;
  const summary = {};
  let totalAvg = 0;
  let jobsWithData = 0;
  for (const [jobKey, entries] of Object.entries(jobTimings || {})) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const durations = entries.map(e => e.duration_s).filter(d => typeof d === 'number');
    if (durations.length === 0) continue;
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const last = entries[entries.length - 1];
    summary[jobKey] = { avg_s: Math.round(avg * 10) / 10, last_s: last.duration_s, last_result: last.result, last_ts: last.ts, samples: durations.length };
    totalAvg += avg;
    jobsWithData++;
  }
  let currentStageElapsed = null;
  if (currentStageStartedAt && typeof currentStageStartedAt === 'number') currentStageElapsed = Math.round(now - currentStageStartedAt);
  let cycleElapsed = null;
  if (cycleStartedAt && typeof cycleStartedAt === 'number') cycleElapsed = Math.round(now - cycleStartedAt);
  return { byJob: summary, currentStageElapsed_s: currentStageElapsed, cycleElapsed_s: cycleElapsed, lastCycleDuration_s: lastCycleDuration || null, estimatedCycleDuration_s: jobsWithData > 0 ? Math.round(totalAvg) : null };
}

let _ssCache = { data: null, ts: 0 };
const SS_TTL = 30000;

router.get('/bruce/screensaver-status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  if (_ssCache.data && (Date.now() - _ssCache.ts) < SS_TTL) return res.json({ ..._ssCache.data, cached: true });

  try {
    let processAlive = false, processPid = null, processUptime = null;
    try {
      const psOut = await sshExec("ps aux | grep 'bruce_screensaver.py --loop' | grep -v grep | head -1");
      if (psOut) { processAlive = true; const parts = psOut.split(/\s+/); processPid = parts[1] || null; processUptime = parts[9] || null; }
    } catch (e) {}

    let state = null;
    try { const stateRaw = await sshExec('cat ' + STATE_FILE); state = JSON.parse(stateRaw); } catch (e) {}

    // pipeline_stage_index: -1 = housekeeping, 0-5 = PIPELINE, 6-8 = AUXILIARY
    const psi = state ? state.pipeline_stage_index : null;
    let currentStageKey = null, currentStageName = null, currentDisplayIndex = null;
    if (psi != null && psi >= 0 && psi < ALL_STAGES.length) {
      currentStageKey = ALL_STAGES[psi];
      currentStageName = JOB_NAMES[currentStageKey] || currentStageKey;
      currentDisplayIndex = psi + 2; // +2 because housekeeping is 0,1
    } else if (psi === -1) {
      currentStageKey = 'housekeeping';
      currentStageName = 'Nettoyage (staging + logs)';
      currentDisplayIndex = 0;
    }

    // Job health
    const jobs = [];
    if (state && state.jobs) {
      ALL_JOBS.forEach((key, idx) => {
        const j = state.jobs[key] || {};
        const disabledUntil = j.disabled_until || 0;
        const now = Math.floor(Date.now() / 1000);
        const isDisabled = disabledUntil > now;
        const isCurrent = (psi === -1 && idx < 2) ? false : (psi >= 0 && key === ALL_STAGES[psi]);
        jobs.push({ key, name: JOB_NAMES[key] || key, failures: j.failures || 0, lastError: j.last_error || null, disabled: isDisabled, disabledFor: isDisabled ? Math.round((disabledUntil - now) / 60) + ' min' : null, current: isCurrent });
      });
    }

    const metrics = state ? state.metrics || {} : {};
    const timings = state ? computeTimingSummary(state.job_timings, state.current_stage_started_at, state.cycle_started_at, state.last_cycle_duration_s) : null;

    const _ssResult = {
      ok: true,
      process: { alive: processAlive, pid: processPid, uptime: processUptime },
      currentJob: { index: currentDisplayIndex, key: currentStageKey, name: currentStageName, pipelineStageIndex: psi },
      totalCycles: metrics.cycles || 0,
      totalBatches: metrics.batches || 0,
      itemsUpdated: metrics.items_updated || 0,
      itemsArchived: metrics.items_archived || 0,
      duplicatesArchived: metrics.duplicates_archived || 0,
      canonNominations: metrics.canon_nominations || 0,
      vrcEvaluations: metrics.vrc_evaluations || 0,
      lightragInserts: metrics.lightrag_inserts || 0,
      timings,
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
