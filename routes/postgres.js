'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const router = Router();
let _pool = null;
function getPool() {
  if (_pool) return _pool;
  const { Pool } = require('pg');
  _pool = new Pool({
    host: process.env.POSTGRES_HOST || '192.168.2.146',
    port: parseInt(process.env.POSTGRES_PORT || '5433', 10),
    database: process.env.POSTGRES_DB || 'postgres',
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'D8BQkIH9oqfc2rTaZSCkgAPtnpL8FI0C',
    max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000, statement_timeout: 15000,
  });
  _pool.on('error', (err) => { console.error('[postgres.js] Pool error:', err.message); });
  return _pool;
}
router.post('/bruce/postgres/query', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  const sql = (req.body && typeof req.body.sql === 'string') ? req.body.sql.trim() : '';
  if (!sql) return res.status(400).json({ ok: false, error: 'Missing or empty sql field' });
  const firstWord = sql.replace(/^[\s(]+/, '').split(/\s+/)[0].toUpperCase();
  const ALLOWED = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'SET', 'RESET'];
  if (!ALLOWED.includes(firstWord)) return res.status(403).json({ ok: false, error: 'Read-only: ' + firstWord + ' not allowed' });
  const upperSql = sql.toUpperCase();
  const DANGEROUS = ['INSERT ', 'UPDATE ', 'DELETE ', 'DROP ', 'ALTER ', 'TRUNCATE ', 'CREATE ', 'GRANT ', 'REVOKE '];
  for (const kw of DANGEROUS) { if (upperSql.includes(kw)) return res.status(403).json({ ok: false, error: 'Read-only: contains ' + kw.trim() }); }
  try {
    const pool = getPool();
    const result = await pool.query(sql);
    return res.json({ ok: true, rowCount: result.rowCount, fields: (result.fields || []).map(f => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: result.rows });
  } catch (err) { console.error('[postgres.js] Query error:', err.message); return res.status(500).json({ ok: false, error: err.message }); }
});
router.get('/bruce/postgres/status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  try {
    const pool = getPool();
    const result = await pool.query('SELECT NOW() AS server_time, current_database() AS db, version() AS version');
    return res.json({ ok: true, ...result.rows[0] });
  } catch (err) { console.error('[postgres.js] Status check error:', err.message); return res.status(500).json({ ok: false, error: err.message }); }
});
module.exports = router;