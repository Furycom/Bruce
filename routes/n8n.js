// routes/n8n.js — [1059] n8n Tier A routes
'use strict';
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');

const N8N_URL = process.env.N8N_API_URL || 'http://192.168.2.174:5678';
const N8N_API_KEY = process.env.N8N_API_KEY || 'n8n_api_bruce_bd1caf5b4aa74a228edd99c9bd43a4f8';

async function n8nFetch(path, options = {}) {
  const url = `${N8N_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-N8N-API-KEY': N8N_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`n8n ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
router.get('/bruce/n8n/health', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const healthRes = await fetch(`${N8N_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    res.json({ ok: true, status: healthRes.ok ? 'healthy' : 'unhealthy', n8n_url: N8N_URL });
  } catch (e) {
    console.error('[n8n.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/n8n/workflows', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const limit = req.query.limit || 100;
    let qs = `?limit=${limit}`;
    if (req.query.cursor) qs += `&cursor=${req.query.cursor}`;
    if (req.query.active !== undefined) qs += `&active=${req.query.active}`;
    const data = await n8nFetch(`/api/v1/workflows${qs}`);
    res.json({ ok: true, count: (data.data || []).length, workflows: data.data || data, nextCursor: data.nextCursor || null });
  } catch (e) {
    console.error('[n8n.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/n8n/workflows/:id', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}`);
    res.json({ ok: true, workflow: data });
  } catch (e) {
    console.error('[n8n.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.post('/bruce/n8n/workflows', async (req, res) => {
  const auth = validateBruceAuth(req, 'write');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const body = req.body || {};
    if (!body.settings) body.settings = {};
    if (!body.name) return res.status(400).json({ ok: false, error: 'Missing required field: name' });
    const data = await n8nFetch('/api/v1/workflows', { method: 'POST', body: JSON.stringify(body) });
    res.json({ ok: true, workflow: data });
  } catch (e) {
    console.error('[n8n.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.put('/bruce/n8n/workflows/:id', async (req, res) => {
  const auth = validateBruceAuth(req, 'write');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}`, { method: 'PUT', body: JSON.stringify(req.body || {}) });
    res.json({ ok: true, workflow: data });
  } catch (e) {
    console.error('[n8n.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/n8n/executions', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const limit = req.query.limit || 20;
    let qs = `?limit=${limit}`;
    if (req.query.cursor) qs += `&cursor=${req.query.cursor}`;
    if (req.query.workflowId) qs += `&workflowId=${req.query.workflowId}`;
    if (req.query.status) qs += `&status=${req.query.status}`;
    const data = await n8nFetch(`/api/v1/executions${qs}`);
    res.json({ ok: true, count: (data.data || []).length, executions: data.data || data, nextCursor: data.nextCursor || null });
  } catch (e) {
    console.error('[n8n.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.post('/bruce/n8n/workflows/:id/activate', async (req, res) => {
  const auth = validateBruceAuth(req, 'write');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const { active } = req.body || {};
    if (active === undefined) return res.status(400).json({ ok: false, error: 'Missing required field: active (true/false)' });
    const data = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(req.params.id)}/activate`, { method: 'POST', body: JSON.stringify({ active: !!active }) });
    res.json({ ok: true, workflow: data });
  } catch (e) {
    console.error('[n8n.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;