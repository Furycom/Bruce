'use strict';
const { Router } = require('express');
const { SUPABASE_URL, SUPABASE_KEY, VALIDATE_SERVICE_URL } = require('../shared/config');
const { validateBruceAuth } = require('../shared/auth');

const router = Router();

// POST /bruce/staging/validate — via validate_service HTTP sur hote port 4001
/**
 * Handles POST /bruce/staging/validate.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.post('/bruce/staging/validate', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  try {
    const r = await fetch(VALIDATE_SERVICE_URL + '/run/validate', {
      method: 'POST',
      headers: { 'X-BRUCE-TOKEN': 'bruce-secret-token-01', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(65000)
    });
    const data = await r.json();
    if (!r.ok) {
      const description = (data && data.error) ? data.error : 'Staging validation failed';
      return res.status(500).json({ ok: false, error: description });
    }
    // TODO(contract-v2): migrate success payload to { ok: true, data } without breaking current consumers.
    return res.json(data);
  } catch (e) { console.error(`[staging.js] operation failed:`, e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// GET /bruce/staging/status — etat staging_queue
/**
 * Handles GET /bruce/staging/status.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.get('/bruce/staging/status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  const base = SUPABASE_URL.replace(/\/+$/, '');
  const hdrs = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Accept: 'application/json' };
  try {
    const r = await fetch(base + '/staging_queue?select=status&limit=500', { headers: hdrs });
    const rows = await r.json();
    if (!Array.isArray(rows)) return res.status(500).json({ ok: false, error: 'Supabase error', detail: rows });
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
    // TODO(contract-v2): migrate success payload to { ok: true, data } without breaking current consumers.
    res.json({ ok: true, total: rows.length, counts });
  } catch (e) { console.error(`[staging.js] operation failed:`, e.message); res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
