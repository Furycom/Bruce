// routes/infra.js — [773] C7 REFONTE
// Routes: /health, /bruce/health, /bruce/state, /bruce/issues/open,
//         /bruce/topology, /bruce/maintenance/run, /bruce/sync/homelab-hub,
//         /bruce/integrity, /bruce/bootstrap
const express = require('express');
const router = express.Router();
const fs = require('fs');
const { spawn } = require('child_process');
const { validateBruceAuth } = require('../shared/auth');
const {
  SUPABASE_URL, SUPABASE_KEY, MANUAL_ROOT, PORT, BRUCE_AUTH_TOKEN,
  BRUCE_LLM_API_KEY, BRUCE_LITELLM_KEY
} = require('../shared/config');
const { pingUrl } = require('../shared/helpers');
const { fetchWithTimeout } = require('../shared/fetch-utils');

// safePythonSpawn injected from server.js via module.exports function
let _safePythonSpawn = null;
function setSafePythonSpawn(fn) { _safePythonSpawn = fn; }

router.get('/health', async (req, res) => {
  const result = {
    status: 'ok',
    supabase: {
      configured: Boolean(SUPABASE_URL && SUPABASE_KEY),
      url: SUPABASE_URL || null,
      status: 'unknown',
      error: null,
    },
    manual: {
      root: MANUAL_ROOT,
      accessible: false,
      error: null,
    },
    timestamp: new Date().toISOString(),
  };

  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const ping = await pingUrl(SUPABASE_URL);
      result.supabase.status = ping.status;
      if (ping.error) result.supabase.error = ping.error;
    } catch (err) {
      result.supabase.status = 'offline';
      result.supabase.error = err.message || String(err);
    }
  } else {
    result.supabase.status = 'not_configured';
  }

  try {
    const stats = fs.statSync(MANUAL_ROOT);
    result.manual.accessible = stats.isDirectory();
  } catch (err) {
    result.manual.accessible = false;
    result.manual.error = err.message || String(err);
  }

  res.json(result);
});

router.get('/bruce/health', (req, res) => {
  return res.redirect(307, '/health');
});

router.get('/bruce/state', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const headers = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  try {
    const [stateRes, lessonsRes, roadmapRes, dashRes, decisionsRes, kgRes] = await Promise.all([
      fetchWithTimeout(base + '/current_state?order=key.asc', { headers }, 8000),
      fetchWithTimeout(base + '/lessons_learned?importance=eq.critical&order=id.desc&limit=10', { headers }, 8000),
      fetchWithTimeout(base + '/roadmap?status=in.(todo,doing)&order=priority.asc,id.asc&select=id,step_name,priority,status,category', { headers }, 8000),
      fetchWithTimeout(base + '/v_bruce_dashboard?limit=1', { headers }, 8000),
      fetchWithTimeout(base + '/v_decisions?limit=10', { headers }, 8000),
      Promise.resolve({ ok: true, json: async () => [] }),
    ]);

    const [state, lessons, roadmap, dashArr, decisions, kg] = await Promise.all([
      stateRes.json(), lessonsRes.json(), roadmapRes.json(),
      dashRes.json(), decisionsRes.json(), kgRes.json(),
    ]);

    const dashboard = Array.isArray(dashArr) && dashArr.length > 0 ? dashArr[0] : {};

    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      dashboard, current_state: state, critical_lessons: lessons,
      top_decisions: decisions, roadmap_todo: roadmap, knowledge_graph: kg,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.get('/bruce/issues/open', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const sql = "select * from public.bruce_open_issues order by computed_at desc, severity, domain, type, scope1, scope2, scope3";
    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key  = String(SUPABASE_KEY || '');

    if (!base) return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_URL missing)' });
    if (!key)  return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_KEY missing)' });

    const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
    const rpcUrl = useRestV1
      ? `${base.replace(/\/rest\/v1$/, '')}/rest/v1/rpc/exec_sql`
      : `${base}/rpc/exec_sql`;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'apikey': key,
    };

    const response = await fetch(rpcUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ query: sql }),
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(200).json({ ok: false, status: response.status, error: text || `HTTP ${response.status}` });
    }

    const parsed = text ? JSON.parse(text) : null;
    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) ? parsed.data : parsed;
    return res.status(200).json({ ok: true, status: response.status, data });
  } catch (err) {
    return res.status(200).json({ ok: false, status: 500, error: err && err.message ? err.message : String(err) });
  }
});

