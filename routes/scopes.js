// routes/scopes.js — [1226] S1338 Opus: Endpoint GET /bruce/scopes
// Retourne la distribution des project_scope et le registre de l'auto-classeur
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { PROJECT_REGISTRY } = require('../shared/scope-classifier');
const {
  SUPABASE_URL,
  SUPABASE_KEY,
} = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');

router.get('/bruce/scopes', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  try {
    // Fetch KB distribution
    const kbRes = await fetchWithTimeout(
      base + '/knowledge_base?select=project_scope,id&archived=not.is.true&limit=5000',
      { headers: hSupa }, 8000
    );
    const kbData = await kbRes.json();
    const kbScopes = {};
    for (const row of kbData) {
      const s = row.project_scope || 'NULL';
      kbScopes[s] = (kbScopes[s] || 0) + 1;
    }

    // Fetch lessons distribution
    const lRes = await fetchWithTimeout(
      base + '/lessons_learned?select=project_scope,id&archived=not.is.true&limit=10000',
      { headers: hSupa }, 8000
    );
    const lData = await lRes.json();
    const lScopes = {};
    for (const row of lData) {
      const s = row.project_scope || 'NULL';
      lScopes[s] = (lScopes[s] || 0) + 1;
    }

    res.json({
      ok: true,
      registry: PROJECT_REGISTRY.map(p => ({ scope: p.scope, keywords_count: p.keywords.length })),
      distribution: {
        knowledge_base: kbScopes,
        lessons_learned: lScopes,
      },
      totals: {
        kb: kbData.length,
        lessons: lData.length,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
