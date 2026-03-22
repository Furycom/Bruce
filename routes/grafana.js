// routes/grafana.js — [1059] Grafana Tier A routes
'use strict';
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');

const GRAFANA_URL = process.env.GRAFANA_URL || 'http://192.168.2.154:3001';
const GRAFANA_TOKEN = process.env.GRAFANA_SA_TOKEN || 'REPLACE_WITH_ENV_VAR';

async function grafanaFetch(path, options = {}) {
  const url = `${GRAFANA_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GRAFANA_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Grafana ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
router.get('/bruce/grafana/dashboards', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const query = req.query.query || '';
    const type_ = req.query.type || 'dash-db';
    const limit = req.query.limit || 100;
    const data = await grafanaFetch(`/api/search?query=${encodeURIComponent(query)}&type=${type_}&limit=${limit}`);
    res.json({ ok: true, count: data.length, dashboards: data });
  } catch (e) {
    console.error('[grafana.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/grafana/dashboards/:uid', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await grafanaFetch(`/api/dashboards/uid/${encodeURIComponent(req.params.uid)}`);
    res.json({ ok: true, dashboard: data });
  } catch (e) {
    console.error('[grafana.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/grafana/dashboards/:uid/panels', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await grafanaFetch(`/api/dashboards/uid/${encodeURIComponent(req.params.uid)}`);
    const panels = (data.dashboard && data.dashboard.panels) || [];
    const panelInfo = panels.map(p => ({
      id: p.id, title: p.title, type: p.type,
      targets: p.targets || [], datasource: p.datasource || null,
    }));
    res.json({ ok: true, count: panelInfo.length, panels: panelInfo });
  } catch (e) {
    console.error('[grafana.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/grafana/datasources', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await grafanaFetch('/api/datasources');
    res.json({ ok: true, count: data.length, datasources: data });
  } catch (e) {
    console.error('[grafana.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/grafana/datasources/:id', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await grafanaFetch(`/api/datasources/${encodeURIComponent(req.params.id)}`);
    res.json({ ok: true, datasource: data });
  } catch (e) {
    console.error('[grafana.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/grafana/alerts', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await grafanaFetch('/api/ruler/grafana/api/v1/rules');
    res.json({ ok: true, alerts: data });
  } catch (e) {
    console.error('[grafana.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/grafana/annotations', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const limit = req.query.limit || 100;
    let qs = `?limit=${limit}`;
    if (req.query.from) qs += `&from=${req.query.from}`;
    if (req.query.to) qs += `&to=${req.query.to}`;
    if (req.query.dashboardId) qs += `&dashboardId=${req.query.dashboardId}`;
    if (req.query.tags) qs += `&tags=${encodeURIComponent(req.query.tags)}`;
    const data = await grafanaFetch(`/api/annotations${qs}`);
    res.json({ ok: true, count: data.length, annotations: data });
  } catch (e) {
    console.error('[grafana.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/grafana/folders', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await grafanaFetch('/api/folders');
    res.json({ ok: true, count: data.length, folders: data });
  } catch (e) {
    console.error('[grafana.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;