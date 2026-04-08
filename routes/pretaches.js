// routes/pretaches.js — S1452 Pre-taches: feedback asynchrone Yann -> Opus
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const router = Router();

// POST /bruce/pretaches — create a pre-task
router.post('/bruce/pretaches', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { message, card, section, project_scope } = req.body || {};
  if (!message || !card) {
    return res.status(400).json({ ok: false, error: 'message and card are required' });
  }

  const row = {
    message: String(message).slice(0, 5000),
    card: String(card).slice(0, 100),
    section: section ? String(section).slice(0, 100) : null,
  };
  if (project_scope) row.project_scope = String(project_scope).slice(0, 100);

  try {
    const r = await fetch(`${SUPABASE_URL}/pretaches`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(row),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data });
    res.json({ ok: true, pretache: Array.isArray(data) ? data[0] : data });
  } catch (e) {
    console.error('[pretaches] POST error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /bruce/pretaches — list pre-tasks (default: new only)
router.get('/bruce/pretaches', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const status = req.query.status || 'new';
  const filter = status === 'all' ? '' : `&status=eq.${status}`;

  try {
    const r = await fetch(
      `${SUPABASE_URL}/pretaches?select=id,message,card,section,status,linked_task_id,opus_response,project_scope,created_at,processed_at&order=created_at.desc&limit=100${filter}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data });
    res.json({ ok: true, pretaches: data, count: data.length });
  } catch (e) {
    console.error('[pretaches] GET error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
