'use strict';
/**
 * routes/canon.js — S1314 [1211]
 * POST /bruce/canon/promote  — promouvoir une KB is_canon=true
 * POST /bruce/canon/demote   — rétrograder une KB (réservé Yann)
 * GET  /bruce/canon/list     — lister les KB canon actives
 */
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');

function supaHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  };
}

// ── GET /bruce/canon/list ─────────────────────────────────────────────────────
router.get('/bruce/canon/list', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const url = base + '/knowledge_base?is_canon=eq.true&archived=eq.false&select=id,question,category,subcategory,canon_promoted_at,canon_promoted_by,bootstrap_critical&order=id.asc';

  try {
    const resp = await fetchWithTimeout(url, { method: 'GET', headers: supaHeaders() }, 10000);
    const data = await resp.json();
    return res.json({ ok: true, count: Array.isArray(data) ? data.length : 0, canon: data });
  } catch (err) {
    console.error('[CANON] list error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /bruce/canon/promote ─────────────────────────────────────────────────
// Body: { id: number, promoted_by?: string }
router.post('/bruce/canon/promote', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { id, promoted_by } = req.body || {};
  if (!id || typeof id !== 'number') {
    return res.status(400).json({ ok: false, error: 'id (number) requis' });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const url = base + '/knowledge_base?id=eq.' + id + '&is_canon=eq.false&archived=eq.false';
  const promoter = promoted_by || 'claude';

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: supaHeaders(),
      body: JSON.stringify({
        is_canon: true,
        canon_promoted_at: new Date().toISOString(),
        canon_promoted_by: promoter,
      }),
    }, 10000);

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ ok: false, error: 'KB id=' + id + ' non trouvée, déjà canon, ou archivée' });
    }
    console.log('[CANON] Promoted KB id=' + id + ' by=' + promoter);
    return res.json({ ok: true, promoted: data[0] });
  } catch (err) {
    console.error('[CANON] promote error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /bruce/canon/demote ──────────────────────────────────────────────────
// Body: { id: number, reason?: string }
router.post('/bruce/canon/demote', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { id, reason } = req.body || {};
  if (!id || typeof id !== 'number') {
    return res.status(400).json({ ok: false, error: 'id (number) requis' });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const url = base + '/knowledge_base?id=eq.' + id + '&is_canon=eq.true';

  try {
    const resp = await fetchWithTimeout(url, {
      method: 'PATCH',
      headers: supaHeaders(),
      body: JSON.stringify({
        is_canon: false,
        canon_promoted_at: null,
        canon_promoted_by: null,
      }),
    }, 10000);

    const data = await resp.json();
    if (!Array.isArray(data) || data.length === 0) {
      return res.status(404).json({ ok: false, error: 'KB id=' + id + ' non trouvée ou pas canon' });
    }
    console.log('[CANON] Demoted KB id=' + id + ' reason=' + (reason || 'none'));
    return res.json({ ok: true, demoted: data[0] });
  } catch (err) {
    console.error('[CANON] demote error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
