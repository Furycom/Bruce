'use strict';
const { Router } = require('express');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { validateBruceAuth } = require('../shared/auth');

const router = Router();

// POST /bruce/staging/validate — via validate_service HTTP sur hote port 4001
router.post('/bruce/staging/validate', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ error: auth.error });
  try {
    const r = await fetch('http://172.18.0.1:4001/run/validate', {
      method: 'POST',
      headers: { 'X-BRUCE-TOKEN': 'bruce-secret-token-01', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(65000)
    });
    const data = await r.json();
    res.status(r.ok ? 200 : 500).json(data);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /bruce/staging/status — etat staging_queue
router.get('/bruce/staging/status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ error: auth.error });
  const base = SUPABASE_URL.replace(/\/+$/, '');
  const hdrs = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, Accept: 'application/json' };
  try {
    const r = await fetch(base + '/staging_queue?select=status&limit=500', { headers: hdrs });
    const rows = await r.json();
    if (!Array.isArray(rows)) return res.status(500).json({ ok: false, error: 'Supabase error', detail: rows });
    const counts = {};
    for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
    res.json({ ok: true, total: rows.length, counts });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
