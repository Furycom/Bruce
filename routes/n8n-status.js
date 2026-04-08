// routes/n8n-status.js — [1392] S1452 n8n workflows status enrichi (lastExec, errorDetail)
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const router = Router();

const N8N_URL = 'http://192.168.2.174:5678/api/v1';
const N8N_KEY = 'n8n_api_bruce_bd1caf5b4aa74a228edd99c9bd43a4f8';

let _cache = { data: null, ts: 0 };
const TTL = 60000;

router.get('/bruce/n8n-status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  if (_cache.data && (Date.now() - _cache.ts) < TTL) {
    return res.json({ ..._cache.data, cached: true });
  }

  try {
    const [wfRes, exRes, exSuccessRes] = await Promise.all([
      fetch(`${N8N_URL}/workflows?limit=50`, { headers: { 'X-N8N-API-KEY': N8N_KEY }, signal: AbortSignal.timeout(8000) }),
      fetch(`${N8N_URL}/executions?limit=20&status=error`, { headers: { 'X-N8N-API-KEY': N8N_KEY }, signal: AbortSignal.timeout(8000) }),
      fetch(`${N8N_URL}/executions?limit=50&status=success`, { headers: { 'X-N8N-API-KEY': N8N_KEY }, signal: AbortSignal.timeout(8000) }),
    ]);

    const wfData = await wfRes.json();
    const exData = await exRes.json();
    const exSuccessData = await exSuccessRes.json();

    // Build map of latest execution per workflow (success or error)
    const allExecs = [...(exData.data || []), ...(exSuccessData.data || [])];
    const lastExecByWf = {};
    for (const ex of allExecs) {
      const wid = ex.workflowId;
      if (!lastExecByWf[wid] || new Date(ex.startedAt) > new Date(lastExecByWf[wid].startedAt)) {
        lastExecByWf[wid] = ex;
      }
    }

    const result = {
      ok: true,
      generated_at: new Date().toISOString(),
      workflows: (wfData.data || []).map(w => ({
        id: w.id,
        name: w.name,
        active: w.active,
        updatedAt: w.updatedAt || null,
        lastExec: lastExecByWf[w.id] ? {
          status: lastExecByWf[w.id].status,
          startedAt: lastExecByWf[w.id].startedAt,
          stoppedAt: lastExecByWf[w.id].stoppedAt,
        } : null,
      })),
      recentErrors: (exData.data || []).map(e => ({
        id: e.id,
        workflowId: e.workflowId,
        workflowName: (wfData.data || []).find(w => w.id === e.workflowId)?.name || `WF#${e.workflowId}`,
        status: e.status,
        startedAt: e.startedAt,
        stoppedAt: e.stoppedAt,
        errorMessage: e.data?.resultData?.error?.message || e.data?.resultData?.lastNodeExecuted || null,
      })),
    };

    _cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    console.error('[n8n-status] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
