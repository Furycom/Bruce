// routes/truenas.js — [1388] S1451 TrueNAS .60 status for dashboard
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const router = Router();

const TRUENAS_URL = 'https://192.168.2.60/api/v2.0';
const TRUENAS_TOKEN = '2-nRJrGsOM1mP26du6RdU6e2YITSYyAWrR1w76YjP6rkJzoPsuyW1vZEnBY7Xn7ZSg';

// Cache 2 minutes (TrueNAS data changes slowly)
let _cache = { data: null, ts: 0 };
const TTL = 120000;

async function tnFetch(path) {
  // TrueNAS uses self-signed cert
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const res = await fetch(`${TRUENAS_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${TRUENAS_TOKEN}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`TrueNAS ${res.status} on ${path}`);
  return res.json();
}

router.get('/bruce/truenas-status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  if (_cache.data && (Date.now() - _cache.ts) < TTL) {
    return res.json({ ..._cache.data, cached: true });
  }

  try {
    const [pools, disks, datasets] = await Promise.all([
      tnFetch('/pool'),
      tnFetch('/disk'),
      tnFetch('/pool/dataset'),
    ]);

    const pool = pools[0] || null;
    const result = {
      ok: true,
      generated_at: new Date().toISOString(),
      pool: pool ? { name: pool.name, status: pool.status, healthy: pool.healthy, path: pool.path } : null,
      disks: disks.map(d => ({
        name: d.name,
        size: d.size,
        model: d.model,
        serial: d.serial,
        type: d.type,
        temperature: d.temperature || null,
      })),
      datasets: datasets.map(d => ({
        name: d.name,
        used_bytes: d.used ? parseInt(d.used.rawvalue) : 0,
        available_bytes: d.available ? parseInt(d.available.rawvalue) : 0,
        type: d.type,
      })),
    };

    _cache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (e) {
    console.error('[truenas] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
