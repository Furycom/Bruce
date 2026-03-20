const { fetchWithTimeout } = require('./fetch-utils');

// ── Topic → bruce_tools category mapping ──
// DYNAMIC: Topics map to bruce_tools categories AND KB tags.
// When a topic is not in this map, we attempt fuzzy matching against bruce_tools categories directly.
const TOPIC_MAPPING = {
  // Core topics
  dspy:       { tool_cats: ['ai', 'ingestion', 'pipeline'], kb_cats: ['tools', 'pipeline', 'architecture'], kb_tags: ['dspy', 'optimization', 'mipro'] },
  docker:     { tool_cats: ['docker_management'], kb_cats: ['docker', 'configuration'], kb_tags: ['docker', 'container', 'compose'] },
  infra:      { tool_cats: ['infrastructure', 'monitoring', 'observability'], kb_cats: ['infrastructure'], kb_tags: ['infrastructure', 'reseau', 'inventaire'] },
  media:      { tool_cats: ['misc'], kb_cats: ['infrastructure'], kb_tags: ['media', 'tmdb', 'plex'] },
  backup:     { tool_cats: ['maintenance'], kb_cats: ['runbook'], kb_tags: ['backup', 'truenas', 'pool'] },
  gateway:    { tool_cats: ['gateway', 'core'], kb_cats: ['architecture', 'governance'], kb_tags: ['gateway', 'architecture', 'endpoint'] },
  session:    { tool_cats: ['session'], kb_cats: ['governance', 'runbook'], kb_tags: ['session', 'bootstrap', 'handoff'] },
  n8n:        { tool_cats: ['maintenance'], kb_cats: ['runbook', 'workflow'], kb_tags: ['n8n', 'workflow', 'automation'] },
  ssh:        { tool_cats: ['ssh'], kb_cats: ['ssh', 'runbook'], kb_tags: ['ssh', 'connexion', 'authentification'] },
  kb:         { tool_cats: ['maintenance', 'indexation'], kb_cats: ['schema', 'governance'], kb_tags: ['kb', 'knowledge', 'staging'] },
  // Extended topics
  llm:        { tool_cats: ['ai', 'pipeline'], kb_cats: ['tools', 'infrastructure', 'configuration'], kb_tags: ['llm', 'qwen', 'llama', 'vllm'] },
  benchmark:  { tool_cats: ['ai'], kb_cats: ['infrastructure', 'tools'], kb_tags: ['benchmark', 'eval', 'performance'] },
  monitoring: { tool_cats: ['monitoring', 'observability'], kb_cats: ['infrastructure', 'runbook'], kb_tags: ['monitoring', 'prometheus', 'grafana', 'pulse'] },
  supabase:   { tool_cats: ['maintenance', 'core'], kb_cats: ['schema', 'runbook', 'database'], kb_tags: ['supabase', 'postgresql', 'database'] },
  database:   { tool_cats: ['maintenance'], kb_cats: ['schema', 'database'], kb_tags: ['database', 'postgresql', 'sql'] },
  pulse:      { tool_cats: ['monitoring'], kb_cats: ['infrastructure'], kb_tags: ['pulse', 'monitoring', 'uptime'] },
  staging:    { tool_cats: ['pipeline', 'ingestion'], kb_cats: ['pipeline', 'schema'], kb_tags: ['staging', 'validate', 'quality'] },
  ingestion:  { tool_cats: ['ingestion', 'pipeline', 'indexation'], kb_cats: ['pipeline', 'tools'], kb_tags: ['ingestion', 'embedding', 'rag'] },
  codex:      { tool_cats: ['gateway', 'core'], kb_cats: ['workflow', 'governance'], kb_tags: ['codex', 'github', 'pr'] },
  migration:  { tool_cats: ['maintenance'], kb_cats: ['schema', 'architecture'], kb_tags: ['migration', 'schema'] },
  screensaver: { tool_cats: ['ai', 'maintenance'], kb_cats: ['architecture', 'governance'], kb_tags: ['screensaver', 'llm', 'batch', 'jobs'] },
  lightrag:   { tool_cats: ['ai', 'indexation'], kb_cats: ['architecture', 'tools'], kb_tags: ['lightrag', 'graph', 'rag', 'entities'] },
  llm_jobs:   { tool_cats: ['ai', 'maintenance'], kb_cats: ['architecture', 'pipeline'], kb_tags: ['llm', 'batch', 'jobs', 'screensaver'] },
  memory:     { tool_cats: ['core'], kb_cats: ['architecture', 'governance'], kb_tags: ['memory', 'bootstrap', 'context', 'tiers'] },
  general:    { tool_cats: ['core', 'maintenance', 'ai', 'infrastructure'], kb_cats: ['governance', 'architecture', 'runbook'], kb_tags: ['gateway', 'architecture', 'governance', 'bootstrap'] },
  bootstrap_tier: { tool_cats: ['core', 'session'], kb_cats: ['architecture', 'governance'], kb_tags: ['bootstrap', 'context', 'tiers', 'memory'] },
};

