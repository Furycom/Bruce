// routes/truenas.js — [1388] S1452 TrueNAS .60 status enrichi (SMART, pool détaillé)
'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const router = Router();

const TRUENAS_URL = 'https://192.168.2.60/api/v2.0';
const TRUENAS_TOKEN = '2-nRJrGsOM1mP26du6RdU6e2YITSYyAWrR1w76YjP6rkJzoPsuyW1vZEnBY7Xn7ZSg';

let _cache = { data: null, ts: 0 };
const TTL = 120000;

async function tnFetch(path) {
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

    // Try to get SMART data (may fail on some systems)
    let smartByDisk = {};
    try {
      const smartResults = await tnFetch('/smart/test/results');
      if (Array.isArray(smartResults)) {
        for (const r of smartResults) {
          const diskName = r.disk;
          if (!smartByDisk[diskName] || new Date(r.updated) > new Date(smartByDisk[diskName].updated)) {
            smartByDisk[diskName] = {
              status: r.results?.[0]?.status || r.status || 'unknown',
              lastTest: r.updated || null,
              powerOnHours: r.results?.[0]?.power_on_hours || null,
              temperature: r.results?.[0]?.temperature || null,
            };
          }
        }
      }
    } catch (smartErr) {
      console.warn('[truenas] SMART fetch failed (non-fatal):', smartErr.message);
    }

    const pool = pools[0] || null;
    const result = {
      ok: true,
      generated_at: new Date().toISOString(),
      pool: pool ? {
        name: pool.name,
        status: pool.status,
        healthy: pool.healthy,
        path: pool.path,
        topology: pool.topology ? {
          data: (pool.topology.data || []).map(vdev => ({
            type: vdev.type,
            status: vdev.status,
            children: (vdev.children || []).map(c => ({
              device: c.device || c.path,
              status: c.status,
              stats: c.stats ? {
                read_errors: c.stats.read_errors || 0,
                write_errors: c.stats.write_errors || 0,
                checksum_errors: c.stats.checksum_errors || 0,
              } : null,
            })),
          })),
          spare: (pool.topology.spare || []).length,
          cache: (pool.topology.cache || []).length,
        } : null,
        scan: pool.scan ? {
          function: pool.scan.function,
          state: pool.scan.state,
          end_time: pool.scan.end_time ? new Date(pool.scan.end_time.$date || pool.scan.end_time).toISOString() : null,
          errors: pool.scan.errors || 0,
        } : null,
      } : null,
      disks: disks.map(d => ({
        name: d.name,
        size: d.size,
        model: d.model,
        serial: d.serial,
        type: d.type,
        temperature: d.temperature || null,
        rotationrate: d.rotationrate || null,
        hddstandby: d.hddstandby || null,
        smart: smartByDisk[d.name] || null,
      })),
      datasets: datasets.map(d => ({
        name: d.name,
        used_bytes: d.used ? parseInt(d.used.rawvalue) : 0,
        available_bytes: d.available ? parseInt(d.available.rawvalue) : 0,
        type: d.type,
        compression: d.compression ? d.compression.value : null,
        compressratio: d.compressratio ? d.compressratio.value : null,
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
