'use strict';
const { Router } = require('express');

const { BROWSERLESS_URL } = require('../shared/config');

const router = Router();

/**
 * Handles POST /bruce/browser/fetch.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.post('/bruce/browser/fetch', async (req, res) => {
  const { url, wait_for, timeout = 15000 } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  try {
    const response = await fetch(`${BROWSERLESS_URL}/content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, waitFor: wait_for || 1000 }),
      signal: AbortSignal.timeout(timeout + 5000)
    });
    if (!response.ok) return res.status(502).json({ ok: false, error: 'Browserless error ' + response.status });
    const html = await response.text();
    res.json({ ok: true, url, length: html.length, html: html.substring(0, 50000) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/**
 * Handles POST /bruce/browser/screenshot.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.post('/bruce/browser/screenshot', async (req, res) => {
  const { url, full_page = false, timeout = 15000 } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  try {
    const response = await fetch(`${BROWSERLESS_URL}/screenshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, options: { fullPage: full_page, type: 'png' } }),
      signal: AbortSignal.timeout(timeout + 5000)
    });
    if (!response.ok) return res.status(502).json({ ok: false, error: 'Browserless error ' + response.status });
    const buf = await response.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    res.json({ ok: true, url, format: 'png', size_bytes: buf.byteLength, base64: b64 });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/**
 * Handles POST /bruce/browser/scrape.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.post('/bruce/browser/scrape', async (req, res) => {
  const { url, selector, timeout = 15000 } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  try {
    const response = await fetch(`${BROWSERLESS_URL}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, elements: [{ selector: selector || 'body' }] }),
      signal: AbortSignal.timeout(timeout + 5000)
    });
    if (!response.ok) return res.status(502).json({ ok: false, error: 'Browserless error ' + response.status });
    const data = await response.json();
    res.json({ ok: true, url, data });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
