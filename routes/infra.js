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
  SUPABASE_URL,
  SUPABASE_KEY,
  MANUAL_ROOT,
  PORT,
  BRUCE_AUTH_TOKEN,
  BRUCE_LLM_API_KEY,
  BRUCE_LITELLM_KEY,
  EMBEDDER_URL,
  LITELLM_URL,
  VALIDATE_SERVICE_URL,
  MCP_PLAYWRIGHT_URL,
  VLLM_INTERNAL_URL,
  PULSE_URL,
  LOOPBACK_BASE_URL,
  LOCAL_LLM_URL,
  BRUCE_SSH_KEY_PATH,
  BRUCE_SSH_HOSTS,
} = require('../shared/config');
const { pingUrl } = require('../shared/helpers');
const { fetchWithTimeout } = require('../shared/fetch-utils');
const { NodeSSH } = require('node-ssh');
const { validateExecCommand } = require('../shared/exec-security');
const { loadTopicContext } = require('../shared/topic-context');
const { estimateTokens, truncateToTokens } = require('../shared/context-engine');

// safePythonSpawn injected from server.js via module.exports function
let _safePythonSpawn = null;
/**
 * Injects the safe Python spawn implementation used by infra endpoints.
 * @param {(args: string[]) => Promise<{ok: boolean, code: number, stdout: string, stderr: string}>} fn - Safe spawn function provided by the server bootstrap.
 * @returns {void} No return value.
 */
function setSafePythonSpawn(fn) { _safePythonSpawn = fn; }