// Synonyms for topic normalization
const TOPIC_SYNONYMS = {
  'docker-compose': 'docker', compose: 'docker', container: 'docker', containers: 'docker',
  'llama': 'llm', 'qwen': 'llm', model: 'llm', models: 'llm', inference: 'llm',
  'prometheus': 'monitoring', 'grafana': 'monitoring', 'loki': 'monitoring', observability: 'monitoring',
  'sql': 'database', postgres: 'database', postgresql: 'database',
  'n8n-workflow': 'n8n', automation: 'n8n', workflow: 'n8n',
  'kb-maintenance': 'kb', knowledge: 'kb', 'knowledge-base': 'kb',
  'file-transfer': 'ssh', scp: 'ssh',
  'truenas': 'backup', pool: 'backup',
  'health': 'infra', 'health-check': 'infra', network: 'infra',
  'tmdb': 'media', plex: 'media',
  'validate': 'staging', quality: 'staging',
  'embed': 'ingestion', embedding: 'ingestion', rag: 'ingestion',
  'github': 'codex', pr: 'codex',
  'optimize': 'dspy', mipro: 'dspy',
  bootstrap: 'session',
  audit: 'session', context: 'session',
  'light-rag': 'lightrag', graph: 'lightrag', graphrag: 'lightrag',
  screensaver_jobs: 'screensaver', 'llm-jobs': 'llm_jobs', 'batch-jobs': 'llm_jobs',
  tiers: 'bootstrap_tier', 'context-layer': 'bootstrap_tier', '5-tier': 'bootstrap_tier',
};

/**
 * Normalize topic string to a known key.
 * @param {string} raw - Raw topic from user
 * @returns {string} Normalized topic key or 'general'
 */
function normalizeTopic(raw) {
  const key = String(raw || '').toLowerCase().trim().split(/[\s,]+/)[0] || '';
  if (!key) return 'general';
  if (TOPIC_MAPPING[key]) return key;
  if (TOPIC_SYNONYMS[key]) return TOPIC_SYNONYMS[key];
  // Fuzzy: check if topic is a substring of any key or vice versa (min 3 chars to avoid false matches)
  if (key.length >= 3) {
    for (const k of Object.keys(TOPIC_MAPPING)) {
      if (key.includes(k) || k.includes(key)) return k;
    }
  }
  return key || 'general';
}

/**
 * Load contextual KB entries and bruce_tools based on topic.
 * @param {string} topic - Session topic
 * @param {string} supabaseUrl - Base Supabase REST URL
 * @param {string} supabaseKey - Supabase service role key
 * @returns {Promise<{topic: string, matched: boolean, tools_loaded: string[], rules: object[], runbooks: object[]}>}
 */
