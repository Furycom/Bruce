// routes/proxmox.js — [1059] Proxmox Tier A routes
'use strict';
const express = require('express');
const https = require('https');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');

const PROXMOX_HOST = process.env.PROXMOX_HOST || '192.168.2.103';
const PROXMOX_PORT = parseInt(process.env.PROXMOX_PORT || '8006', 10);
const PROXMOX_TOKEN_ID = process.env.PROXMOX_TOKEN_ID || 'root@pam!claude-mcp';
const PROXMOX_TOKEN_SECRET = process.env.PROXMOX_TOKEN_SECRET || 'b3b90a84-9e6e-43f4-a4d8-02ba8dfae657';

function proxmoxFetch(apiPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: PROXMOX_HOST,
      port: PROXMOX_PORT,
      path: apiPath,
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        'Authorization': `PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}`,
      },
      timeout: 15000,
    };
    const req = https.request(options, (res) => {      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Proxmox ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`Proxmox parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxmox request timeout')); });
    req.end();
  });
}

function proxmoxPost(apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: PROXMOX_HOST,
      port: PROXMOX_PORT,
      path: apiPath,
      method: 'POST',      rejectUnauthorized: false,
      headers: {
        'Authorization': `PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 30000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`Proxmox exec ${res.statusCode}: ${data.slice(0,200)}`));
          else resolve(json);
        } catch (e) { reject(new Error(`Proxmox parse error: ${data.slice(0,200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Proxmox request timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

router.get('/bruce/proxmox/nodes', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {    const data = await proxmoxFetch('/api2/json/nodes');
    res.json({ ok: true, nodes: data.data || data });
  } catch (e) {
    console.error('[proxmox.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/proxmox/nodes/:node/status', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await proxmoxFetch(`/api2/json/nodes/${encodeURIComponent(req.params.node)}/status`);
    res.json({ ok: true, status: data.data || data });
  } catch (e) {
    console.error('[proxmox.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/proxmox/cluster/status', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await proxmoxFetch('/api2/json/cluster/status');
    res.json({ ok: true, cluster: data.data || data });
  } catch (e) {
    console.error('[proxmox.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.get('/bruce/proxmox/nodes/:node/vms', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const node = encodeURIComponent(req.params.node);
    const qemu = await proxmoxFetch(`/api2/json/nodes/${node}/qemu`);
    const lxc = await proxmoxFetch(`/api2/json/nodes/${node}/lxc`);
    const vms = [...(qemu.data || []), ...(lxc.data || [])];
    res.json({ ok: true, count: vms.length, vms });
  } catch (e) {
    console.error('[proxmox.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.get('/bruce/proxmox/nodes/:node/storage', async (req, res) => {
  const auth = validateBruceAuth(req, 'read');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const data = await proxmoxFetch(`/api2/json/nodes/${encodeURIComponent(req.params.node)}/storage`);
    res.json({ ok: true, storage: data.data || data });
  } catch (e) {
    console.error('[proxmox.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});
router.post('/bruce/proxmox/nodes/:node/exec', async (req, res) => {
  const auth = validateBruceAuth(req, 'exec');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
  try {
    const { vmid, command } = req.body || {};
    if (!vmid || !command) return res.status(400).json({ ok: false, error: 'Missing vmid or command in body' });
    const readOnlyPrefixes = ['ls','cat','df','free','uptime','hostname','uname','whoami','date','ip','ps','systemctl status','journalctl'];
    if (!readOnlyPrefixes.some(p => command.trim().startsWith(p))) {
      return res.status(403).json({ ok: false, error: `Command '${command.trim().split(/\\s+/)[0]}' not in exec whitelist` });
    }
    const node = encodeURIComponent(req.params.node);
    const result = await proxmoxPost(`/api2/json/nodes/${node}/qemu/${vmid}/agent/exec`, { command });
    res.json({ ok: true, result: result.data || result });
  } catch (e) {
    console.error('[proxmox.js] error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;