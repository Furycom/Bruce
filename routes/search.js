'use strict';
const express = require('express');
const { SUPABASE_URL, SUPABASE_KEY, EMBEDDER_URL } = require('../shared/config');
const { requireScope } = require('../shared/auth');

const router = express.Router();

/**
 * Handles POST / and proxies a scoped RAG search request through the embedder and Supabase RPC.
 * Expects body params { query, top_k?, threshold? } with requireScope('read') middleware and returns ranked search matches.
 * @param {import('express').Request} req - Express request containing search inputs in req.body.
 * @param {import('express').Response} res - Express response used to return validation errors or search results.
 * @returns {Promise<void>} Sends a JSON payload with search results, latency, and metadata.
 */
router.post('/', requireScope('read'), async (req, res) => {
  const start = Date.now();
  const { query, top_k = 5, threshold = 0.01 } = req.body || {};

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Missing or empty "query" field' });
  }

  const k = Math.max(1, Math.min(20, parseInt(top_k) || 5));
  const thresh = Math.max(0, Math.min(1, parseFloat(threshold) || 0.01));
  const qText = query.trim().slice(0, 4000);

  try {
    // ── Step 1: Get embedding from embedder ──
    const embedRes = await fetch(`${EMBEDDER_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: qText }),
      signal: AbortSignal.timeout(8000),
    });
    if (!embedRes.ok) {
      const detail = await embedRes.text().catch(() => '');
      return res.status(502).json({ ok: false, error: 'Embedder error', detail });
    }
    const embedData = await embedRes.json();

    // embedder returns array of objects with .embedding, or array of arrays
    let vec;
    if (Array.isArray(embedData) && embedData.length > 0) {
      vec = embedData[0].embedding || embedData[0];
    } else if (embedData.embedding) {
      vec = embedData.embedding;
    }
    if (!Array.isArray(vec) || vec.length === 0) {
      return res.status(502).json({ ok: false, error: 'Embedder returned invalid embedding' });
    }

    const qvec = `[${vec.join(',')}]`;

    // ── Step 2: Call pgvector hybrid search RPC ──
    const rpcUrl = `${SUPABASE_URL}/rpc/bruce_rag_hybrid_search_text`;
    const rpcRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ qtext: qText, qvec: qvec, k: k }),
      signal: AbortSignal.timeout(8000),
    });
    if (!rpcRes.ok) {
      const detail = await rpcRes.text().catch(() => '');
      return res.status(502).json({ ok: false, error: 'Supabase RPC error', detail });
    }
    const results = await rpcRes.json();

    // ── Step 3: Filter by threshold and return ──
    const filtered = results.filter(r => (r.hybrid_score || r.cos_sim || 0) >= thresh);

    res.json({
      ok: true,
      query: qText,
      top_k: k,
      threshold: thresh,
      count: filtered.length,
      elapsed_ms: Date.now() - start,
      results: filtered.map(r => ({
        chunk_id: r.chunk_id,
        doc_id: r.doc_id,
        score: r.hybrid_score || r.cos_sim || 0,
        preview: (r.preview || '').slice(0, 500),
      })),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ ok: false, error: 'Search timeout' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
