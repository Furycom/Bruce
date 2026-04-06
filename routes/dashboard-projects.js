// routes/dashboard-projects.js — [1440] Route dashboard projets v3
// Utilise la vue SQL view_dashboard_projects (une seule requete)
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const router = Router();

router.get('/bruce/dashboard-projects', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');

  try {
    const resp = await fetch(base + '/view_dashboard_projects?order=id', {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(resp.status).json({ ok: false, error: err });
    }

    const projects = await resp.json();
    res.json({ ok: true, projects, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error('[dashboard-projects] error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