async function loadTopicContext(topic, supabaseUrl, supabaseKey) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  const key = String(supabaseKey || '');
  const headers = { apikey: key, Authorization: 'Bearer ' + key };

  const topicKey = normalizeTopic(topic);
  const mapping = TOPIC_MAPPING[topicKey] || null;
  const result = { topic: topicKey, matched: !!mapping, tools_loaded: [], rules: [], runbooks: [] };

  if (!base || !key) return result;

  try {
    // ── 1. Load bruce_tools by category ──
    if (mapping) {
      const catFilter = mapping.tool_cats.map((c) => `category.eq.${encodeURIComponent(c)}`).join(',');
      const toolsResp = await fetchWithTimeout(
        `${base}/bruce_tools?or=(${catFilter})&status=eq.active&select=name,category,capability_tag,notes&limit=20`,
        { headers },
        5000,
      );
      if (toolsResp.ok) {
        const tools = await toolsResp.json();
        result.tools_loaded = tools.map((t) => t.name || t.capability_tag).filter(Boolean);
      }
    }

    // ── 2. Load KB entries: rules + runbooks by tags ──
    if (mapping && mapping.kb_tags && mapping.kb_tags.length > 0) {
      const tagFilter = mapping.kb_tags.map((t) => encodeURIComponent(t)).join(',');
      const kbResp = await fetchWithTimeout(
        `${base}/knowledge_base?tags=ov.{${tagFilter}}&select=id,question,answer,category,subcategory&limit=10`,
        { headers },
        5000,
      );
      if (kbResp.ok) {
        const entries = await kbResp.json();
        for (const e of entries) {
          const isRule = e.subcategory === 'anti-patterns' || e.category === 'governance';
          const target = isRule ? result.rules : result.runbooks;
          target.push({
            source: `KB#${e.id}`,
            category: e.category,
            subcategory: e.subcategory,
            text: (e.answer || '').substring(0, 500),
          });
        }
      }
    }

    // ── 3. Load KB entries: runbooks by category ──
    if (mapping && mapping.kb_cats && mapping.kb_cats.length > 0) {
      const catFilter = mapping.kb_cats.map((c) => `category.eq.${encodeURIComponent(c)}`).join(',');
      const existingIds = new Set([...result.rules, ...result.runbooks].map((r) => r.source));
      const runbookResp = await fetchWithTimeout(
        `${base}/knowledge_base?or=(${catFilter})&select=id,question,answer,category,subcategory&order=id.desc&limit=8`,
        { headers },
        5000,
      );
      if (runbookResp.ok) {
        const entries = await runbookResp.json();
        for (const e of entries) {
          const src = `KB#${e.id}`;
          if (existingIds.has(src)) continue;
          existingIds.add(src);
          const isRule = e.subcategory === 'anti-patterns' || (e.category === 'governance' && e.subcategory !== 'session-types');
          const target = isRule ? result.rules : result.runbooks;
          target.push({
            source: src,
            category: e.category,
            subcategory: e.subcategory,
            text: (e.answer || '').substring(0, 500),
          });
        }
      }
    }

    // ── 4. Always load top 5 governance anti-patterns (deduplicated) ──
    const existingIds = new Set([...result.rules, ...result.runbooks].map((r) => r.source));
    const govResp = await fetchWithTimeout(
      `${base}/knowledge_base?category=eq.governance&subcategory=eq.anti-patterns&select=id,question,answer&order=id.asc&limit=5`,
      { headers },
      5000,
    );
    if (govResp.ok) {
      const govEntries = await govResp.json();
      for (const e of govEntries) {
        const src = `KB#${e.id}`;
        if (!existingIds.has(src)) {
          existingIds.add(src);
          result.rules.push({
            source: src,
            category: 'governance',
            subcategory: 'anti-patterns',
            text: (e.answer || '').substring(0, 500),
          });
        }
      }
    }
  } catch (e) {
    console.error('[topic-context][loadTopicContext] Error:', e.message || e);
  }

  return result;
}

module.exports = {
  TOPIC_MAPPING,
  TOPIC_SYNONYMS,
  normalizeTopic,
  loadTopicContext,
};
