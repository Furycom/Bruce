// routes/roadmap.js — [863] Endpoint POST /bruce/roadmap/done
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');

// --- POST /bruce/roadmap/done ---
// Marks a roadmap task as done with required evidence.
// Body: { id: number, evidence: string }
// Respects trigger [847] which requires non-empty evidence for done transition.
/**
 * Handles POST /bruce/roadmap/done.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.post('/bruce/roadmap/done', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { id, evidence } = req.body || {};

  if (!id || typeof id !== 'number' || id <= 0) {
    return res.status(400).json({ ok: false, error: 'id (positive integer) is required.' });
  }
  if (!evidence || typeof evidence !== 'string' || evidence.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'evidence (non-empty string) is required. Trigger [847] demands it.' });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');
  const hSupa = {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    const r = await fetchWithTimeout(
      base + '/roadmap?id=eq.' + id,
      {
        method: 'PATCH',
        headers: hSupa,
        body: JSON.stringify({ status: 'done', evidence: evidence.trim() })
      },
      8000
    );

    if (!r.ok) {
      const errText = await r.text().catch(() => 'unknown');
      return res.status(r.status || 500).json({ ok: false, error: 'Supabase PATCH failed: ' + errText });
    }

    const data = await r.json().catch(() => []);
    if (!data || data.length === 0) {
      return res.status(404).json({ ok: false, error: 'Task id=' + id + ' not found in roadmap.' });
    }

    return res.json({
      ok: true,
      task: { id: data[0].id, step_name: data[0].step_name, status: data[0].status, evidence: data[0].evidence }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
