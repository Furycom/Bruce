'use strict';
const fs = require('fs');
const { Router } = require('express');
const { CONNECTORS_PATH } = require('../shared/config');
const { pingUrl } = require('../shared/helpers');

const router = Router();

router.get('/connectors', async (req, res) => {
  let connectors = [];
  try {
    const raw = fs.readFileSync(CONNECTORS_PATH, 'utf8');
    connectors = JSON.parse(raw);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to read connectors.json',
      details: err.message || String(err),
    });
  }

  const results = [];
  const connectorsList = Array.isArray(connectors)
    ? connectors
    : (connectors && typeof connectors === 'object' ? Object.values(connectors) : []);
  for (const connector of connectorsList) {
    const { id, name, url, kind } = connector;
    const pingResult = await pingUrl(url);
    results.push({
      id: id || name || url,
      name: name || id || url,
      kind: kind || 'generic',
      url,
      status: pingResult.status,
      httpStatus: pingResult.httpStatus,
      error: pingResult.error,
    });
  }

  res.json({
    connectors: results,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
