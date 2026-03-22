// routes/prometheus.js — [1059] Prometheus Tier A routes
'use strict';
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://192.168.2.154:9090';

async function promFetch(path) {
  const url = `${PROMETHEUS_URL}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Prometheus ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

router.get('/bruce/prometheus/query', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    if (!req.query.query) return res.status(400).json({ ok: false, error: 'Missing query parameter' });
    let qs = `?query=${encodeURIComponent(req.query.query)}`;
    if (req.query.time) qs += `&time=${encodeURIComponent(req.query.time)}`;
    const data = await promFetch(`/api/v1/query${qs}`);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/prometheus/query_range', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    if (!req.query.query) return res.status(400).json({ ok: false, error: 'Missing query parameter' });
    let qs = `?query=${encodeURIComponent(req.query.query)}`;
    if (req.query.start) qs += `&start=${encodeURIComponent(req.query.start)}`;
    if (req.query.end) qs += `&end=${encodeURIComponent(req.query.end)}`;
    if (req.query.step) qs += `&step=${encodeURIComponent(req.query.step)}`;
    const data = await promFetch(`/api/v1/query_range${qs}`);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/prometheus/metrics', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await promFetch('/api/v1/label/__name__/values');
    res.json({ ok: true, count: (data.data || []).length, metrics: data.data || [] });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/prometheus/targets', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    let qs = req.query.state ? `?state=${encodeURIComponent(req.query.state)}` : '';
    const data = await promFetch(`/api/v1/targets${qs}`);
    res.json({ ok: true, data });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/prometheus/labels', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await promFetch('/api/v1/labels');
    res.json({ ok: true, labels: data.data || data });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/prometheus/labels/:name/values', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await promFetch(`/api/v1/label/${encodeURIComponent(req.params.name)}/values`);
    res.json({ ok: true, values: data.data || data });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/prometheus/metadata', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    let qs = req.query.metric ? `?metric=${encodeURIComponent(req.query.metric)}` : '';
    const data = await promFetch(`/api/v1/metadata${qs}`);
    res.json({ ok: true, metadata: data.data || data });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/prometheus/build_info', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await promFetch('/api/v1/status/buildinfo');
    res.json({ ok: true, build: data.data || data });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/prometheus/runtime_info', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await promFetch('/api/v1/status/runtimeinfo');
    res.json({ ok: true, runtime: data.data || data });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/prometheus/targets/:pool', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await promFetch('/api/v1/targets');
    const activeTargets = (data.data && data.data.activeTargets) || [];
    const poolTargets = activeTargets.filter(t => t.scrapePool === req.params.pool || (t.labels && t.labels.job === req.params.pool));
    res.json({ ok: true, count: poolTargets.length, targets: poolTargets });
  } catch (e) {
    console.error('[prometheus.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;