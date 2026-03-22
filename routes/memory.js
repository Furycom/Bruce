'use strict';
const { Router } = require('express');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { validateBruceAuth } = require('../shared/auth');
const { fetchWithTimeout } = require('../shared/fetch-utils');

const router = Router();

// --- GET /bruce/memory ---
// Returns memory entities from the Memory MCP knowledge graph proxy
// Since Memory MCP stores in a JSON file, we proxy via the MCP server on Windows.
// Fallback: return memory_events from Supabase.
router.get('/bruce/memory', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');

  try {
    const r = await fetchWithTimeout(
      base + '/memory_events?order=created_at.desc&limit=100',
      { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
      8000
    );
    if (!r.ok) return res.status(r.status).json({ ok: false, error: 'Supabase GET failed' });
    const data = await r.json();
    return res.json({ ok: true, source: 'memory_events', count: data.length, entries: data });
  } catch (e) { console.error('[memory.js] GET /bruce/memory failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// --- GET /bruce/memory/search ---
router.get('/bruce/memory/search', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  const query = req.query.query || '';
  if (!query) return res.status(400).json({ ok: false, error: 'query parameter required' });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');

  try {
    const r = await fetchWithTimeout(
      base + '/memory_events?or=(source.ilike.*' + encodeURIComponent(query) + '*,event_type.ilike.*' + encodeURIComponent(query) + '*)&order=created_at.desc&limit=50',
      { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
      8000
    );
    if (!r.ok) return res.status(r.status).json({ ok: false, error: 'Supabase search failed' });
    const data = await r.json();
    return res.json({ ok: true, query, count: data.length, entries: data });
  } catch (e) { console.error('[memory.js] GET /bruce/memory/search failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// --- POST /bruce/memory/append (existing) ---
router.post('/bruce/memory/append', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const body = req.body || {};
    const source  = String(body.source  || '').trim();
    const author  = String(body.author  || '').trim();
    const channel = String(body.channel || '').trim();
    const content = String(body.content || '').trim();

    if (!source)  return res.status(400).json({ ok: false, error: 'Missing source' });
    if (!content) return res.status(400).json({ ok: false, error: 'Missing content' });

    const tags = Array.isArray(body.tags)
      ? body.tags.map(x => String(x || '').trim()).filter(Boolean) : [];
    const metadata = (body.metadata && typeof body.metadata === 'object') ? body.metadata : {};
    const enrichedMetadata = { ...metadata, ...(author ? { author } : {}), ...(tags.length ? { tags } : {}) };

    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key  = String(SUPABASE_KEY || '');
    if (!base) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
    if (!key)  return res.status(500).json({ ok: false, error: 'Supabase not configured' });

    const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
    const tableUrl = useRestV1
      ? base.replace(/\/rest\/v1$/, '') + '/rest/v1/memory_events'
      : base + '/memory_events';

    const row = {
      source,
      event_type: channel || 'general',
      content,
      metadata: Object.keys(enrichedMetadata).length ? enrichedMetadata : null,
      session_id: body.session_id || null,
    };

    const response = await fetch(tableUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Authorization': 'Bearer ' + key, 'apikey': key, 'Prefer': 'return=representation',
      },
      body: JSON.stringify(row),
    });

    const text = await response.text();
    if (!response.ok) return res.status(response.status).json({ ok: false, error: text || ('HTTP ' + response.status) });

    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; }
    catch (e) { console.error('[memory.js] JSON parse error:', e.message);
      return res.status(500).json({ ok: false, error: 'JSON parse error' });
    }

    const inserted = (Array.isArray(parsed) && parsed.length) ? parsed[0] : parsed;
    return res.json({ ok: true, inserted, timestamp: new Date().toISOString() });
  } catch (err) { console.error('[memory.js] POST /bruce/memory/append failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;