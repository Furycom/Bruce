const { fetchWithTimeout } = require('./fetch-utils');

// ── Topic → bruce_tools category mapping (trigger table for contextual bootstrap) ──
const TOPIC_MAPPING = {
  dspy: { tool_cats: ['ai', 'ingestion', 'pipeline'], kb_tags: ['dspy', 'optimization'] },
  docker: { tool_cats: ['docker_management', 'docker_snapshot'], kb_tags: ['docker', 'container'] },
  infra: { tool_cats: ['infrastructure', 'monitoring', 'network', 'observability'], kb_tags: ['infrastructure'] },
  media: { tool_cats: ['media'], kb_tags: ['media', 'tmdb'] },
  backup: { tool_cats: ['backup'], kb_tags: ['backup', 'truenas'] },
  gateway: { tool_cats: ['gateway', 'core'], kb_tags: ['gateway', 'architecture'] },
  session: { tool_cats: ['session'], kb_tags: ['session', 'bootstrap'] },
  n8n: { tool_cats: ['automation'], kb_tags: ['n8n', 'workflow'] },
  ssh: { tool_cats: ['ssh'], kb_tags: ['ssh'] },
  kb: { tool_cats: ['maintenance', 'indexation'], kb_tags: ['kb', 'knowledge'] },
};

/**
 * Load contextual KB entries and bruce_tools based on topic.
 * @param {string} topic - Session topic (e.g., 'dspy', 'docker', 'infra')
 * @param {string} supabaseUrl - Base Supabase REST URL
 * @param {string} supabaseKey - Supabase service role key
 * @returns {Promise<{topic: string, tools_loaded: string[], rules: object[], runbooks: object[]}>}
 */
async function loadTopicContext(topic, supabaseUrl, supabaseKey) {
  const base = String(supabaseUrl || '').replace(/\/+$/, '');
  const key = String(supabaseKey || '');
  const headers = { apikey: key, Authorization: 'Bearer ' + key };

  const topicKey = String(topic || '').toLowerCase().split(/[\s,]+/)[0] || '';
  const mapping = TOPIC_MAPPING[topicKey] || null;
  const result = { topic: topicKey || 'general', tools_loaded: [], rules: [], runbooks: [] };

  if (!base || !key) {
    return result;
  }

  try {
    if (mapping) {
      const catFilter = mapping.tool_cats.map((c) => `category.eq.${encodeURIComponent(c)}`).join(',');
      const toolsResp = await fetchWithTimeout(
        `${base}/bruce_tools?or=(${catFilter})&status=eq.active&select=name,category,capability_tag,notes&limit=15`,
        { headers },
        5000,
      );
      if (toolsResp.ok) {
        const tools = await toolsResp.json();
        result.tools_loaded = tools.map((t) => t.name || t.capability_tag).filter(Boolean);
      }

      const tagFilter = mapping.kb_tags.map((t) => encodeURIComponent(t)).join(',');
      const kbResp = await fetchWithTimeout(
        `${base}/knowledge_base?tags=ov.{${tagFilter}}&select=id,question,answer,category,subcategory&limit=10`,
        { headers },
        5000,
      );
      if (kbResp.ok) {
        const entries = await kbResp.json();
        for (const e of entries) {
          const target = (e.subcategory === 'anti-patterns' || e.category === 'governance') ? result.rules : result.runbooks;
          target.push({
            source: `KB#${e.id}`,
            category: e.category,
            subcategory: e.subcategory,
            text: (e.answer || '').substring(0, 500),
          });
        }
      }
    }

    const govResp = await fetchWithTimeout(
      `${base}/knowledge_base?category=eq.governance&subcategory=eq.anti-patterns&select=id,question,answer&order=id.asc&limit=5`,
      { headers },
      5000,
    );
    if (govResp.ok) {
      const govEntries = await govResp.json();
      const existingIds = new Set(result.rules.map((r) => r.source));
      for (const e of govEntries) {
        const src = `KB#${e.id}`;
        if (!existingIds.has(src)) {
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
  loadTopicContext,
};
