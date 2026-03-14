'use strict';
const fs = require('fs');
const { Router } = require('express');
const { MANUAL_ROOT } = require('../shared/config');
const { listMarkdownFiles, safeJoinManual } = require('../shared/helpers');

const router = Router();

/**
 * Handles GET /manual/pages.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {void} Sends an HTTP response for the endpoint.
 */
router.get('/manual/pages', (req, res) => {
  try {
    const files = listMarkdownFiles(MANUAL_ROOT);
    res.json({
      root: MANUAL_ROOT,
      count: files.length,
      files,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to list manual pages',
      details: err.message || String(err),
    });
  }
});

/**
 * Handles GET /manual/page.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {void} Sends an HTTP response for the endpoint.
 */
router.get('/manual/page', (req, res) => {
  const relPath = (req.query.path || '').toString().trim();
  if (!relPath) {
    return res.status(400).json({
      error: 'Missing "path" query parameter',
    });
  }

  let fullPath;
  try {
    fullPath = safeJoinManual(relPath);
  } catch (err) {
    return res.status(400).json({
      error: err.message || String(err),
    });
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    res.json({
      path: relPath,
      fullPath,
      length: content.length,
      content,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({
        error: 'Manual page not found',
        path: relPath,
      });
    }
    res.status(500).json({
      error: 'Failed to read manual page',
      details: err.message || String(err),
    });
  }
});

/**
 * Handles GET /manual/search.
 * Expects request parameters in path/query/body depending on endpoint contract and returns a JSON response.
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {void} Sends an HTTP response for the endpoint.
 */
router.get('/manual/search', (req, res) => {
  const rawQuery = (req.query.query || req.query.q || '').toString().trim();
  if (!rawQuery) {
    return res.status(400).json({
      error: 'Missing "query" (or "q") query parameter',
    });
  }

  const query = rawQuery.toLowerCase();
  const files = listMarkdownFiles(MANUAL_ROOT);
  const matches = [];

  for (const relPath of files) {
    let content;
    try {
      const fullPath = safeJoinManual(relPath);
      content = fs.readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const lower = content.toLowerCase();
    const index = lower.indexOf(query);
    if (index === -1) {
      continue;
    }

    let score = 0;
    let pos = index;
    while (pos !== -1) {
      score += 1;
      pos = lower.indexOf(query, pos + query.length);
    }

    const start = Math.max(0, index - 80);
    const end = Math.min(content.length, index + query.length + 80);
    const snippet = content.slice(start, end).replace(/\s+/g, ' ');

    matches.push({
      path: relPath,
      score,
      snippet,
    });
  }

  matches.sort((a, b) => b.score - a.score);

  res.json({
    query: rawQuery,
    total: matches.length,
    results: matches.slice(0, 20),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
