// routes/file.js — [917] File transfer endpoint
// POST /bruce/file/write — Write file content directly to .230 filesystem
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const fs = require('fs');
const path = require('path');

// Allowed base directories (security: no writing outside these)
const ALLOWED_BASES = ['/tmp', '/home/furycom'];

/**
 * Handles POST /bruce/file/write.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends an HTTP response for the endpoint.
 */
router.post('/bruce/file/write', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { filepath, content, mode, backup } = req.body || {};
  if (!filepath || typeof filepath !== 'string') {
    return res.status(400).json({ ok: false, error: 'filepath requis (string)' });
  }
  if (content === undefined || content === null) {
    return res.status(400).json({ ok: false, error: 'content requis' });
  }

  // Security: resolve and check path
  const resolved = path.resolve(filepath);
  const allowed = ALLOWED_BASES.some(b => resolved.startsWith(b));
  if (!allowed) {
    return res.status(403).json({ ok: false, error: `Path interdit. Bases autorisees: ${ALLOWED_BASES.join(', ')}` });
  }

  try {
    // Create directories if needed
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Backup if requested and file exists
    if (backup && fs.existsSync(resolved)) {
      const bakPath = resolved + '.bak_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(resolved, bakPath);
    }

    // Write mode: overwrite (default), append
    const writeMode = mode === 'append' ? 'a' : 'w';
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);

    if (writeMode === 'a') {
      fs.appendFileSync(resolved, contentStr, 'utf8');
    } else {
      fs.writeFileSync(resolved, contentStr, 'utf8');
    }

    const stats = fs.statSync(resolved);
    return res.json({
      ok: true,
      filepath: resolved,
      size: stats.size,
      mode: writeMode === 'a' ? 'append' : 'overwrite'
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// GET /bruce/file/read — Read file content from .230 filesystem
/**
 * Handles GET /bruce/file/read.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends an HTTP response for the endpoint.
 */
router.get('/bruce/file/read', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const filepath = req.query.path;
  if (!filepath) return res.status(400).json({ ok: false, error: 'query param path requis' });

  const resolved = path.resolve(filepath);
  const allowed = ALLOWED_BASES.some(b => resolved.startsWith(b));
  if (!allowed) {
    return res.status(403).json({ ok: false, error: `Path interdit. Bases autorisees: ${ALLOWED_BASES.join(', ')}` });
  }

  try {
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ ok: false, error: 'Fichier non trouve' });
    }
    const content = fs.readFileSync(resolved, 'utf8');
    const stats = fs.statSync(resolved);
    return res.json({ ok: true, filepath: resolved, size: stats.size, content });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;