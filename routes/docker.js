'use strict';
const { Router } = require('express');
const { validateBruceAuth, requireScope } = require('../shared/auth');
const docker = require('../shared/docker-client');
const { auditLog } = require('../shared/exec-security');

const router = Router();

// [771] C5: Require docker scope for all routes in this router
// [771] Scope enforcement moved to per-route validateBruceAuth(req, 'docker')
// router.use(requireScope('docker'));

// ── GET /bruce/docker/ps — list containers ──
router.get('/bruce/docker/ps', async (req, res) => {
  const auth = validateBruceAuth(req, 'docker');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  try {
    const all = req.query.all !== 'false'; // default: show all
    const containers = await docker.listContainers({ all });
    const compact = containers.map(c => ({
      id: c.Id.substring(0, 12),
      name: (c.Names[0] || '').replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status,
      ports: (c.Ports || []).map(p => p.PublicPort ? `${p.PublicPort}->${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`).filter(Boolean),
    }));
    // TODO(contract-v2): migrate success payload to { ok: true, data } without breaking current consumers.
    res.json({ ok: true, count: compact.length, containers: compact });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /bruce/docker/inspect/:container — inspect container ──
router.get('/bruce/docker/inspect/:container', async (req, res) => {
  const auth = validateBruceAuth(req, 'docker');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  try {
    const c = docker.getContainer(req.params.container);
    const info = await c.inspect();
    res.json({
      ok: true,
      id: info.Id.substring(0, 12),
      name: info.Name.replace(/^\//, ''),
      state: info.State,
      config: {
        image: info.Config.Image,
        env: (info.Config.Env || []).length,
        cmd: info.Config.Cmd,
      },
      mounts: (info.Mounts || []).map(m => ({
        type: m.Type, src: m.Source, dst: m.Destination, rw: m.RW,
      })),
      network: Object.keys(info.NetworkSettings.Networks || {}),
      restartPolicy: info.HostConfig.RestartPolicy,
    });
  } catch (e) { res.status(e.statusCode === 404 ? 404 : 500).json({ ok: false, error: e.message }); }
});

// ── GET /bruce/docker/logs/:container — container logs ──
router.get('/bruce/docker/logs/:container', async (req, res) => {
  const auth = validateBruceAuth(req, 'docker');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  try {
    const tail = parseInt(req.query.tail || '50', 10);
    const c = docker.getContainer(req.params.container);
    const logs = await c.logs({ stdout: true, stderr: true, tail: Math.min(tail, 500), timestamps: true });
    // dockerode returns Buffer, clean Docker stream headers (8-byte prefix per line)
    const raw = typeof logs === 'string' ? logs : logs.toString('utf8');
    const lines = raw.split('\n').map(l => l.replace(/^.{8}/, '').trim()).filter(Boolean);
    // TODO(contract-v2): migrate success payload to { ok: true, data } without breaking current consumers.
    res.json({ ok: true, container: req.params.container, lines: lines.length, logs: lines });
  } catch (e) { res.status(e.statusCode === 404 ? 404 : 500).json({ ok: false, error: e.message }); }
});

// ── GET /bruce/docker/stats/:container — container stats (one-shot) ──
router.get('/bruce/docker/stats/:container', async (req, res) => {
  const auth = validateBruceAuth(req, 'docker');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  try {
    const c = docker.getContainer(req.params.container);
    const stats = await c.stats({ stream: false });
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage.total_usage || 0);
    const sysDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
    const cpuCount = stats.cpu_stats.online_cpus || 1;
    const cpuPercent = sysDelta > 0 ? ((cpuDelta / sysDelta) * cpuCount * 100).toFixed(2) : '0.00';
    const memUsage = stats.memory_stats.usage || 0;
    const memLimit = stats.memory_stats.limit || 1;
    res.json({
      ok: true,
      container: req.params.container,
      cpu_percent: parseFloat(cpuPercent),
      memory_mb: Math.round(memUsage / 1048576),
      memory_limit_mb: Math.round(memLimit / 1048576),
      memory_percent: parseFloat(((memUsage / memLimit) * 100).toFixed(2)),
      pids: stats.pids_stats.current || 0,
      net_rx_mb: stats.networks ? Math.round(Object.values(stats.networks).reduce((s, n) => s + (n.rx_bytes || 0), 0) / 1048576) : 0,
      net_tx_mb: stats.networks ? Math.round(Object.values(stats.networks).reduce((s, n) => s + (n.tx_bytes || 0), 0) / 1048576) : 0,
    });
  } catch (e) { res.status(e.statusCode === 404 ? 404 : 500).json({ ok: false, error: e.message }); }
});

// ── POST /bruce/docker/restart/:container — restart container ──
router.post('/bruce/docker/restart/:container', async (req, res) => {
  const auth = validateBruceAuth(req, 'docker');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  const t0 = Date.now();
  try {
    const timeout = parseInt(req.query.timeout || '10', 10);
    const c = docker.getContainer(req.params.container);
    await c.restart({ t: timeout });
    const ms = Date.now() - t0;
    auditLog('/bruce/docker/restart', req.headers['x-session-id'], 'local', `restart ${req.params.container}`, 'ok', ms);
    res.json({ ok: true, container: req.params.container, action: 'restart', duration_ms: ms });
  } catch (e) {
    auditLog('/bruce/docker/restart', req.headers['x-session-id'], 'local', `restart ${req.params.container}`, 'error', Date.now() - t0);
    res.status(e.statusCode === 404 ? 404 : 500).json({ ok: false, error: e.message });
  }
});

// ── POST /bruce/docker/stop/:container — stop container ──
router.post('/bruce/docker/stop/:container', async (req, res) => {
  const auth = validateBruceAuth(req, 'docker');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  const t0 = Date.now();
  try {
    const c = docker.getContainer(req.params.container);
    await c.stop();
    const ms = Date.now() - t0;
    auditLog('/bruce/docker/stop', req.headers['x-session-id'], 'local', `stop ${req.params.container}`, 'ok', ms);
    res.json({ ok: true, container: req.params.container, action: 'stop', duration_ms: ms });
  } catch (e) {
    auditLog('/bruce/docker/stop', req.headers['x-session-id'], 'local', `stop ${req.params.container}`, 'error', Date.now() - t0);
    res.status(e.statusCode === 404 ? 404 : 500).json({ ok: false, error: e.message });
  }
});

// ── POST /bruce/docker/start/:container — start container ──
router.post('/bruce/docker/start/:container', async (req, res) => {
  const auth = validateBruceAuth(req, 'docker');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  const t0 = Date.now();
  try {
    const c = docker.getContainer(req.params.container);
    await c.start();
    const ms = Date.now() - t0;
    auditLog('/bruce/docker/start', req.headers['x-session-id'], 'local', `start ${req.params.container}`, 'ok', ms);
    res.json({ ok: true, container: req.params.container, action: 'start', duration_ms: ms });
  } catch (e) {
    auditLog('/bruce/docker/start', req.headers['x-session-id'], 'local', `start ${req.params.container}`, 'error', Date.now() - t0);
    res.status(e.statusCode === 404 ? 404 : 500).json({ ok: false, error: e.message });
  }
});

// ── GET /bruce/docker/health — global health summary ──
router.get('/bruce/docker/health', async (req, res) => {
  const auth = validateBruceAuth(req, 'docker');
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });
  try {
    const containers = await docker.listContainers({ all: true });
    const summary = { total: containers.length, running: 0, stopped: 0, unhealthy: 0 };
    const issues = [];
    for (const c of containers) {
      if (c.State === 'running') {
        summary.running++;
        if (c.Status && c.Status.includes('unhealthy')) {
          summary.unhealthy++;
          issues.push({ name: (c.Names[0] || '').replace(/^\//, ''), status: c.Status });
        }
      } else {
        summary.stopped++;
        if (c.State === 'restarting' || c.State === 'dead') {
          issues.push({ name: (c.Names[0] || '').replace(/^\//, ''), state: c.State, status: c.Status });
        }
      }
    }
    res.json({ ok: true, ...summary, issues });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;
