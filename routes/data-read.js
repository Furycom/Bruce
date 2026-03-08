// routes/data-read.js — [773] C7 REFONTE
// Routes: POST /bruce/read, GET /bruce/roadmap/list
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');

router.post("/bruce/read", async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });

  try {
    const q = String((req.body && req.body.q) ? req.body.q : "").trim();
    const params = (req.body && typeof req.body.params === "object" && req.body.params) ? req.body.params : {};

    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

    const base = SUPABASE_URL.replace(/\/+$/, "");
    const candidates = [
      `${base}/rpc/bruce_read`,
      `${base}/rest/v1/rpc/bruce_read`
    ];

    let r = null;
    let lastText = null;
    for (const candidate of candidates) {
      r = await fetch(candidate, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`
        },
        body: JSON.stringify({ q, params })
      });
      lastText = await r.text();
      if (r.ok) { lastText = lastText; break; }
      if (r.status !== 404) break;
    }

    const text = lastText || "";
    if (!r.ok) return res.status(r.status).send(text);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

router.get('/bruce/roadmap/list', async (req, res) => {
  const startMs = Date.now();
  try {
    const url = `${SUPABASE_URL}/roadmap?status=in.(todo,doing)&order=priority.asc,id.asc&select=id,priority,model_hint,step_name`;
    const resp = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } });
    if (!resp.ok) throw new Error(`Supabase ${resp.status}`);
    const tasks = await resp.json();
    return res.json({
      ok: true,
      count: tasks.length,
      elapsed_ms: Date.now() - startMs,
      tasks
    });
  } catch (err) {
    console.error('[/bruce/roadmap/list]', err.message);
    return res.status(500).json({ ok: false, error: err.message, elapsed_ms: Date.now() - startMs });
  }
});

module.exports = router;
