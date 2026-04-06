/**
 * tree.js — Vue arborescente logique des données BRUCE [1227]
 * GET /bruce/tree — retourne l'arborescence /canon, /validees, /brutes, /projets, etc.
 * Vision KB#1242 S1318.
 */
const express = require('express');
const router = express.Router();
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { validateBruceAuth } = require('../shared/auth');

// Helper fetch Supabase — SUPABASE_URL already contains /rest/v1
async function supaFetch(path) {
  const base = SUPABASE_URL.replace(/\/+$/, '');
  const url = `${base}/${path}`;
  const r = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!r.ok) return [];
  return r.json();
}

router.get('/bruce/tree', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });

  try {
    const verbose = req.query.verbose === 'true';
    const select_fields = verbose
      ? 'id,question,category,subcategory,is_canon,bootstrap_critical,project_scope,screensaver_reviewed_at'
      : 'id,question,subcategory,is_canon,bootstrap_critical,project_scope';

    const allKB = await supaFetch(
      `knowledge_base?select=${select_fields}&archived=eq.false&order=id.asc`
    );

    const [lessons, roadmap] = await Promise.all([
      supaFetch('lessons_learned?select=id,project_scope,screensaver_reviewed_at&archived=eq.false'),
      supaFetch('roadmap?select=id,status&order=id.asc'),
    ]);

    const tree = {};

    // /canon
    const canonKBs = allKB.filter(k => k.is_canon);
    const canonBySubcat = {};
    for (const k of canonKBs) {
      const sub = k.subcategory || 'uncategorized';
      if (!canonBySubcat[sub]) canonBySubcat[sub] = [];
      canonBySubcat[sub].push(verbose ? k : { id: k.id, q: k.question });
    }
    const canonChildren = {};
    for (const s of Object.keys(canonBySubcat).sort()) {
      canonChildren[s] = { count: canonBySubcat[s].length, items: canonBySubcat[s] };
    }
    tree['/canon'] = {
      description: 'Connaissances immuables validées par Opus ou Yann',
      total: canonKBs.length,
      bootstrap_critical: canonKBs.filter(k => k.bootstrap_critical).length,
      children: canonChildren
    };

    // /validees
    const validees = allKB.filter(k => !k.is_canon && k.screensaver_reviewed_at);
    tree['/validees'] = {
      description: 'KB validées par le screensaver, candidates canon',
      total: validees.length
    };
    if (verbose) tree['/validees'].items = validees;

    // /brutes
    const brutes = allKB.filter(k => !k.is_canon && !k.screensaver_reviewed_at);
    tree['/brutes'] = {
      description: 'KB non encore auditées par le screensaver',
      total: brutes.length
    };
    if (verbose) tree['/brutes'].items = brutes;

    // /projets
    const scopeMap = {};
    for (const k of allKB) {
      const scope = k.project_scope || 'homelab';
      if (!scopeMap[scope]) scopeMap[scope] = { kb: 0, kb_canon: 0, lessons: 0 };
      scopeMap[scope].kb++;
      if (k.is_canon) scopeMap[scope].kb_canon++;
    }
    for (const l of lessons) {
      const scope = l.project_scope || 'homelab';
      if (!scopeMap[scope]) scopeMap[scope] = { kb: 0, kb_canon: 0, lessons: 0 };
      scopeMap[scope].lessons++;
    }
    tree['/projets'] = {
      description: 'Un sous-dossier par projet',
      scopes: scopeMap
    };

    // /infrastructure
    tree['/infrastructure'] = {
      description: 'Tables système internes BRUCE',
      roadmap: {
        total: roadmap.length,
        done: roadmap.filter(r => r.status === 'done').length,
        todo: roadmap.filter(r => r.status === 'todo').length,
        doing: roadmap.filter(r => r.status === 'doing').length,
      },
      lessons_learned: { total: lessons.length }
    };

    // /graphe
    tree['/graphe'] = {
      description: 'LightRAG — couche relationnelle transversale',
      note: 'Alimenté par le screensaver, interrogé au bootstrap via Context Engine'
    };

    res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      summary: {
        kb_total: allKB.length,
        kb_canon: canonKBs.length,
        kb_validees: validees.length,
        kb_brutes: brutes.length,
        lessons_total: lessons.length,
      },
      tree
    });
  } catch (err) {
    console.error('[tree] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
