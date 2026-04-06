'use strict';
const { Router } = require('express');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');

const router = Router();

/**
 * GET /tools — Legacy tool list (backward compat).
 */
router.get('/tools', (req, res) => {
  res.json({
    tools: [
      { name: 'echo', description: 'Echo back the provided text payload.', endpoint: '/tools/echo', method: 'POST' },
      { name: 'supabase.exec_sql', description: 'Execute a SQL string via Supabase RPC exec_sql.', endpoint: '/tools/supabase/exec-sql', method: 'POST' },
      { name: 'manual.get_page', description: 'Return raw markdown of a doc page.', endpoint: '/manual/page', method: 'GET', params: ['path'] },
      { name: 'manual.search', description: 'Search homelab manual markdown files.', endpoint: '/manual/search', method: 'GET', params: ['query'] },
      { name: 'bruce.chat', description: 'Chat endpoint for Bruce LLM backend.', endpoint: '/chat', method: 'POST' },
    ],
    _note: 'Legacy endpoint. Use GET /bruce/tools/catalog for the complete catalog.',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /bruce/tools/catalog — Universal tool discovery [1193].
 * Gateway First universelle: tout LLM peut decouvrir les outils disponibles.
 */
router.get('/bruce/tools/catalog', (req, res) => {
  const catalog = {
    version: '1.0.0',
    description: 'BRUCE MCP Gateway — catalogue complet des outils disponibles',
    updated: new Date().toISOString(),
    categories: {
      session: {
        description: 'Gestion de session BRUCE',
        tools: [
          { name: 'bootstrap', endpoint: 'POST /bruce/bootstrap', description: 'Point entree OBLIGATOIRE. Charge contexte complet: integrite, dashboard, handoff, regles, runbooks, RAG, LightRAG.' },
          { name: 'session_init', endpoint: 'POST /bruce/session/init', description: 'Initialiser une session BRUCE.' },
          { name: 'session_close', endpoint: 'POST /bruce/session/close', description: 'Fermer une session. Params: session_id, summary, handoff_next, tasks_done.' },
        ]
      },
      data_read: {
        description: 'Lecture de donnees BRUCE',
        tools: [
          { name: 'kb_search', endpoint: 'POST /bruce/rag/search', description: 'Recherche semantique hybride KB. Params: query, limit.' },
          { name: 'roadmap_list', endpoint: 'GET /bruce/roadmap', description: 'Liste taches roadmap. Filtres: status, priority, model_hint.' },
          { name: 'roadmap_get', endpoint: 'GET /bruce/roadmap/:id', description: 'Detail tache roadmap par ID.' },
          { name: 'topology', endpoint: 'GET /bruce/topology', description: 'Carte infrastructure: machines, VMs, services, ports.' },
          { name: 'healthz', endpoint: 'GET /bruce/healthz', description: 'Health check gateway.' },
          { name: 'integrity', endpoint: 'GET /bruce/integrity', description: 'Verification integrite tous services.' },
          { name: 'context_rules', endpoint: 'POST /bruce/context/rules', description: 'Inspecter regles contextuelles pour un outil/commande.' },
          { name: 'tools_catalog', endpoint: 'GET /bruce/tools/catalog', description: 'Ce catalogue — liste complete des outils.' },
        ]
      },
      data_write: {
        description: 'Ecriture de donnees BRUCE',
        tools: [
          { name: 'kb_write', endpoint: 'POST /bruce/write', description: 'Ecrire via staging+Gate-1. Champs: table_cible, contenu_json.' },
          { name: 'roadmap_update', endpoint: 'PATCH /bruce/roadmap/:id', description: 'Mettre a jour tache roadmap.' },
          { name: 'file_write', endpoint: 'POST /bruce/file/write', description: 'Ecrire fichier dans container. Champs: filepath, content. /home/furycom/uploads/ = bind mount host .230.' },
        ]
      },
      execution: {
        description: 'Execution de commandes',
        tools: [
          { name: 'bruce_exec', endpoint: 'POST /bruce/exec', description: 'Executer commande dans container gateway. Whitelist active.' },
          { name: 'ssh_exec', endpoint: 'POST /bruce/ssh/exec', description: 'Executer commande SSH sur host distant. Params: host (IP), command. Whitelist active.' },
        ]
      },
      llm: {
        description: 'Gestion LLM local',
        tools: [
          { name: 'llm_status', endpoint: 'GET /bruce/llm/status', description: 'Etat LLM local (modele charge, GPU).' },
          { name: 'llm_swap', endpoint: 'POST /bruce/llm/swap', description: 'Changer modele LLM sur GPU.' },
        ]
      }
    },
    mcp_native_only: [
      'Desktop Commander', 'PowerShell', 'Memory MCP', 'homelab-semantic-search-advanced',
      'proxmox', 'docker', 'grafana', 'prometheus', 'n8n-mcp', 'postgres'
    ],
    usage: 'LLM locaux (OpenWebUI) utilisent call_gateway. MCP natifs uniquement depuis Claude Desktop.'
  };
  res.json(catalog);
});

/**
 * POST /tools/echo — Echo test.
 */
router.post('/tools/echo', (req, res) => {
  res.json({ ok: true, input: req.body || null, timestamp: new Date().toISOString() });
});

/**
 * POST /tools/supabase/exec-sql — Execute SQL via Supabase RPC.
 */
router.post('/tools/supabase/exec-sql', async (req, res) => {
  try {
    const sql = String((req.body && (req.body.sql || req.body.query)) ? (req.body.sql || req.body.query) : '').trim().replace(/;+\s*$/, '');
    if (!sql) {
      return res.status(400).json({ ok: false, status: 400, error: 'Missing sql' });
    }
    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key  = String(SUPABASE_KEY || '');
    if (!base) return res.status(500).json({ ok: false, status: 500, error: 'SUPABASE_URL missing' });
    if (!key) return res.status(500).json({ ok: false, status: 500, error: 'SUPABASE_KEY missing' });

    const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
    const rpcUrl = useRestV1
      ? `${base.replace(/\/rest\/v1$/, '')}/rest/v1/rpc/exec_sql`
      : `${base}/rpc/exec_sql`;
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'apikey': key };
    const response = await fetch(rpcUrl, { method: 'POST', headers, body: JSON.stringify({ query: sql }) });
    const text = await response.text();
    if (!response.ok) return res.status(200).json({ ok: false, status: response.status, error: text || `HTTP ${response.status}` });

    let parsed;
    try { parsed = text ? JSON.parse(text) : null; }
    catch (e) { return res.status(200).json({ ok: false, status: response.status, error: `JSON parse: ${e.message}`, raw: text }); }

    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) ? parsed.data : parsed;
    return res.status(200).json({ ok: true, status: response.status, data });
  } catch (err) {
    console.error('[tools.js] exec-sql failed:', err.message);
    return res.status(200).json({ ok: false, status: 500, error: err.message || String(err) });
  }
});

module.exports = router;
