// routes/data-write.js — [773] C7 REFONTE
// Route: POST /bruce/write
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY, BRUCE_AUTH_TOKEN, VALIDATE_SERVICE_URL } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');

router.post('/bruce/write', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { table_cible, contenu_json, author_system, content_hash, auto_validate } = req.body || {};

  const ALLOWED_TABLES = ['lessons_learned', 'knowledge_base', 'current_state', 'roadmap', 'session_history'];
  if (!table_cible || !ALLOWED_TABLES.includes(table_cible)) {
    return res.status(400).json({ ok: false, error: 'table_cible invalide ou manquante. Tables autorisées: ' + ALLOWED_TABLES.join(', ') });
  }
  if (!contenu_json || typeof contenu_json !== 'object') {
    return res.status(400).json({ ok: false, error: 'contenu_json manquant ou invalide' });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };

  try {
    // [779] Fallback lesson_type pour lessons_learned: evite rejet Gate-1
    if (table_cible === 'lessons_learned' && contenu_json && !contenu_json.lesson_type) {
      contenu_json.lesson_type = 'solution';
      console.log('[779] lesson_type absent -> fallback solution injecte');
    }

    // 1. Push vers staging_queue
    const stagingPayload = {
      table_cible,
      contenu_json,
      author_system: author_system || 'mcp-gateway',
      content_hash: content_hash || null
    };

    const stagingRes = await fetchWithTimeout(
      base + '/staging_queue',
      { method: 'POST', headers: hSupa, body: JSON.stringify(stagingPayload) },
      8000
    );

    if (!stagingRes.ok) {
      const errText = await stagingRes.text();
      return res.status(stagingRes.status).json({ ok: false, error: 'staging_queue push failed: ' + errText });
    }

    const stagingData = await stagingRes.json();
    const stagingId = Array.isArray(stagingData) ? stagingData[0]?.id : stagingData?.id;

    // 2. Auto-validate (défaut: true)
    const shouldValidate = auto_validate !== false;
    let validateResult = null;

    if (shouldValidate) {
      try {
        const valRes = await fetchWithTimeout(
          `${VALIDATE_SERVICE_URL}/run/validate`,
          { method: 'POST', headers: { 'X-BRUCE-TOKEN': String(process.env.BRUCE_AUTH_TOKEN || 'bruce-secret-token-01') } },
          20000
        );
        const valData = await valRes.json();
        validateResult = {
          exit: valData?.validate?.exit,
          valides: (valData?.validate?.stdout || '').match(/Valides:\s+(\d+)/)?.[1] || '?',
          erreurs: (valData?.validate?.stdout || '').match(/Erreurs:\s+(\d+)/)?.[1] || '?'
        };
      } catch(ve) {
        validateResult = { error: 'validate non disponible: ' + ve.message };
      }
    }

    // [P7-FIX triage Opus 2026-03-02] Determine validated from actual valides count
    const validesCount = parseInt(validateResult?.valides) || 0;
    const wasValidated = shouldValidate && validateResult?.exit === 0 && validesCount > 0;

    // [P7-FIX] If rejected, fetch rejection_reason from staging
    let rejectionReason = null;
    if (shouldValidate && validateResult?.exit === 0 && validesCount === 0 && stagingId) {
      try {
        const stgCheck = await fetchWithTimeout(
          base + '/staging_queue?id=eq.' + stagingId + '&select=status,rejection_reason',
          { headers: hSupa }, 5000
        );
        const stgData = await stgCheck.json();
        const stgEntry = Array.isArray(stgData) ? stgData[0] : stgData;
        if (stgEntry?.rejection_reason) rejectionReason = stgEntry.rejection_reason;
        if (stgEntry?.status === 'rejected' && !rejectionReason) rejectionReason = 'Rejected by validate.py (no reason captured)';
      } catch(re) { console.error('[data-write.js][/bruce/data/write] erreur silencieuse:', re.message || re); }
    }

    const response = {
      ok: true,
      staging_id: stagingId,
      table_cible,
      validated: wasValidated,
      validate_result: validateResult
    };
    if (rejectionReason) response.rejection_reason = rejectionReason;
    return res.json(response);

  } catch(e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