router.get('/bruce/topology', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  try {
    const headers = { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` };
    const resp = await fetch(
      `${SUPABASE_URL.replace(/\/+$/, '')}/bruce_tools?select=id,name,category,tool_type,status,host,ip,port,url,role,vm_parent,notes&order=category.asc,host.asc,name.asc`,
      { headers }
    );
    if (!resp.ok) throw new Error(`Supabase error: ${resp.status}`);
    const tools = await resp.json();

    const machines = {};
    for (const tool of tools) {
      if (!tool.host && !tool.ip) continue;
      const machineKey = tool.host || tool.ip;
      if (!machines[machineKey]) {
        machines[machineKey] = { host: tool.host, ip: tool.ip, services: [], vms: {} };
      }
      const entry = {
        id: tool.id, name: tool.name, category: tool.category,
        tool_type: tool.tool_type, status: tool.status,
        port: tool.port, url: tool.url, role: tool.role
      };
      if (tool.vm_parent) {
        if (!machines[machineKey].vms[tool.vm_parent]) {
          machines[machineKey].vms[tool.vm_parent] = { name: tool.vm_parent, services: [] };
        }
        machines[machineKey].vms[tool.vm_parent].services.push(entry);
      } else {
        machines[machineKey].services.push(entry);
      }
    }

    const topology = Object.entries(machines).map(([hostKey, data]) => ({
      host: data.host || hostKey, ip: data.ip,
      services_count: data.services.length + Object.values(data.vms).reduce((acc, vm) => acc + vm.services.length, 0),
      services: data.services, vms: Object.values(data.vms)
    })).sort((a, b) => (b.services_count - a.services_count));

    const stats = {
      total_tools: tools.length,
      tools_with_host: tools.filter(t => t.host || t.ip).length,
      tools_without_host: tools.filter(t => !t.host && !t.ip).length,
      unique_machines: topology.length,
      active_services: tools.filter(t => t.status === 'active').length
    };

    return res.json({
      ok: true, generated_at: new Date().toISOString(), stats, topology,
      unlocated_tools: tools.filter(t => !t.host && !t.ip).map(t => ({
        id: t.id, name: t.name, category: t.category, tool_type: t.tool_type, status: t.status
      }))
    });
  } catch (e) {
    console.error('[/bruce/topology] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/bruce/maintenance/run', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const scriptName = (req.body && req.body.script) ? String(req.body.script) : 'kb_maintenance';
  const argsStr   = (req.body && req.body.args)   ? String(req.body.args)   : '';

  const ALLOWED_SCRIPTS = { 'kb_maintenance': '/home/furycom/kb_maintenance.py', 'pulse_sync': '/home/furycom/pulse_sync.py' };
  const scriptPath = ALLOWED_SCRIPTS[scriptName];
  if (!scriptPath) {
    return res.status(400).json({ ok: false, error: `Script inconnu: ${scriptName}. Autorisés: ${Object.keys(ALLOWED_SCRIPTS).join(', ')}` });
  }

  const logFile = '/tmp/kb_maintenance_last.log';
  const logArgs = argsStr.split(' ').filter(a => a);
  try {
    const out = fs.openSync(logFile, 'w');
    const VENV_PYTHON = '/home/furycom/venv-ingestion/bin/python3';
    const pythonBin = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : null;
    if (!pythonBin) { fs.closeSync(out); return res.status(503).json({ ok: false, error: 'venv python3 not found' }); }
    const child = spawn(pythonBin, [scriptPath, ...logArgs], { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.closeSync(out);
    return res.json({ ok: true, started: true, pid: child.pid, script: scriptPath, args: argsStr, log: logFile, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

router.post('/bruce/sync/homelab-hub', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const logFile = '/tmp/sync_homelab_hub.log';
  try {
    const out = fs.openSync(logFile, 'w');
    const child = _safePythonSpawn('/home/furycom/sync_homelab_hub.py', [], { detached: true, stdio: ['ignore', out, out] });
    if (!child) { fs.closeSync(out); return res.status(503).json({ ok: false, error: 'python3 not available in container.' }); }
    child.unref();
    fs.closeSync(out);
    return res.json({ ok: true, started: true, pid: child.pid, log: logFile, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

router.get('/bruce/integrity', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  const GLOBAL_TIMEOUT_MS = 8000;
  const globalStart = Date.now();

  async function safeCheck(name, fn) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('check_timeout')), GLOBAL_TIMEOUT_MS - 500))
      ]);
      return { name, ...result };
    } catch (e) {
      return { name, ok: false, error: String(e.message || e) };
    }
  }

  const checkFns = [
    safeCheck('supabase', async () => {
      const r = await fetchWithTimeout(base + '/v_bruce_dashboard?limit=1', { headers: hSupa }, 5000);
      const d = await r.json();
      return { ok: Array.isArray(d) && d.length > 0, detail: d[0] || null };
    }),
    safeCheck('staging_pending', async () => {
      const r = await fetchWithTimeout(base + '/staging_queue?status=eq.pending&select=id', { headers: hSupa }, 5000);
      const d = await r.json();
      return { ok: true, count: Array.isArray(d) ? d.length : -1 };
    }),
    safeCheck('embedder', async () => {
      const r = await fetchWithTimeout('http://192.168.2.85:8081/health', {}, 4000);
      return { ok: r.status === 200 };
    }),
    safeCheck('local-llm', async () => {
      const r = await fetchWithTimeout('http://192.168.2.230:4100/health',
        { headers: { 'Authorization': 'Bearer ' + (BRUCE_LLM_API_KEY || 'token-abc123') } }, 5000);
      return { ok: r.status === 200 };
    }),
    safeCheck('validate_service', async () => {
      const r = await fetchWithTimeout('http://172.18.0.1:4001/health', {}, 4000);
      const d = await r.json();
      return { ok: d.ok === true };
    }),
    safeCheck('n8n', async () => {
      const r = await fetchWithTimeout('http://192.168.2.174:5678/healthz', {}, 4000);
      return { ok: r.status === 200 };
    }),
    safeCheck('litellm', async () => {
      // [902] LiteLLM /health requires auth; use / which returns 200 without auth
      const r = await fetchWithTimeout('http://172.18.0.1:4100/', {}, 4000);
      return { ok: r.status === 200 };
    }),
    safeCheck('sequences', async () => {
      const r = await fetchWithTimeout(base + '/rpc/check_sequences', {
        method: 'POST',
        headers: { ...hSupa, 'Content-Type': 'application/json' },
        body: '{}'
      }, 5000);
      const d = await r.json();
      if (!Array.isArray(d)) return { ok: false, error: 'rpc_failed' };
      const bad = d.filter(x => x.status !== 'OK');
      return { ok: bad.length === 0, total: d.length, desaligned: bad };
    })
  ];

  let results;
  try {
    results = await Promise.race([
      Promise.allSettled(checkFns),
      new Promise((_, reject) => setTimeout(() => reject(new Error('global_integrity_timeout')), GLOBAL_TIMEOUT_MS))
    ]);
  } catch (e) {
    return res.json({
      ok: false, generated_at: new Date().toISOString(),
      checks: { _timeout: { ok: false, error: 'Global timeout after ' + GLOBAL_TIMEOUT_MS + 'ms' } },
      elapsed_ms: Date.now() - globalStart,
      verdict: 'Integrity check timeout — certains services ne répondent pas.'
    });
  }

  const checks = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { name, ...rest } = r.value;
      checks[name] = rest;
    }
  }

  const allOk = Object.values(checks).every(c => c.ok);
  const elapsed = Date.now() - globalStart;

  return res.json({
    ok: allOk, generated_at: new Date().toISOString(), checks,
    elapsed_ms: elapsed,
    verdict: allOk ? 'Système nominal — prêt pour la session.' : 'Attention: certains services sont dégradés.'
  });
});

router.post('/bruce/bootstrap', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const topic = (req.body && req.body.topic) ? String(req.body.topic).slice(0, 200) : '';
  const model = (req.body && req.body.model) ? String(req.body.model).slice(0, 20) : '';
  const profile = (req.body && req.body.profile) ? String(req.body.profile).slice(0, 10) : 'standard'; // [772] C6
  const startMs = Date.now();

  const hGw = { 'Authorization': 'Bearer ' + (BRUCE_AUTH_TOKEN || 'bruce-secret-token-01'), 'Content-Type': 'application/json' };

  try {
    // Run integrity + session/init in PARALLEL via internal loopback
    const [integrityRes, sessionRes] = await Promise.all([
      fetchWithTimeout('http://127.0.0.1:' + PORT + '/bruce/integrity', { headers: hGw }, 10000),
      fetchWithTimeout('http://127.0.0.1:' + PORT + '/bruce/session/init', {
        method: 'POST',
        headers: hGw,
        body: JSON.stringify({ topic, scope: 'homelab,general', profile })
      }, 18000)
    ]);

    const integrityData = await integrityRes.json();
    const sessionData = await sessionRes.json();

    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startMs,
      session_id: sessionData.session_id || null,
      model_filter: model || null,
      integrity: {
        ok: integrityData.ok,
        verdict: integrityData.verdict,
        checks_summary: Object.fromEntries(
          Object.entries(integrityData.checks || {}).map(([k, v]) => [k, v.ok])
        )
      },
      briefing: sessionData.briefing || null,
      dashboard: sessionData.dashboard || null,
      next_tasks: sessionData.next_tasks || [],
      critical_lessons: sessionData.critical_lessons || [],
      last_session: sessionData.last_session || null,
      current_state: sessionData.current_state || [],
      clarifications_pending: sessionData.clarifications_pending || [],
      rag_context: sessionData.rag_context || []
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e), elapsed_ms: Date.now() - startMs });
  }
});

module.exports = router;
module.exports.setSafePythonSpawn = setSafePythonSpawn;
