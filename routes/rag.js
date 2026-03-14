// routes/rag.js — [773] C7 REFONTE
// Routes: /bruce/rag/metrics, /bruce/rag/search, /bruce/tool-check,
//         /bruce/rag/context, /tools/rag/search, /bruce/preflight
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY, EMBEDDER_URL } = require('../shared/config');
const { bruceClampInt } = require('../shared/helpers');
const { fetchWithTimeout } = require('../shared/fetch-utils');
const { bruceClientIp } = require('../shared/llm-profiles');

const BRUCE_RAG_MAX_Q_CHARS = bruceClampInt(process.env.BRUCE_RAG_MAX_Q_CHARS, 4000, 256, 20000);
const BRUCE_RAG_EMBED_TIMEOUT_MS = bruceClampInt(process.env.BRUCE_RAG_EMBED_TIMEOUT_MS, 8000, 1000, 60000);
const BRUCE_RAG_SUPABASE_TIMEOUT_MS = bruceClampInt(process.env.BRUCE_RAG_SUPABASE_TIMEOUT_MS, 8000, 1000, 60000);
const BRUCE_RAG_RATE_WINDOW_MS = bruceClampInt(process.env.BRUCE_RAG_RATE_WINDOW_MS, 10000, 1000, 600000);
const BRUCE_RAG_RATE_MAX = bruceClampInt(process.env.BRUCE_RAG_RATE_MAX, 30, 1, 1000);


const BRUCE_RAG_METRICS = {
  started_at: new Date().toISOString(),
  rate_limited: 0,
  search: { calls: 0, ok: 0, err: 0, last_ms: null, avg_ms: null, total_ms: 0, last_error: null },
  context:{ calls: 0, ok: 0, err: 0, last_ms: null, avg_ms: null, total_ms: 0, last_error: null }
};

/**
 * Internal helper function `bruceRagMetricOk`.
 * @param {any} name - Function input parameter.
 * @param {any} ms - Function input parameter.
 * @returns {any} Computed helper result.
 */
function bruceRagMetricOk(name, ms) {
  const m = BRUCE_RAG_METRICS[name];
  if (!m) return;
  m.ok += 1;
  m.last_ms = ms;
  m.total_ms += ms;
  m.avg_ms = Math.round(m.total_ms / Math.max(1, m.ok));
  m.last_error = null;
}

/**
 * Internal helper function `bruceRagMetricErr`.
 * @param {any} name - Function input parameter.
 * @param {any} ms - Function input parameter.
 * @param {any} err - Function input parameter.
 * @returns {any} Computed helper result.
 */
function bruceRagMetricErr(name, ms, err) {
  const m = BRUCE_RAG_METRICS[name];
  if (!m) return;
  m.err += 1;
  m.last_ms = ms;
  m.last_error = String(err || "").slice(0, 400);
}

/**
 * Internal helper function `__ragRate`.
 * @param {any} ( - Function input parameter.
 * @returns {any} Computed helper result.
 */
const __ragRate = (() => {
  const m = new Map();
  return {
    check(key) {
      const now = Date.now();
      const rec = m.get(key);
      if (!rec || now >= rec.reset_at) {
        const r = { count: 1, reset_at: now + BRUCE_RAG_RATE_WINDOW_MS };
        m.set(key, r);
        return { ok: true, retry_after_ms: 0 };
      }
      rec.count += 1;
      if (rec.count > BRUCE_RAG_RATE_MAX) {
        return { ok: false, retry_after_ms: Math.max(1, rec.reset_at - now) };
      }
      return { ok: true, retry_after_ms: 0 };
    }
  };
})();

/**
 * Internal helper function `bruceRagRateLimitOr429`.
 * @param {any} req - Function input parameter.
 * @param {any} res - Function input parameter.
 * @returns {any} Computed helper result.
 */
function bruceRagRateLimitOr429(req, res) {
  const ip = bruceClientIp(req);
  const r = __ragRate.check(ip);
  if (!r.ok) {
    BRUCE_RAG_METRICS.rate_limited += 1;
    res.setHeader("Retry-After", String(Math.ceil(r.retry_after_ms / 1000)));
    res.status(429).json({ ok: false, error: "Rate limited", retry_after_ms: r.retry_after_ms });
    return false;
  }
  return true;
}


