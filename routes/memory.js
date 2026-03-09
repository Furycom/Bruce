'use strict';
const { Router } = require('express');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { validateBruceAuth } = require('../shared/auth');

const router = Router();

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
      ? body.tags.map(x => String(x || '').trim()).filter(Boolean)
      : [];

    const metadata = (body.metadata && typeof body.metadata === 'object')
      ? body.metadata
      : {};

    // Merge author + tags into metadata (columns don't exist on bruce_memory_journal)
    const enrichedMetadata = {
      ...metadata,
      ...(author ? { author } : {}),
      ...(tags.length ? { tags } : {}),
    };

    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key  = String(SUPABASE_KEY || '');

    if (!base) return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_URL missing)' });
    if (!key)  return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_KEY missing)' });

    const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
    const tableUrl = useRestV1
      ? base.replace(/\/rest\/v1$/, '') + '/rest/v1/bruce_memory_journal'
      : base + '/bruce_memory_journal';

    // Map to actual table schema: source, event_type, content, metadata, session_id
    const row = {
      source,
      event_type: channel || 'general',
      content,
      metadata: Object.keys(enrichedMetadata).length ? enrichedMetadata : null,
      session_id: body.session_id || null,
    };

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + key,
      'apikey': key,
      'Prefer': 'return=representation',
    };

    const response = await fetch(tableUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(row),
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(200).json({ ok: false, status: response.status, error: text || ('HTTP ' + response.status) });
    }

    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (e) {
      return res.status(200).json({ ok: false, status: 500, error: 'JSON parse error', raw: text });
    }

    const inserted = (Array.isArray(parsed) && parsed.length) ? parsed[0] : parsed;

    return res.status(200).json({ ok: true, inserted, timestamp: new Date().toISOString() });
  } catch (err) {
    return res.status(200).json({ ok: false, status: 500, error: err && err.message ? err.message : String(err) });
  }
});

module.exports = router;
