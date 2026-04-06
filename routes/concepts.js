'use strict';
const express = require('express');
const router = express.Router();
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');

/**
 * Facade semantique BRUCE - Phase 2 (S1435)
 * Wraps les 4 vues SQL deployees en S1432:
 *   project_summary, knowledge_status, open_problems, recent_activity
 * 
 * Ces endpoints presentent les donnees en CONCEPTS (projets, connaissances, problemes)
 * au lieu de tables SQL brutes. Alignes avec la vision de Yann (dossiers/projets).
 */

const SUPA_BASE = SUPABASE_URL; // already contains /rest/v1

async function fetchView(viewName, query) {
  const url = `${SUPA_BASE}/${viewName}${query || ''}`;
  const resp = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase view ${viewName} failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

// GET /bruce/concepts/projects — Vue projets avec compteurs
router.get('/projects', async (req, res) => {
  try {
    const data = await fetchView('project_summary');
    res.json({
      ok: true,
      description: 'Projets BRUCE avec compteurs KB, lessons et taches par projet',
      count: data.length,
      projects: data,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /bruce/concepts/knowledge — Etat des connaissances par lifecycle
router.get('/knowledge', async (req, res) => {
  try {
    const data = await fetchView('knowledge_status');
    res.json({
      ok: true,
      description: 'Distribution des connaissances par statut de cycle de vie',
      statuses: data,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /bruce/concepts/problems — Problemes ouverts
router.get('/problems', async (req, res) => {
  try {
    const data = await fetchView('open_problems');
    res.json({
      ok: true,
      description: 'Problemes ouverts necessitant attention',
      count: data.length,
      problems: data,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /bruce/concepts/activity — Activite recente
router.get('/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const data = await fetchView('recent_activity', `?limit=${limit}&order=created_at.desc`);
    res.json({
      ok: true,
      description: 'Activite recente du systeme BRUCE',
      count: data.length,
      activity: data,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /bruce/concepts — Index de tous les endpoints concepts
router.get('/', (req, res) => {
  res.json({
    ok: true,
    description: 'Facade semantique BRUCE — endpoints concepts',
    endpoints: {
      '/bruce/concepts/projects': 'Vue projets avec compteurs (KB, lessons, taches)',
      '/bruce/concepts/knowledge': 'Distribution connaissances par lifecycle_status',
      '/bruce/concepts/problems': 'Problemes ouverts necessitant attention',
      '/bruce/concepts/activity': 'Activite recente (audit_log, ?limit=N)',
    },
    source: 'S1432 vues SQL + S1435 routes gateway',
  });
});

module.exports = router;
