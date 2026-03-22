// routes/roadmap.js - [863] + [1061] Added GET/PATCH for bridge compatibility
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');

// --- GET /bruce/roadmap ---
router.get('/bruce/roadmap', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');
  const qs = [];
  if (req.query.status) qs.push('status=eq.' + req.query.status);
  if (req.query.priority) qs.push('priority=eq.' + req.query.priority);
  qs.push('order=priority.asc,id.desc');
  qs.push('limit=100');

  try {
    const r = await fetchWithTimeout(
      base + '/roadmap?' + qs.join('&'),
      { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
      8000
    );
    if (!r.ok) return res.status(r.status).json({ ok: false, error: 'Supabase GET failed' });
    const data = await r.json();
    return res.json({ ok: true, count: data.length, tasks: data });
  } catch (e) { console.error('[roadmap.js] GET /bruce/roadmap failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// --- GET /bruce/roadmap/:id ---
router.get('/bruce/roadmap/:id', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const id = parseInt(req.params.id, 10);
  if (!id || id <= 0) return res.status(400).json({ ok: false, error: 'Invalid id' });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');

  try {
    const r = await fetchWithTimeout(
      base + '/roadmap?id=eq.' + id,
      { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
      8000
    );
    if (!r.ok) return res.status(r.status).json({ ok: false, error: 'Supabase GET failed' });
    const data = await r.json();
    if (!data || data.length === 0) return res.status(404).json({ ok: false, error: 'Task not found' });
    return res.json({ ok: true, task: data[0] });
  } catch (e) { console.error('[roadmap.js] GET /bruce/roadmap/:id failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// --- PATCH /bruce/roadmap/:id ---
router.patch('/bruce/roadmap/:id', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const id = parseInt(req.params.id, 10);
  if (!id || id <= 0) return res.status(400).json({ ok: false, error: 'Invalid id' });

  const body = req.body || {};
  const patch = {};
  if (body.status) patch.status = body.status;
  if (body.evidence) patch.evidence = body.evidence;
  if (body.notes) patch.notes = body.notes;
  if (Object.keys(patch).length === 0) return res.status(400).json({ ok: false, error: 'Nothing to update' });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');

  try {
    const r = await fetchWithTimeout(
      base + '/roadmap?id=eq.' + id,
      {
        method: 'PATCH',
        headers: {
          'apikey': key, 'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json', 'Prefer': 'return=representation'
        },
        body: JSON.stringify(patch)
      },
      8000
    );
    if (!r.ok) {
      const errText = await r.text().catch(() => 'unknown');
      return res.status(r.status).json({ ok: false, error: 'Supabase PATCH failed: ' + errText });
    }
    const data = await r.json();
    if (!data || data.length === 0) return res.status(404).json({ ok: false, error: 'Task not found' });
    return res.json({ ok: true, task: data[0] });
  } catch (e) { console.error('[roadmap.js] PATCH /bruce/roadmap/:id failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// --- POST /bruce/roadmap/done ---
router.post('/bruce/roadmap/done', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { id, evidence } = req.body || {};
  if (!id || typeof id !== 'number' || id <= 0) return res.status(400).json({ ok: false, error: 'id required' });
  if (!evidence || typeof evidence !== 'string' || evidence.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'evidence required. Trigger [847].' });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');

  try {
    const r = await fetchWithTimeout(
      base + '/roadmap?id=eq.' + id,
      {
        method: 'PATCH',
        headers: {
          'apikey': key, 'Authorization': 'Bearer ' + key,
          'Content-Type': 'application/json', 'Prefer': 'return=representation'
        },
        body: JSON.stringify({ status: 'done', evidence: evidence.trim() })
      },
      8000
    );
    if (!r.ok) {
      const errText = await r.text().catch(() => 'unknown');
      return res.status(r.status).json({ ok: false, error: 'Supabase PATCH failed: ' + errText });
    }
    const data = await r.json();
    if (!data || data.length === 0) return res.status(404).json({ ok: false, error: 'Task not found' });
    return res.json({ ok: true, task: { id: data[0].id, step_name: data[0].step_name, status: data[0].status, evidence: data[0].evidence } });
  } catch (e) { console.error('[roadmap.js] POST /bruce/roadmap/done failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;