/**
 * Handles GET /health.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
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
    } catch (err) { console.error(`[infra.js] operation failed:`, err.message);
      result.supabase.status = 'offline';
      result.supabase.error = err.message || String(err);
    }
  } else {
    result.supabase.status = 'not_configured';
  }

  try {
    const stats = fs.statSync(MANUAL_ROOT);
    result.manual.accessible = stats.isDirectory();
  } catch (err) { console.error(`[infra.js] operation failed:`, err.message);
    result.manual.accessible = false;
    result.manual.error = err.message || String(err);
  }

  res.json(result);
});

/**
 * Handles GET /bruce/health.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.get('/bruce/health', (req, res) => {
  return res.redirect(307, '/health');
});

/**
 * Handles GET /bruce/state.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
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
  } catch (e) { console.error(`[infra.js] operation failed:`, e.message);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * Handles GET /bruce/issues/open.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
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
      return res.status(response.status).json({ ok: false, error: text || `HTTP ${response.status}` });
    }

    const parsed = text ? JSON.parse(text) : null;
    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) ? parsed.data : parsed;
    // TODO(contract-v2): migrate success payload to { ok: true, data } without breaking current consumers.
    return res.json({ ok: true, status: response.status, data });
  } catch (err) { console.error(`[infra.js] operation failed:`, err.message);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

/**
 * Handles GET /bruce/topology.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
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
  } catch (e) { console.error(`[infra.js] operation failed:`, e.message);
    console.error('[/bruce/topology] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Handles POST /bruce/maintenance/run.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
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
  } catch (e) { console.error(`[infra.js] operation failed:`, e.message);
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

/**
 * Handles POST /bruce/sync/homelab-hub.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
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
  } catch (e) { console.error(`[infra.js] operation failed:`, e.message);
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

/**
 * Handles GET /bruce/integrity.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.get('/bruce/integrity', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  const GLOBAL_TIMEOUT_MS = 8000;
  const globalStart = Date.now();

  /**
   * safeCheck internal helper.
   * @param {any} name - Function input parameters.
   * @param {any} fn - Additional function input parameter.
   * @returns {any} Helper return value used by route handlers.
   */
  async function safeCheck(name, fn) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('check_timeout')), GLOBAL_TIMEOUT_MS - 500))
      ]);
      return { name, ...result };
    } catch (e) { console.error(`[infra.js] operation failed:`, e.message);
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
      const r = await fetchWithTimeout(EMBEDDER_URL + '/health', {}, 4000);
      return { ok: r.status === 200 };
    }),
    safeCheck('local-llm', async () => {
      const r = await fetchWithTimeout(LITELLM_URL + '/health/liveliness', // [audit-1198] /health blocks on backend timeout
        { headers: { 'Authorization': 'Bearer ' + (BRUCE_LITELLM_KEY || 'bruce-litellm-key-01') } }, 5000);
      const txt = await r.text(); return { ok: r.status === 200 && txt.includes('alive') };
    }),
    safeCheck('validate_service', async () => {
      const r = await fetchWithTimeout(VALIDATE_SERVICE_URL + '/health', {}, 4000);
      const d = await r.json();
      return { ok: d.ok === true };
    }),
    safeCheck('n8n', async () => {
      const r = await fetchWithTimeout(MCP_PLAYWRIGHT_URL + '/healthz', {}, 4000);
      const txt = await r.text(); return { ok: r.status === 200 && txt.includes('ok') };
    }),
    safeCheck('litellm', async () => {
      // [902] LiteLLM /health requires auth; use / which returns 200 without auth
      const r = await fetchWithTimeout(VLLM_INTERNAL_URL + '/health/liveliness', {}, 4000);
      const txt = await r.text(); return { ok: r.status === 200 && txt.includes('alive') };
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
  } catch (e) { console.error(`[infra.js] operation failed:`, e.message);
    return res.status(500).json({
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

/**
 * Handles POST /bruce/bootstrap.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.post('/bruce/bootstrap', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const topic = (req.body && req.body.topic) ? String(req.body.topic).slice(0, 200) : '';
  const model = (req.body && req.body.model) ? String(req.body.model).slice(0, 10) : '';
  const profile = (req.body && req.body.profile) ? String(req.body.profile).slice(0, 10) : 'standard'; // [772] C6
  // [917] Pass-through output filtering flags to session/init
  const includeTasks = req.body && req.body.include_tasks === false ? false : true;
  const includeLessons = req.body && req.body.include_lessons === false ? false : true;
  const includeState = req.body && req.body.include_state === false ? false : true;
  // [CE-5] Compact mode: only context_prompt + essential fields, skip raw data already in context_prompt
  // [S1444] Compact by default — saves ~8000 tokens. Pass compact=false to get full data.
  const compact = req.body && req.body.compact === false ? false : true;
  const startMs = Date.now();

  // [CE-2] Map bootstrap model param to LLM identity for session/init
  const MODEL_TO_IDENTITY = {
    'opus': 'claude',
    'sonnet': 'claude',
    'code': 'claude',
    'codex': 'claude',
    'chatgpt': 'chatgpt',
    'local-llm': 'local-llm',
    'vllm': 'local-llm',
    'qwen': 'local-llm'
  };
  const llmIdentity = MODEL_TO_IDENTITY[model.toLowerCase()] || 'claude';

  const hGw = {
    'Authorization': 'Bearer ' + (BRUCE_AUTH_TOKEN || process.env.BRUCE_AUTH_TOKEN),
    'Content-Type': 'application/json',
    'x-llm-identity': llmIdentity  // [CE-2] Forward identity to session/init
  };

  try {
    // Run integrity + session/init in PARALLEL via internal loopback
    const [integrityRes, sessionRes, topicContext] = await Promise.all([
      fetchWithTimeout(LOOPBACK_BASE_URL + ':' + PORT + '/bruce/integrity', { headers: hGw }, 10000),
      fetchWithTimeout(LOOPBACK_BASE_URL + ':' + PORT + '/bruce/session/init', {
        method: 'POST',
        headers: hGw,
        body: JSON.stringify({ topic, scope: 'homelab,general', profile, include_tasks: includeTasks, include_lessons: includeLessons, include_state: includeState })
      }, 18000),
      loadTopicContext(topic, SUPABASE_URL, SUPABASE_KEY),
    ]);

    const integrityData = await integrityRes.json();
    const sessionData = await sessionRes.json();

    // [CE-5] Build response — compact mode excludes fields already summarized in context_prompt
    const response = {
      ok: true,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startMs,
      session_id: sessionData.session_id || null,
      model_filter: model || null,
      compact: compact, // [CE-5] Echo back so caller knows which mode was used
      integrity: {
        ok: integrityData.ok,
        verdict: integrityData.verdict,
        checks_summary: Object.fromEntries(
          Object.entries(integrityData.checks || {}).map(([k, v]) => [k, v.ok])
        )
      },
      context: topicContext,
      context_prompt: sessionData.context_prompt || null,
      context_meta: sessionData.context_meta || null,
      dashboard: sessionData.dashboard || null,
      // [S1444] Filter tasks to P1-P2 max 20 — saves ~5000 tokens
      next_tasks: (sessionData.next_tasks || []).filter(t => t.priority <= 2).slice(0, 10),
      // [S1444] Services registry removed — available in dashboard http://192.168.2.12:8029
      // Use /bruce/health-all for live service status
    };

    // In full mode (compact=false), include raw data fields
    if (!compact) {
      response.briefing = sessionData.briefing || null;
      response.critical_lessons = sessionData.critical_lessons || [];
      response.last_session = sessionData.last_session || null;
      response.current_state = sessionData.current_state || [];
      response.clarifications_pending = sessionData.clarifications_pending || [];
      response.rag_context = sessionData.rag_context || [];
    }

    return res.json(response);
  } catch (e) { console.error(`[infra.js] operation failed:`, e.message);
    return res.status(500).json({ ok: false, error: String(e.message || e), elapsed_ms: Date.now() - startMs });
  }
});


// === /bruce/context/fetch — [CE-6] On-demand context retrieval mid-session ===
/**
 * Handles POST /bruce/context/fetch.
 * Lightweight context endpoint for mid-session use.
 * Returns topic-aware rules/runbooks, RAG results, and optionally lessons,
 * all budgeted within a token limit.
 *
 * Body params:
 *   topic (string, required) — subject to fetch context for
 *   budget_tokens (int, optional, default 1000) — max tokens for the response
 *   sources (string[], optional, default all) — subset of ['kb', 'lessons', 'tools', 'profile']
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
router.post('/bruce/context/fetch', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const topic = (req.body && req.body.topic) ? String(req.body.topic).slice(0, 200).trim() : '';
  if (!topic) return res.status(400).json({ ok: false, error: 'topic is required' });

  const budgetTokens = Math.min(Math.max(parseInt(req.body.budget_tokens) || 1000, 200), 3000);
  const allSources = ['kb', 'lessons', 'tools', 'profile'];
  const sources = (Array.isArray(req.body.sources) && req.body.sources.length > 0)
    ? req.body.sources.filter(s => allSources.includes(s))
    : allSources;

  const startMs = Date.now();
  const CHARS_PER_TOKEN = 4;
  const parts = [];
  const sourcesUsed = [];
  let usedTokens = 0;

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');
  const hSupa = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

  try {
    // --- 1. Topic context: rules, runbooks, tools (via loadTopicContext) ---
    if (sources.includes('kb') || sources.includes('tools')) {
      const topicCtx = await loadTopicContext(topic, SUPABASE_URL, SUPABASE_KEY);
      if (topicCtx.tools_loaded && topicCtx.tools_loaded.length > 0 && sources.includes('tools')) {
        const toolsText = '**OUTILS (' + topic + '):** ' + topicCtx.tools_loaded.join(', ');
        const toolsTrunc = truncateToTokens(toolsText, Math.min(150, budgetTokens - usedTokens));
        parts.push(toolsTrunc);
        usedTokens += estimateTokens(toolsTrunc);
        sourcesUsed.push('tools');
      }
      if (sources.includes('kb')) {
        // Rules
        if (topicCtx.rules && topicCtx.rules.length > 0) {
          const rulesLines = topicCtx.rules.slice(0, 5).map(r =>
            '- [' + r.source + '] ' + truncateToTokens(r.text, 80)
          );
          const rulesBudget = Math.min(300, budgetTokens - usedTokens);
          if (rulesBudget > 50) {
            const rulesText = '**RÈGLES (' + topic + '):**\n' + rulesLines.join('\n');
            const rulesTrunc = truncateToTokens(rulesText, rulesBudget);
            parts.push(rulesTrunc);
            usedTokens += estimateTokens(rulesTrunc);
            sourcesUsed.push('kb_rules');
          }
        }
        // Runbooks
        if (topicCtx.runbooks && topicCtx.runbooks.length > 0) {
          const rbLines = topicCtx.runbooks.slice(0, 3).map(r =>
            '- [' + r.source + '] ' + r.category + '/' + r.subcategory + ': ' + truncateToTokens(r.text, 100)
          );
          const rbBudget = Math.min(300, budgetTokens - usedTokens);
          if (rbBudget > 50) {
            const rbText = '**RUNBOOKS (' + topic + '):**\n' + rbLines.join('\n');
            const rbTrunc = truncateToTokens(rbText, rbBudget);
            parts.push(rbTrunc);
            usedTokens += estimateTokens(rbTrunc);
            sourcesUsed.push('kb_runbooks');
          }
        }
      }
    }

    // --- 2. RAG semantic search ---
    if (sources.includes('kb') && (budgetTokens - usedTokens) > 100) {
      try {
        const embedRes = await fetchWithTimeout(
          EMBEDDER_URL + '/embed',
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: topic, max_length: 256 }) },
          6000
        );
        const embedData = await embedRes.json();
        const embedding = Array.isArray(embedData) ? embedData[0] : (embedData && embedData.embeddings && embedData.embeddings[0]);
        if (embedding) {
          const qvec = '[' + embedding.map(x => Number(x)).join(',') + ']';
          const ragRes = await fetchWithTimeout(
            base + '/rpc/bruce_rag_hybrid_search_text',
            { method: 'POST', headers: { ...hSupa },
              body: JSON.stringify({ qtext: topic, qvec: qvec, k: 6 }) },
            8000
          );
          const ragData = await ragRes.json();
          if (Array.isArray(ragData) && ragData.length > 0) {
            const ragBudget = Math.min(350, budgetTokens - usedTokens);
            const ragItems = ragData
              .slice(0, 5)
              .map(r => {
                const score = Math.round((r.hybrid_score || r.cos_sim || 0) * 100) / 100;
                return '(' + score + ') ' + truncateToTokens((r.preview || '').trim(), 70);
              });
            const ragText = '**RAG ("' + topic.slice(0, 30) + '"):**\n' + ragItems.join('\n');
            const ragTrunc = truncateToTokens(ragText, ragBudget);
            parts.push(ragTrunc);
            usedTokens += estimateTokens(ragTrunc);
            sourcesUsed.push('rag');
          }
        }
      } catch (ragErr) {
        console.error('[infra.js][context/fetch] RAG error:', ragErr.message);
      }
    }

    // --- 3. Recent lessons related to topic ---
    if (sources.includes('lessons') && (budgetTokens - usedTokens) > 80) {
      try {
        const lessonsRes = await fetchWithTimeout(
          base + '/lessons_learned?lesson_text=ilike.*' + encodeURIComponent(topic) + '*&order=date_learned.desc&limit=5&select=id,lesson_type,lesson_text,importance,date_learned',
          { headers: { apikey: key, Authorization: 'Bearer ' + key } },
          5000
        );
        if (lessonsRes.ok) {
          const lessons = await lessonsRes.json();
          if (Array.isArray(lessons) && lessons.length > 0) {
            const lessonBudget = Math.min(250, budgetTokens - usedTokens);
            const lessonLines = lessons.slice(0, 3).map(l =>
              '- [' + l.importance + '] ' + truncateToTokens((l.lesson_text || ''), 70)
            );
            const lessonText = '**LEÇONS ("' + topic.slice(0, 10) + '"):**\n' + lessonLines.join('\n');
            const lessonTrunc = truncateToTokens(lessonText, lessonBudget);
            parts.push(lessonTrunc);
            usedTokens += estimateTokens(lessonTrunc);
            sourcesUsed.push('lessons');
          }
        }
      } catch (lessErr) {
        console.error('[infra.js][context/fetch] Lessons error:', lessErr.message);
      }
    }

    // --- 4. User profile critical exigences ---
    if (sources.includes('profile') && (budgetTokens - usedTokens) > 50) {
      try {
        const profRes = await fetchWithTimeout(
          base + '/user_profile?category=eq.exigence&priority=eq.critical&status=eq.active&select=observation&limit=5',
          { headers: { apikey: key, Authorization: 'Bearer ' + key } },
          3000
        );
        if (profRes.ok) {
          const exigences = await profRes.json();
          if (Array.isArray(exigences) && exigences.length > 0) {
            const exBudget = Math.min(150, budgetTokens - usedTokens);
            const exLines = exigences.map(e => '- ' + truncateToTokens(e.observation, 50));
            const exText = '**EXIGENCES:**\n' + exLines.join('\n');
            const exTrunc = truncateToTokens(exText, exBudget);
            parts.push(exTrunc);
            usedTokens += estimateTokens(exTrunc);
            sourcesUsed.push('profile');
          }
        }
      } catch (profErr) {
        console.error('[infra.js][context/fetch] Profile error:', profErr.message);
      }
    }

  } catch (e) {
    console.error('[infra.js][context/fetch] Error:', e.message);
    return res.status(500).json({ ok: false, error: String(e.message || e), elapsed_ms: Date.now() - startMs });
  }

  const contextPrompt = parts.join('\n\n');
  return res.json({
    ok: true,
    topic,
    context_prompt: contextPrompt,
    context_meta: {
      sources_used: sourcesUsed,
      total_tokens: estimateTokens(contextPrompt),
      budget_tokens: budgetTokens,
      budget_used_pct: Math.round((estimateTokens(contextPrompt) / budgetTokens) * 100)
    },
    elapsed_ms: Date.now() - startMs
  });
});


// === /bruce/llm/status — Real-time LLM monitoring ===
/**
 * Handles GET /bruce/llm/status.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
// === /bruce/llm/status — Real-time LLM monitoring [1100] FIXED: parallel + 5s global timeout ===
/**
 * Handles GET /bruce/llm/status.
 * [1100] FIX: All checks run in parallel with a strict 5s global timeout.
 * Previously sequential calls could sum up to 18s if llama-server was busy.
 * Now returns partial result with timeout flag if no response within 5s.
 */
router.get('/bruce/llm/status', async (req, res) => {
  const GLOBAL_TIMEOUT_MS = 5000;
  const startMs = Date.now();
  const result = {
    ok: true,
    timestamp: new Date().toISOString(),
    llama_server: { status: 'unknown', model: null, slot_busy: null, n_ctx: null },
    litellm: { status: 'unknown' },
    dspy_job: { running: false, progress: null },
    measured: { loading_time_s: 2, speed_tps: 2.5, ttft_ms: 4000, notes: 'Qwen3-32B Q4 ctx=16384 on Dell 7910' }
  };

  // [1100] Run ALL checks in parallel, wrapped in a global timeout
  const checksPromise = Promise.allSettled([
    // 1. llama-server /health
    (async () => {
      try {
        const healthResp = await fetchWithTimeout(LOCAL_LLM_URL + '/health', { method: 'GET' }, 4000);
        if (healthResp.ok) {
          const hData = await healthResp.json();
          result.llama_server.status = hData.status || 'ok';
        } else {
          result.llama_server.status = 'unhealthy_' + healthResp.status;
        }
      } catch (e) {
        result.llama_server.status = 'down';
        result.llama_server.error = String(e.message || e).substring(0, 100);
      }
    })(),

    // 2. llama-server /slots + model name [S1344 fix: router mode needs ?model=<id>]
    (async () => {
      try {
        // Step 2a: find loaded model via /v1/models
        let loadedModelId = null;
        const modelsResp = await fetchWithTimeout(LOCAL_LLM_URL + '/v1/models', {
          method: 'GET',
          headers: { 'Authorization': 'Bearer token-abc123' }
        }, 3000);
        if (modelsResp.ok) {
          const modelsData = await modelsResp.json();
          const loaded = (modelsData.data || []).find(m => m.status?.value === 'loaded');
          if (loaded) {
            loadedModelId = loaded.id;
            result.llama_server.model = loaded.id;
          }
        }
        // Step 2b: call /slots with model param (required for router mode)
        const slotsUrl = loadedModelId
          ? LOCAL_LLM_URL + '/slots?model=' + encodeURIComponent(loadedModelId)
          : LOCAL_LLM_URL + '/slots';
        const slotResp = await fetchWithTimeout(slotsUrl, {
          method: 'GET',
          headers: { 'Authorization': 'Bearer token-abc123' }
        }, 4000);
        if (slotResp.ok) {
          const slots = await slotResp.json();
          if (slots && slots.length > 0) {
            const s = slots[0];
            result.llama_server.slot_busy = !!s.is_processing;
            result.llama_server.n_ctx = s.n_ctx || null;
            result.llama_server.task_id = s.id_task || null;
            if (s.is_processing) {
              result.llama_server.tokens_decoded = s.n_decoded || null;
              result.llama_server.tokens_remaining = s.n_remaining || null;
            }
          }
        }
      } catch (e) {
        console.error('[infra.js][/bruce/llm/status] slots+model check failed:', e.message || e);
      }
    })(),

    // 3. (merged into step 2 — S1344)
    (async () => {})(),

    // 4. LiteLLM liveliness
    (async () => {
      try {
        const liteResp = await fetchWithTimeout(LITELLM_URL + '/health/liveliness', { method: 'GET' }, 3000);
        result.litellm.status = liteResp.ok ? 'ok' : 'down';
      } catch (_) {
        result.litellm.status = 'down';
      }
    })(),

    // 5. DSPy job progress (local file check)
    (async () => {
      try {
        const { execSync } = require('child_process');
        const progJson = execSync('cat /tmp/dspy_progress.json 2>/dev/null || echo "{}"', { timeout: 2000 }).toString().trim();
        const prog = JSON.parse(progJson || '{}');
        if (prog.timestamp && (Date.now() / 1000 - prog.timestamp) < 3600) {
          result.dspy_job.running = true;
          result.dspy_job.progress = prog;
        }
      } catch (e) {
        console.error('[infra.js][/bruce/llm/status] dspy check failed:', e.message || e);
      }
    })()
  ]);

  // [1100] Global timeout: if checks dont finish in 5s, return partial result with timeout flag
  try {
    await Promise.race([
      checksPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('global_timeout')), GLOBAL_TIMEOUT_MS))
    ]);
  } catch (e) {
    // Timeout reached — return whatever we have so far
    if (result.llama_server.status === 'unknown') {
      result.llama_server.error = 'timeout';
    }
    result.ok = false;
    result.timeout = true;
    result.error = 'LLM status check timed out after ' + GLOBAL_TIMEOUT_MS + 'ms';
  }

  result.elapsed_ms = Date.now() - startMs;
  res.json(result);
});

// ── GET /bruce/health/full — Aggregated service health (cached 30s) ──
let _healthCache = null;
let _healthCacheAt = 0;
let _healthInflight = null;
const HEALTH_CACHE_TTL_MS = 30000;

const _trimUrl = (value) => (value ? String(value).replace(/\/+$/, '') : null);

async function runFullHealthChecks() {
  const now = Date.now();
  const PULSE_AUTH = 'Basic ' + Buffer.from('admin:bruce-pulse-2026').toString('base64');
  const supaHeaders = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY };
  const pulseBase = _trimUrl(PULSE_URL);

  const checks = [
    { name: 'supabase', url: _trimUrl(SUPABASE_URL), headers: supaHeaders },
    { name: 'local-llm', url: _trimUrl(LOCAL_LLM_URL) ? _trimUrl(LOCAL_LLM_URL) + '/health' : null },
    { name: 'embedder', url: _trimUrl(EMBEDDER_URL) ? _trimUrl(EMBEDDER_URL) + '/health' : null },
    { name: 'n8n', url: _trimUrl(MCP_PLAYWRIGHT_URL) ? _trimUrl(MCP_PLAYWRIGHT_URL) + '/healthz' : null },
    { name: 'validate-svc', url: _trimUrl(VALIDATE_SERVICE_URL) ? _trimUrl(VALIDATE_SERVICE_URL) + '/health' : null },
    { name: 'litellm', url: _trimUrl(VLLM_INTERNAL_URL) ? _trimUrl(VLLM_INTERNAL_URL) + '/health/liveliness' : null },
    { name: 'pulse', url: pulseBase ? pulseBase + '/api/resources' : null, headers: { 'Authorization': PULSE_AUTH } },
  ];

  const TIMEOUT_PER_CHECK = 5000;
  const results = await Promise.allSettled(
    checks.map(async (check) => {
      if (!check.url) return { name: check.name, status: 'not_configured', latency_ms: 0 };
      const t0 = Date.now();
      try {
        const resp = await fetchWithTimeout(check.url, { headers: check.headers || {} }, TIMEOUT_PER_CHECK);
        return {
          name: check.name,
          status: resp.status < 500 ? 'ok' : 'error',
          http_status: resp.status,
          latency_ms: Date.now() - t0,
        };
      } catch (e) {
        console.error('[infra.js][/bruce/health/full] check failed:', check.name, e.message || e);
        return {
          name: check.name,
          status: 'down',
          latency_ms: Date.now() - t0,
          error: (e.message || String(e)).substring(0, 100),
        };
      }
    })
  );

  const services = results.map((r) => r.status === 'fulfilled' ? r.value : { name: '?', status: 'error', error: 'check_failed' });
  const allOk = services.every((s) => s.status === 'ok');

  const payload = {
    ok: allOk,
    services,
    healthy: services.filter((s) => s.status === 'ok').length,
    total: services.length,
    timestamp: new Date().toISOString(),
    cached: false,
  };

  _healthCache = payload;
  _healthCacheAt = now;
  return payload;
}