// --- ROUTE HANDLERS ---

// GET /bruce/rag/metrics
/**
 * Handles GET /bruce/rag/metrics.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {void} Sends an HTTP response for the endpoint.
 */
router.get("/bruce/rag/metrics", (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });
  return res.json({ ok: true, metrics: BRUCE_RAG_METRICS });
});

// POST /bruce/rag/search

// POST /bruce/rag/search
/**
 * Handles POST /bruce/rag/search.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends an HTTP response for the endpoint.
 */
router.post("/bruce/rag/search", async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });
  if (!bruceRagRateLimitOr429(req, res)) return;

  const t0 = Date.now();
  BRUCE_RAG_METRICS.search.calls += 1;

  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const q = String(body.q || body.query || "").trim();
    const k = Number.isFinite(Number(body.k)) ? Math.max(1, Math.min(50, Number(body.k))) : 10;

    if (!q) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "Missing q");
      return res.status(400).json({ ok: false, error: "Missing q" });
    }
    if (q.length > BRUCE_RAG_MAX_Q_CHARS) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "q too large");
      return res.status(413).json({ ok: false, error: "Query too large", max_chars: BRUCE_RAG_MAX_Q_CHARS });
    }

    const baseEmbed = String(EMBEDDER_URL || "").replace(/\/+$/, "");
    if (!baseEmbed) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "EMBEDDER_URL missing");
      return res.status(500).json({ ok: false, error: "Embedder not configured (EMBEDDER_URL missing)" });
    }

    let er;
    try {
      er = await fetchWithTimeout(baseEmbed + "/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: q, max_length: 256 }),
      }, BRUCE_RAG_EMBED_TIMEOUT_MS);
    } catch (e) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "embedder timeout/error: " + String(e && e.message ? e.message : e));
      return res.status(504).json({ ok: false, error: "Embedder timeout/error" });
    }

    const et = await er.text();
    if (!er.ok) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "embedder http " + String(er.status));
      return res.status(502).json({ ok: false, error: "Embedder error", status: er.status, detail: et.slice(0, 800) });
    }

    let ej;
    try { ej = JSON.parse(et); } catch (_) { ej = null; }
    if (!Array.isArray(ej) || !Array.isArray(ej[0])) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "embedder format");
      return res.status(502).json({ ok: false, error: "Embedder returned unexpected format", detail: et.slice(0, 800) });
    }

    const vec = ej[0].map((x) => Number(x));
    if (!vec.length) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "empty embedding");
      return res.status(502).json({ ok: false, error: "Empty embedding vector" });
    }

    const qvec = "[" + vec.join(",") + "]";

    const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
    const key  = String(SUPABASE_KEY || "");
    if (!base) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "SUPABASE_URL missing");
      return res.status(500).json({ ok: false, error: "Supabase not configured (SUPABASE_URL missing)" });
    }
    if (!key) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "SUPABASE_KEY missing");
      return res.status(500).json({ ok: false, error: "Supabase not configured (SUPABASE_KEY missing)" });
    }

    const candidates = [
      base + "/rpc/bruce_rag_hybrid_search_text",
      base.replace(/\/rest\/v1$/, "") + "/rest/v1/rpc/bruce_rag_hybrid_search_text",
    ];

    let r = null;
    let lastText = null;
    for (const candidate of candidates) {
      try {
        r = await fetchWithTimeout(candidate, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": key,
            "Authorization": "Bearer " + key,
          },
          body: JSON.stringify({ qtext: q, qvec, k }),
        }, BRUCE_RAG_SUPABASE_TIMEOUT_MS);
      } catch (e) {
        r = null
        lastText = null
        break
      }

      lastText = await r.text();
      if (r.ok) break;
      if (r.status !== 404) break;
    }

    if (!r || !r.ok) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "supabase rpc error");
      return res.status(r ? r.status : 504).send(lastText || "");
    }

    const ms = Date.now() - t0;
    bruceRagMetricOk("search", ms);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.send(lastText || "[]");
  } catch (e) {
    const ms = Date.now() - t0;
    bruceRagMetricErr("search", ms, String(e && e.message ? e.message : e));
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// POST /bruce/tool-check
/**
 * Handles POST /bruce/tool-check.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends an HTTP response for the endpoint.
 */
router.post("/bruce/tool-check", async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });

  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const action = String(body.action || "").trim();
    const topK = Math.max(1, Math.min(10, Number(body.top_k) || 3));

    if (!action) return res.status(400).json({ ok: false, error: "Missing action" });
    if (action.length > 500) return res.status(413).json({ ok: false, error: "Action too long (max 500 chars)" });

    // Embed the action query
    const baseEmbed = String(EMBEDDER_URL || "").replace(/\/+$/, "");
    if (!baseEmbed) return res.status(500).json({ ok: false, error: "Embedder not configured" });

    const er = await fetchWithTimeout(baseEmbed + "/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: "bruce_tools " + action, max_length: 256 }),
    }, 5000);

    if (!er.ok) return res.status(502).json({ ok: false, error: "Embedder error" });
    const et = await er.text();
    let ej; try { ej = JSON.parse(et); } catch(_) { ej = null; }
    if (!Array.isArray(ej) || !Array.isArray(ej[0])) return res.status(502).json({ ok: false, error: "Embedder format error" });

    const vec = ej[0].map(x => Number(x));
    const qvec = "[" + vec.join(",") + "]";

    // [744] Use dedicated bruce_tool_search RPC (vector search filtered to [TOOL] chunks)
    const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
    const key  = String(SUPABASE_KEY || "");
    if (!base || !key) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const rpcUrl = base.replace(/\/rest\/v1$/, "") + "/rest/v1/rpc/bruce_tool_search";
    const sr = await fetchWithTimeout(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key },
      body: JSON.stringify({ qvec: "[" + vec.join(",") + "]", k: topK }),
    }, 8000);

    if (!sr.ok) {
      const errText = await sr.text();
      return res.status(sr.status).json({ ok: false, error: "Search error", detail: errText.slice(0, 500) });
    }

    const results = JSON.parse(await sr.text());

    // Parse tool results
    const tools = [];
    for (const r of results) {
      const txt = r.tool_text || "";
      const lines = txt.split("\n");
      const nameLine = r.tool_name || lines[0].replace("[TOOL] ", "").trim();
      const description = lines.slice(2).join(" ").trim().substring(0, 200);
      const score = r.similarity || 0;

      tools.push({
        name: nameLine,
        score: Math.round(score * 1000) / 1000,
        how: description || nameLine,
      });
    }

    return res.json({
      ok: true,
      action,
      tools_found: tools,
      count: tools.length,
      threshold_hint: 0.6,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// POST /bruce/rag/context
/**
 * Handles POST /bruce/rag/context.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends an HTTP response for the endpoint.
 */
router.post("/bruce/rag/context", async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });
  if (!bruceRagRateLimitOr429(req, res)) return;

  const t0 = Date.now();
  BRUCE_RAG_METRICS.context.calls += 1;

  try {
    const body = req.body || {};
    const q = String(body.q || body.query || "").trim();
    const kRaw = parseInt(String((body.k === undefined || body.k === null) ? "10" : body.k), 10);
    const k = Math.max(1, Math.min(50, Number.isFinite(kRaw) ? kRaw : 10));

    if (!q) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "Missing q");
      return res.status(400).json({ ok: false, error: "Missing q" });
    }
    if (q.length > BRUCE_RAG_MAX_Q_CHARS) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "q too large");
      return res.status(413).json({ ok: false, error: "Query too large", max_chars: BRUCE_RAG_MAX_Q_CHARS });
    }

    const embedUrl = String(EMBEDDER_URL || "").replace(/\/+$/, "") + "/embed";

    let er;
    try {
      er = await fetchWithTimeout(embedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: q, max_length: 256 })
      }, BRUCE_RAG_EMBED_TIMEOUT_MS);
    } catch (e) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "embedder timeout/error: " + String(e && e.message ? e.message : e));
      return res.status(504).json({ ok: false, error: "Embedder timeout/error" });
    }

    const etxt = await er.text();
    if (!er.ok) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "embedder http " + String(er.status));
      return res.status(502).json({ ok: false, error: "Embedder error", status: er.status, body: etxt.slice(0, 2000) });
    }

    const ej = JSON.parse(etxt);
    const vec = Array.isArray(ej) ? ej[0] : (ej && ej.embeddings && ej.embeddings[0]);
    if (!Array.isArray(vec)) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "embedder format");
      return res.status(502).json({ ok: false, error: "Embedder returned unexpected format" });
    }

    const qvec = "[" + vec.map((x) => Number(x)).join(",") + "]";

    const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
    const key  = String(SUPABASE_KEY || "");
    if (!base) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "SUPABASE_URL missing");
      return res.status(500).json({ ok: false, error: "Supabase not configured (SUPABASE_URL missing)" });
    }
    if (!key) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "SUPABASE_KEY missing");
      return res.status(500).json({ ok: false, error: "Supabase not configured (SUPABASE_KEY missing)" });
    }

    const candidates = [
      base + "/rpc/bruce_rag_hybrid_search_text",
      base.replace(/\/rest\/v1$/, "") + "/rest/v1/rpc/bruce_rag_hybrid_search_text"
    ];

    let rr = null;
    let rtxt = null;
    for (const u of candidates) {
      try {
        rr = await fetchWithTimeout(u, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": key,
            "Authorization": "Bearer " + key
          },
          body: JSON.stringify({ qtext: q, qvec: qvec, k: k })
        }, BRUCE_RAG_SUPABASE_TIMEOUT_MS);
      } catch (e) {
        rr = null
        rtxt = null
        break
      }

      rtxt = await rr.text();
      if (rr.ok) break;
      if (rr.status !== 404) break;
    }

    if (!rr || !rr.ok) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "supabase rpc error");
      return res.status(rr ? rr.status : 504).send(rtxt || "");
    }

    const results = JSON.parse(rtxt || "[]");
    const context = (Array.isArray(results) ? results : []).map((r, i) => {
      const head = "SOURCE " + (i + 1) + " | doc_id=" + r.doc_id + " chunk_id=" + r.chunk_id + " chunk_index=" + r.chunk_index;
      return head + "\n" + String(r.preview || "").trim() + "\n";
    }).join("\n");

    const ms = Date.now() - t0;
    bruceRagMetricOk("context", ms);

    return res.json({ ok: true, q: q, k: k, results: results, context: context });
  } catch (e) {
    const ms = Date.now() - t0;
    bruceRagMetricErr("context", ms, String(e && e.message ? e.message : e));
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// --- bruceRagContext helper (used by chat.js and session/init) ---
/**
 * Internal helper function `bruceRagContext`.
 * @param {any} qtext - Function input parameter.
 * @param {any} k - Function input parameter.
 * @returns {Promise<any>} Computed helper result.
 */
async function bruceRagContext(qtext, k) {
  const q = String(qtext || "").trim();
  const kRaw = parseInt(String(k ?? "8"), 10);
  const kk = Math.max(1, Math.min(20, Number.isFinite(kRaw) ? kRaw : 8));

  const embedBase = String(EMBEDDER_URL || "").replace(/\/+$/, "");
  if (!embedBase) throw new Error("EMBEDDER_URL missing");

  const er = await fetch(embedBase + "/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: q, max_length: 256 })
  });
  const etxt = await er.text();
  if (!er.ok) throw new Error("embedder http " + er.status + ": " + etxt.slice(0, 500));

  const ej = JSON.parse(etxt);
  const vec = Array.isArray(ej) ? ej[0] : (ej && ej.embeddings && ej.embeddings[0]);
  if (!Array.isArray(vec)) throw new Error("embedder format unexpected");

  const qvec = "[" + vec.map((x) => Number(x)).join(",") + "]";

  const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
  const key  = String(SUPABASE_KEY || "");
  if (!base) throw new Error("SUPABASE_URL missing");
  if (!key)  throw new Error("SUPABASE_KEY missing");

  const candidates = [
    base + "/rpc/bruce_rag_hybrid_search_text",
    base.replace(/\/rest\/v1$/, "") + "/rest/v1/rpc/bruce_rag_hybrid_search_text"
  ];

  let rr = null;
  let rtxt = null;
  for (const u of candidates) {
    rr = await fetch(u, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": key,
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify({ qtext: q, qvec: qvec, k: kk })
    });
    rtxt = await rr.text();
    if (rr.ok) break;
    if (rr.status !== 404) break;
  }

  if (!rr || !rr.ok) {
    throw new Error("supabase rpc error " + (rr ? rr.status : "no_response") + ": " + String(rtxt || "").slice(0, 500));
  }

  const results = JSON.parse(rtxt || "[]");
  const arr = Array.isArray(results) ? results : [];

  const context = arr.map((r, i) => {
    const head = "SOURCE " + (i + 1) + " | doc_id=" + r.doc_id + " chunk_id=" + r.chunk_id + " chunk_index=" + r.chunk_index;
    return head + "\n" + String(r.preview || "").trim() + "\n";
  }).join("\n");

  const maxChars = 9000;
  const ctx = context.length > maxChars ? context.slice(0, maxChars) + "\n[TRUNCATED]\n" : context;

  return { q: q, k: kk, n: arr.length, qvec: qvec, results: arr, context: ctx };
}

