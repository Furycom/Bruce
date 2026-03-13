// routes/tools-unlock.js — [915] Conscience proactive BRUCE
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');

const BASE_CAPABILITIES = ['docker', 'supabase_operationnel', 'postgresql_disponible', 'gateway_api'];

router.all('/bruce/tools/unlocked', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  try {
    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key = String(SUPABASE_KEY || '');
    const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' };

    // Accept capabilities from query string or body
    let caps = [];
    if (req.body && req.body.capabilities && Array.isArray(req.body.capabilities)) {
      caps = req.body.capabilities;
    } else if (req.query && req.query.capabilities) {
      caps = req.query.capabilities.split(',').map(s => s.trim());
    }

    // If no capabilities provided, auto-detect from service health checks
    if (caps.length === 0) {
      caps = [...BASE_CAPABILITIES];
      const checks = [
        { url: 'http://192.168.2.85:8081/health', caps: ['embedder_bge_m3', 'embedding_1024d'] },
        { url: 'http://192.168.2.32:8000/health', caps: ['inference_locale', 'gpu_nvidia', 'dell_7910_operationnel', 'modele_capable_32b'] },
        { url: 'http://192.168.2.230:4100/health/liveliness', caps: ['litellm_proxy', 'litellm_callback_configured'] },
        { url: 'http://192.168.2.230:4001/health', caps: ['validate_pipeline_ok', 'validate_service_http'] },
      ];
      await Promise.all(checks.map(async (c) => {
        try {
          const r = await fetchWithTimeout(c.url, { method: 'GET' }, 3000);
          if (r.ok) caps.push(...c.caps);
        } catch (_) {}
      }));
      if (caps.includes('embedder_bge_m3') && caps.includes('supabase_operationnel')) {
        caps.push('indexation_auto_chunks');
      }
    }

    // Query bruce_tools directly instead of RPC (avoids PostgREST schema cache issues)
    const sqlResp = await fetchWithTimeout(base + '/rpc/exec_sql', {
      method: 'POST',
      headers: hSupa,
      body: JSON.stringify({
        query: `SELECT id, name, capability_tag, status, unblocked_by::text FROM bruce_tools WHERE unblocked_by IS NOT NULL AND jsonb_typeof(unblocked_by) = 'array' AND jsonb_array_length(unblocked_by) > 0`
      })
    }, 5000);

    if (!sqlResp.ok) {
      const errText = await sqlResp.text();
      return res.status(500).json({ ok: false, error: 'SQL failed: ' + errText });
    }

    const sqlResult = await sqlResp.json();
    const rows = sqlResult.data || sqlResult || [];

    const blocked = [];
    const unblocked = [];

    for (const row of rows) {
      let reqs;
      try { reqs = JSON.parse(row.unblocked_by); } catch (_) { continue; }
      if (!Array.isArray(reqs)) continue;
      const missing = reqs.filter(r => !caps.includes(r));
      const entry = { id: row.id, name: row.name, tag: row.capability_tag, status: row.status };
      if (missing.length === 0) {
        unblocked.push(entry);
      } else {
        blocked.push({ ...entry, missing });
      }
    }

    return res.json({
      ok: true,
      active_capabilities: caps,
      total_tools_checked: rows.length,
      unblocked_count: unblocked.length,
      blocked_count: blocked.length,
      unblocked,
      blocked,
      summary: `${unblocked.length} tools ready, ${blocked.length} blocked`
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
module.exports.router = router;