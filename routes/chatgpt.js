// routes/chatgpt.js — [818] POST /bruce/chatgpt
// Compact bootstrap for ChatGPT: <2000 tokens, read-only, pre-filled commands
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  PORT,
  LOOPBACK_BASE_URL,
  SUPABASE_REST_FALLBACK_URL,
  GATEWAY_PUBLIC_URL,
} = require('../shared/config');

const router = Router();

// Internal fetch with timeout (same pattern as bootstrap)
/**
 * fetchLocal internal helper.
 * @param {any} path - Function input parameters.
 * @param {any} opts - Additional function input parameter.
 * @param {any} timeoutMs = 10000 - Additional function input parameter.
 * @returns {any} Helper return value used by route handlers.
 */
async function fetchLocal(path, opts, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${LOOPBACK_BASE_URL}:${PORT}${path}`, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Handles POST /bruce/chatgpt.
 * Expected params: request path/query/body fields consumed by this handler.
 * @param {import('express').Request} req - Express request containing endpoint parameters.
 * @param {import('express').Response} res - Express response returning `{ ok: true, data: ... }` or `{ ok: false, error: 'description' }`.
 * @returns {Promise<void>|void} Sends the HTTP JSON response.
 */
router.post('/bruce/chatgpt', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const topic = (req.body && req.body.topic) ? String(req.body.topic).slice(0, 200) : '';
  const startMs = Date.now();
  const hGw = {
    'Authorization': req.headers['authorization'] || ('Bearer ' + (req.headers['x-bruce-token'] || '')),
    'Content-Type': 'application/json'
  };

  try {
    // Parallel: integrity (loopback) + tasks (direct Supabase REST)
    const supaHeaders = {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    };
    // SUPABASE_URL already includes /rest/v1
    const supaBase = SUPABASE_URL || SUPABASE_REST_FALLBACK_URL;

    const [integrityRes, tasksRes] = await Promise.all([
      fetchLocal('/bruce/integrity', { headers: hGw }, 8000),
      fetch(`${supaBase}/roadmap?status=in.(todo,doing)&select=id,step_name,priority,status,model_hint&order=priority.asc&limit=5`, {
        headers: supaHeaders
      })
    ]);

    const integrity = await integrityRes.json();
    const tasksData = await tasksRes.json();

    // Extract integrity verdict — 1 line
    const integrityLine = integrity.ok
      ? `OK — ${Object.entries(integrity.checks || {}).filter(([,v]) => v.ok).length} services up`
      : `DEGRADED — ${integrity.verdict || 'check manually'}`;

    // Dashboard: 5 key numbers from integrity
    const dashboard = {
      services_up: Object.entries(integrity.checks || {}).filter(([,v]) => v.ok).length,
      services_total: Object.keys(integrity.checks || {}).length,
      supabase: integrity.checks?.supabase?.ok ? 'up' : 'down',
      'local-llm': integrity.checks?.['local-llm']?.ok ? 'up' : 'down',
      gateway: 'up'
    };

    // Tasks: 5 first todo/doing tasks — compact
    const tasksArr = Array.isArray(tasksData) ? tasksData : (tasksData.data || []);
    const tasks = tasksArr.slice(0, 5).map(t => ({
      id: t.id,
      title: (t.step_name || '').slice(0, 80),
      priority: t.priority,
      status: t.status,
      hint: t.model_hint || null
    }));

    // Pre-filled bash commands with SUPA_KEY injected
    // supaBase already = .../rest/v1
    const commands = {
      note: 'Commandes pré-remplies. Yann copie-colle en SSH sur .230 ou dans un terminal.',
      list_tasks: `curl -s '${supaBase}/roadmap?status=in.(todo,doing)&order=priority.asc&limit=10' -H 'apikey: ${SUPABASE_KEY}' -H 'Authorization: Bearer ${SUPABASE_KEY}' | python3 -m json.tool`,
      recent_lessons: `curl -s '${supaBase}/lessons_learned?importance=eq.critical&order=created_at.desc&limit=5' -H 'apikey: ${SUPABASE_KEY}' -H 'Authorization: Bearer ${SUPABASE_KEY}' | python3 -m json.tool`,
      staging_status: `curl -s '${supaBase}/staging_queue?status=eq.pending&order=created_at.desc&limit=5' -H 'apikey: ${SUPABASE_KEY}' -H 'Authorization: Bearer ${SUPABASE_KEY}' | python3 -m json.tool`,
      push_to_staging: `curl -s -X POST '${supaBase}/staging_queue' -H 'apikey: ${SUPABASE_KEY}' -H 'Authorization: Bearer ${SUPABASE_KEY}' -H 'Content-Type: application/json' -d '{"table_cible":"lessons_learned","contenu_json":{"lesson_type":"discovery","lesson_text":"TEXTE_ICI","importance":"normal","confidence_score":0.7,"author_system":"claude","project_scope":"homelab"},"author_system":"claude","notes":"via ChatGPT"}'`,
      integrity_check: `curl -s ${GATEWAY_PUBLIC_URL}/bruce/integrity -H 'Authorization: Bearer bruce-secret-token-01' | python3 -m json.tool`
    };

    // Forbidden actions list
    const forbidden = [
      'PATCH/DELETE staging_queue — lecture seule',
      'validate.py bypass — jamais exécuter manuellement',
      'INSERT direct dans tables canon — toujours via staging_queue',
      'Modifier server.js ou docker-compose — Claude Code seulement',
      'PATCH roadmap status sans preuve — documenter avant de fermer'
    ];

    return res.json({
      ok: true,
      client: 'chatgpt',
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startMs,
      topic: topic || null,
      integrity: integrityLine,
      dashboard,
      tasks,
      commands,
      forbidden,
      rules: [
        'Tu es en lecture + diagnostic seulement',
        'Écriture UNIQUEMENT via staging_queue (commande fournie)',
        'Formule des commandes SSH que Yann copiera',
        'Si une tâche nécessite Claude Code, dis-le clairement'
      ]
    });
  } catch (e) { console.error(`[chatgpt.js] operation failed:`, e.message);
    console.error('[/bruce/chatgpt] Error:', e.message);
    return res.status(500).json({
      ok: false,
      error: e.message,
      elapsed_ms: Date.now() - startMs,
      hint: 'Gateway error — try /bruce/integrity directly'
    });
  }
});

module.exports = router;