// POST /tools/rag/search
/**
 * Handles POST /tools/rag/search.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends an HTTP response for the endpoint.
 */
router.post('/tools/rag/search', async (req, res) => {
  const { query, top_k = 5, min_similarity = 0.5 } = req.body || {};
  if (!query) return res.status(400).json({ ok: false, error: 'query required' });
  try {
    // 1. Générer l'embedding via embedder BGE-M3
    const embedResp = await fetch(`${EMBEDDER_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [query] })
    });
    if (!embedResp.ok) return res.status(502).json({ ok: false, error: 'Embedder error ' + embedResp.status });
    const embedData = await embedResp.json();
    const vec = Array.isArray(embedData[0]) ? embedData[0] : embedData;

    // 2. Appel RPC Supabase - vecteur passé comme paramètre JSON, JAMAIS interpolé dans SQL
    const supaBase = SUPABASE_URL.replace('/rest/v1', '');
    const rpcResp = await fetch(`${supaBase}/rest/v1/rpc/search_bruce_chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY
      },
      body: JSON.stringify({ query_embedding: vec, match_threshold: min_similarity, match_count: top_k })
    });
    if (!rpcResp.ok) return res.status(502).json({ ok: false, error: 'RPC error ' + rpcResp.status });
    const results = await rpcResp.json();
    res.json({ ok: true, query, count: results.length, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /bruce/preflight
/**
 * Handles POST /bruce/preflight.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends an HTTP response for the endpoint.
 */
router.post('/bruce/preflight', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const actionType = (req.body && req.body.action_type) ? String(req.body.action_type).toLowerCase().trim() : '';
  const context = (req.body && req.body.context) ? String(req.body.context).slice(0, 300) : '';

  if (!actionType) {
    return res.status(400).json({ ok: false, error: 'action_type requis. Valeurs: ssh, file_transfer, docker, write, supabase, sql, rest_api, general' });
  }

  // Mapping action_type -> mots-clés de recherche pour les interdictions et runbooks
  const ACTION_KEYWORDS = {
    ssh: {
      lesson_keywords: ['interdiction_ssh', 'interdiction_guillemets', 'interdiction_sed_go_heredoc', 'interdiction_faux_diagnostic', 'anti_pattern'],
      kb_keywords: ['runbook ssh', 'SSH Windows'],
      quick_rules: [
        'JAMAIS invoke_expression pour SSH → TOUJOURS Start-Job + Wait-Job -Timeout 25',
        'JAMAIS guillemets doubles imbriqués → TOUJOURS script .sh + SCP + exec',
        'JAMAIS sed/Go templates/heredoc via PowerShell → TOUJOURS script .sh',
        'JAMAIS && en PowerShell → utiliser ;',
        'Terminal qui "attend" = PAS bloqué, c\'est un timeout normal'
      ]
    },
    file_transfer: {
      lesson_keywords: ['interdiction_guillemets', 'file_transfer', 'scp'],
      kb_keywords: ['runbook transfert', 'transfert fichiers', 'SCP'],
      quick_rules: [
        'Petit (<50 lignes): write_file + SCP',
        'Moyen (50-2000 lignes): write_file chunked (30 lignes max par appel) + SCP',
        'Box2: TOUJOURS 2 étapes Windows→.230→box2 (pas de SCP direct)',
        'TOUJOURS backup avant remplacement: cp fichier fichier.bak_TASKID',
        'Gros (>200KB): NFS ou base64 REST, pas SCP'
      ]
    },
    docker: {
      lesson_keywords: ['interdiction_docker', 'docker_restart', 'compose'],
      kb_keywords: ['docker compose', 'docker restart'],
      quick_rules: [
        'Nouveau volume/bind: JAMAIS docker restart → TOUJOURS docker compose up -d',
        'Vérifier volumes: docker inspect container | grep -A5 Mounts',
        'Go templates (--format): JAMAIS via PowerShell → utiliser script .sh ou python3',
        'Logs: docker logs --tail 50 container (pas --since sans format correct)'
      ]
    },
    write: {
      lesson_keywords: ['staging_queue', 'roadmap', 'ecriture', 'write', 'table_cible'],
      kb_keywords: ['staging_queue schema', 'roadmap insertion'],
      quick_rules: [
        'roadmap: INSERT DIRECT via POST /rest/v1/roadmap (JAMAIS staging_queue)',
        'lessons_learned / knowledge_base: TOUJOURS via staging_queue',
        'staging_queue champs EXACTS: table_cible (pas table_target), contenu_json (pas content_json)',
        'author_system="claude" — jamais claude-opus, claude-sonnet',
        'Après push staging: POST /run/validate {staging_id} pour promouvoir'
      ]
    },
    supabase: {
      lesson_keywords: ['supabase', 'staging_queue', 'colonnes', 'schema', 'table'],
      kb_keywords: ['schema staging_queue', 'schema lessons_learned', 'schema roadmap'],
      quick_rules: [
        'staging_queue   : table_cible, contenu_json, author_system, content_hash, status',
        'lessons_learned : lesson_type, lesson_text, importance, confidence_score, validated',
        'knowledge_base  : question, answer, category, tags, confidence_score',
        'roadmap         : step_name, description, status, priority, model_hint',
        'current_state   : key, value, updated_at',
        'Ne JAMAIS utiliser les champs d\'une table dans une autre'
      ]
    },
    sql: {
      lesson_keywords: ['sql', 'supabase', 'psql'],
      kb_keywords: ['runbook sql', 'docker exec psql'],
      quick_rules: [
        'Écrire fichier .sql localement',
        'SCP vers .230 puis .146',
        'Exécuter: docker exec -i supabase-db psql -U postgres -d postgres -f /tmp/query.sql',
        'JAMAIS SQL inline dans SSH PowerShell (guillemets impossibles)'
      ]
    },
    rest_api: {
      lesson_keywords: ['session_close', 'bruce_write', 'staging_queue', 'schema', 'endpoint'],
      kb_keywords: ['cheatsheet schemas endpoints', 'session close', 'bruce write'],
      quick_rules: [
        'POST /bruce/session/close: OBLIGATOIRES = session_id(number) + summary(string) + handoff_next(string)',
        'POST /bruce/session/close OPTIONNELS: decisions[], rules_learned[], tech_discoveries[], patterns[], tasks_status[{id,status}], tasks_done[number], infrastructure_changes[]',
        'POST /bruce/write: table_cible(string) + contenu_json(object) — tables: lessons_learned|knowledge_base|current_state|roadmap|session_history',
        'GET /bruce/session/close/checklist?session_id=N pour verifier etat AVANT cloture',
        'current_state: la table s appelle current_state PAS bruce_state',
        'POST /bruce/preflight {action_type, context?} AVANT toute action pour rappel schemas'
      ]
    },
    general: {
      lesson_keywords: ['interdiction', 'anti_pattern', 'warning'],
      kb_keywords: ['runbook'],
      quick_rules: [
        'Consulter KB sémantique AVANT toute action (homelab-semantic-search-advanced)',
        'Documenter APRÈS chaque action dans Supabase',
        'Ne pas modifier ce qui fonctionne sans raison explicite'
      ]
    }
  };

  const config = ACTION_KEYWORDS[actionType] || ACTION_KEYWORDS['general'];

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  try {

    // [718] Recherche semantique: embed action_type + context -> lecons pertinentes
    // Complete la recherche FTS pour capturer les lecons non indexees par keyword exact
    let semanticLessons = [];
    const ragQuery = context
      ? (actionType + ' ' + context).slice(0, 400)
      : actionType;
    try {
      const ragResult = await bruceRagContext(ragQuery, 15);
      const chunkIds = (ragResult.results || []).map(r => r.chunk_id).filter(Boolean);
      if (chunkIds.length > 0) {
        // Recuperer les anchors des chunks pour identifier source + importance
        const chunkFilter = chunkIds.slice(0, 15).map(id => `chunk_id.eq.${id}`).join(',');
        const chunkRes = await fetchWithTimeout(
          base + `/bruce_chunks?or=(${chunkFilter})&select=chunk_id,anchor,text`,
          { headers: hSupa }, 5000
        );
        const chunkData = await chunkRes.json();
        const chunkMap = {};
        for (const c of (Array.isArray(chunkData) ? chunkData : [])) {
          chunkMap[c.chunk_id] = c;
        }
        const seenLessonIds = new Set();
        for (const r of (ragResult.results || [])) {
          const chunk = chunkMap[r.chunk_id] || {};
          let anchor = {};
          try { anchor = typeof chunk.anchor === 'string' ? JSON.parse(chunk.anchor) : (chunk.anchor || {}); } catch(e) { console.error('[rag.js][/bruce/preflight] erreur silencieuse:', e.message || e); }
          if (anchor.source !== 'lessons_learned') continue;
          const imp = anchor.importance || '';
          if (imp !== 'critical' && imp !== 'high') continue;
          const sid = anchor.source_id;
          if (sid && seenLessonIds.has(sid)) continue;
          if (sid) seenLessonIds.add(sid);
          semanticLessons.push({
            id: sid,
            text: r.preview || chunk.text || '',
            score: r.hybrid_score || r.cos_sim || 0,
            importance: imp
          });
          if (semanticLessons.length >= 3) break;
        }
      }
    } catch(ragErr) {
      // Degrade gracieux: si embedder down, continue avec FTS seul
      semanticLessons = [];
    }

    // Chercher les leçons INTERDICTION pertinentes
    const intentFilter = config.lesson_keywords.map(k => `intent.ilike.*${k}*`).join(',');
    const lessonsRes = await fetchWithTimeout(
      base + `/lessons_learned?importance=eq.critical&validated=eq.true&or=(${intentFilter})&order=id.desc&limit=5`,
      { headers: hSupa }, 6000
    );
    const lessons = await lessonsRes.json();

    // Chercher les runbooks pertinents
    let runbooks = [];
    for (const kw of config.kb_keywords) {
      try {
        const kbRes = await fetchWithTimeout(
          base + `/knowledge_base?category=eq.runbook&answer=ilike.*${encodeURIComponent(kw)}*&limit=2`,
          { headers: hSupa }, 4000
        );
        const kbArr = await kbRes.json();
        if (Array.isArray(kbArr)) runbooks.push(...kbArr);
      } catch(e) { console.error('[rag.js][/bruce/preflight] erreur silencieuse:', e.message || e); }
    }
    // Dédupliquer runbooks par id
    const seenIds = new Set();
    runbooks = runbooks.filter(r => {
      if (seenIds.has(r.id)) return false;
      seenIds.add(r.id);
      return true;
    });

    return res.json({
      ok: true,
      action_type: actionType,
      context: context,
      quick_rules: config.quick_rules,
      semantic_lessons: semanticLessons,
      interdictions: Array.isArray(lessons) ? lessons.map(l => ({
        id: l.id,
        text: l.lesson_text,
        intent: l.intent
      })) : [],
      runbooks: runbooks.map(r => ({
        id: r.id,
        title: r.question,
        preview: (r.answer || '').slice(0, 500)
      })),
      reminder: '⚠️ RAPPEL: Appliquer ces règles AVANT d\'agir. En cas de doute, écrire un script .sh.'
    });

  } catch (e) {
    // Fallback: retourner au moins les quick_rules
    return res.json({
      ok: true,
      action_type: actionType,
      quick_rules: config.quick_rules,
      interdictions: [],
      runbooks: [],
      reminder: '⚠️ Erreur DB mais voici les règles minimales. Appliquer avant d\'agir.',
      error_detail: String(e.message || e)
    });
  }
});

module.exports = router;
module.exports.bruceRagContext = bruceRagContext;
module.exports.BRUCE_RAG_METRICS = BRUCE_RAG_METRICS;