router.get('/bruce/health/full', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const now = Date.now();

  // Return cached result if fresh
  if (_healthCache && (now - _healthCacheAt) < HEALTH_CACHE_TTL_MS) {
    return res.json({ ..._healthCache, cached: true, cache_age_ms: now - _healthCacheAt });
  }

  try {
    if (!_healthInflight) {
      _healthInflight = runFullHealthChecks().finally(() => {
        _healthInflight = null;
      });
    }

    const payload = await _healthInflight;
    return res.json(payload);
  } catch (e) {
    console.error('[infra.js][/bruce/health/full] operation failed:', e.message || e);
    return res.status(500).json({ ok: false, error: String(e.message || e).substring(0, 100) });
  }
});


/**
 * GET /bruce/process/status?name=X — Check if a process is running
 * Optional: ?host=local (default, runs on gateway container)
 * Returns: {ok, running, pids[], command_sample, count}
 */
router.get('/bruce/process/status', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const name = req.query.name;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ ok: false, error: 'query param "name" required (process name or pattern)' });
  }

  const host = req.query.host || 'local';
  if (host !== 'local') {
    return res.status(400).json({ ok: false, error: 'Only host=local is supported' });
  }

  // Sanitize: only allow alphanumeric, dash, underscore, dot
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!sanitized) {
    return res.status(400).json({ ok: false, error: 'Invalid process name after sanitization' });
  }

  try {
    const { spawnSync } = require('child_process');
    const proc = spawnSync('pgrep', ['-a', '-f', sanitized], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // pgrep returns exit code 1 if no match — that's not an error
    if (proc.status === 1) {
      return res.json({ ok: true, data: { running: false, pids: [], processes: [], count: 0, name: sanitized, host } });
    }

    if (proc.error) throw proc.error;
    if (proc.status !== 0) {
      throw new Error((proc.stderr || proc.stdout || 'pgrep failed').trim());
    }

    const lines = String(proc.stdout || '').trim().split('\n').filter(Boolean);
    const processes = lines.map((line) => {
      const parts = line.split(/\s+/);
      const pid = parseInt(parts[0], 10);
      return {
        pid,
        command: parts.slice(1).join(' ').substring(0, 200),
      };
    }).filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);

    return res.json({
      ok: true,
      data: {
        running: processes.length > 0,
        pids: processes.map((entry) => entry.pid),
        processes,
        count: processes.length,
        name: sanitized,
        host,
      }
    });
  } catch (e) {
    console.error('[infra.js][/bruce/process/status] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});



// ── POST /bruce/ssh/exec — Execute whitelisted commands on remote machines ──

router.post('/bruce/ssh/exec', async (req, res) => {
  const auth = validateBruceAuth(req, 'exec');
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { host, command, timeout = 15000 } = req.body || {};

  if (!host || !command) {
    return res.status(400).json({ ok: false, error: 'host and command required' });
  }

  // Validate host
  const hostEntry = BRUCE_SSH_HOSTS[host];
  if (!hostEntry) {
    return res.status(403).json({
      ok: false,
      error: `Host not allowed: ${host}`,
      allowed_hosts: Object.keys(BRUCE_SSH_HOSTS),
    });
  }

  // Validate command using same whitelist as local exec
  const cmd = String(command).trim();
  const check = validateExecCommand(cmd);
  if (!check.allowed) {
    return res.status(403).json({ ok: false, error: 'Command refused', reason: check.reason });
  }

  const maxTimeout = Math.min(parseInt(timeout, 10) || 15000, 30000);
  const t0 = Date.now();
  const ssh = new NodeSSH();

  try {
    await ssh.connect({
      host,
      username: hostEntry.user,
      privateKeyPath: BRUCE_SSH_KEY_PATH,
      readyTimeout: 8000,
      keepaliveInterval: 5000,
    });

    const result = await ssh.execCommand(cmd, { execOptions: { timeout: maxTimeout } });
    const elapsed = Date.now() - t0;

    ssh.dispose();

    return res.json({
      ok: result.code === 0 || result.code === null,
      host,
      host_label: hostEntry.label,
      user: hostEntry.user,
      command: cmd,
      stdout: (result.stdout || '').substring(0, 50000),
      stderr: (result.stderr || '').substring(0, 10000),
      exit_code: result.code,
      elapsed_ms: elapsed,
    });
  } catch (e) {
    const elapsed = Date.now() - t0;
    try {
      ssh.dispose();
    } catch (disposeError) {
      console.error('[infra.js][/bruce/ssh/exec] dispose failed:', disposeError.message || disposeError);
    }
    console.error('[infra.js][/bruce/ssh/exec] operation failed:', e.message || e);
    return res.status(500).json({
      ok: false,
      host,
      host_label: hostEntry.label,
      command: cmd,
      error: e.message,
      elapsed_ms: elapsed,
    });
  }
});

module.exports = router;
module.exports.setSafePythonSpawn = setSafePythonSpawn;
