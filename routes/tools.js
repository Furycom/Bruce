'use strict';
const { Router } = require('express');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');

const router = Router();

router.get('/tools', (req, res) => {
  res.json({
    tools: [
      {
        name: 'echo',
        description: 'Echo back the provided text payload.',
        endpoint: '/tools/echo',
        method: 'POST',
      },
      {
        name: 'supabase.exec_sql',
        description:
          'Execute a SQL string via Supabase RPC exec_sql (dangerous, use carefully).',
        endpoint: '/tools/supabase/exec-sql',
        method: 'POST',
      },
      {
        name: 'manual.get_page',
        description:
          'Return the raw markdown content of a documentation page from the homelab manual.',
        endpoint: '/manual/page',
        method: 'GET',
        params: ['path'],
      },
      {
        name: 'manual.search',
        description:
          'Search the homelab manual markdown files for a text query and return matching snippets.',
        endpoint: '/manual/search',
        method: 'GET',
        params: ['query'],
      },
      {
        name: 'bruce.chat',
        description:
          'Chat endpoint for Bruce, logs conversation to Supabase and calls an OpenAI-compatible LLM backend.',
        endpoint: '/chat',
        method: 'POST',
      },
    ],
    timestamp: new Date().toISOString(),
  });
});

router.post('/tools/echo', (req, res) => {
  res.json({
    ok: true,
    input: req.body || null,
    timestamp: new Date().toISOString(),
  });
});

router.post('/tools/supabase/exec-sql', async (req, res) => {
  try {
    const sql = String((req.body && req.body.sql) ? req.body.sql : '').trim().replace(/;+\s*$/, '');
    if (!sql) {
      return res.status(400).json({ ok: false, status: 400, error: 'Missing sql' });
    }

    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key  = String(SUPABASE_KEY || '');

    if (!base) {
      return res.status(500).json({ ok: false, status: 500, error: 'Supabase not configured (SUPABASE_URL missing)' });
    }
    if (!key) {
      return res.status(500).json({ ok: false, status: 500, error: 'Supabase not configured (SUPABASE_KEY missing)' });
    }

    const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
    const rpcUrl = useRestV1
      ? `${base.replace(/\/rest\/v1$/, '')}/rest/v1/rpc/exec_sql`
      : `${base}/rpc/exec_sql`;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'apikey': key,
    };

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: sql }),
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(200).json({
        ok: false,
        status: response.status,
        error: text || `HTTP ${response.status}`,
      });
    }

    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (e) {
      return res.status(200).json({
        ok: false,
        status: response.status,
        error: `JSON parse error: ${e && e.message ? e.message : String(e)}`,
        raw: text,
      });
    }

    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed)
      ? parsed.data
      : parsed;

    return res.status(200).json({ ok: true, status: response.status, data });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      status: 500,
      error: err && err.message ? err.message : String(err),
    });
  }
});

module.exports = router;
