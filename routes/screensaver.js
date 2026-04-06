// routes/screensaver.js — [1036][1228] Dynamic context for screensaver LLM jobs
// v2.0 S1337: Enriched with RAG semantic + LightRAG intelligent context
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY, EMBEDDER_URL } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');
const { fetchLightRAGContext, estimateTokens, truncateToTokens } = require('../shared/context-engine');

const VALID_JOBS = ['lesson_review', 'kb_audit', 'dedup_semantic', 'lightrag_populate', 'session_summary', 'ingestion', 'vrc_pipeline'];

const OBSOLETE_TECH = [
  { name: 'vLLM', replacement: 'llama.cpp server-cuda', detail: 'Toute mention de vllm serve, vLLM API, VLLMExtractor est obsolete' },
  { name: 'Qwen 7B / Qwen2.5-7B-Instruct-AWQ / Qwen 2.5 8B', replacement: 'Qwen3-32B Q4_K_M', detail: 'Retires' },
  { name: 'Ollama sur .32', replacement: 'llama.cpp', detail: 'Retire' },
  { name: '192.168.2.206 (ancien Supabase)', replacement: '192.168.2.146 (furysupa)', detail: 'Migre. .206 est MORT.' },
  { name: 'Gate-2 validation vLLM', replacement: 'Gate-1 schema + triggers PG', detail: 'Abandonnee precision 23%' },
  { name: 'CURRENT_STATE table', replacement: 'Memory MCP 5-tier (BRUCE_STATE + PIEGES_ACTIFS)', detail: 'Remplace' },
  { name: 'Handoff via current_state JSON', replacement: 'Memory MCP + POST /bruce/session/close', detail: 'Remplace' },
  { name: 'vllm service name', replacement: 'llama-server', detail: 'Renomme' },
];

// [1228] Build topic string for RAG queries based on job type and item hint
function buildSearchTopic(jobType, itemHint) {
  var topicMap = {
    lesson_review: 'lesson review qualite BRUCE homelab',
    kb_audit: 'knowledge base audit coherence infrastructure',
    dedup_semantic: 'deduplication lessons knowledge base',
    session_summary: 'session summary extraction taches decisions',
    ingestion: 'ingestion extraction faits techniques homelab',
    lightrag_populate: 'LightRAG graph knowledge ingestion',
    vrc_pipeline: 'knowledge base canon evaluation quality audit architecture VRC pipeline gates',
  };
  var base = topicMap[jobType] || 'BRUCE homelab';
  if (itemHint && typeof itemHint === 'string' && itemHint.length > 10) {
    // Extract key terms from item hint (first 150 chars, cleaned)
    var hint = itemHint.substring(0, 150).replace(/[^a-zA-Z0-9\u00C0-\u017F .,-]/g, ' ').trim();
    return hint + ' ' + base;
  }
  return base;
}

// [1228] Fetch RAG semantic context for the screensaver job
async function fetchRAGContext(topic, budgetTokens) {
  try {
    var embedRes = await fetchWithTimeout(
      EMBEDDER_URL + '/embed',
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: topic.substring(0, 256), max_length: 256 }) },
      6000
    );
    var embedData = await embedRes.json();
    var embedding = Array.isArray(embedData) ? embedData[0] : (embedData && embedData.embeddings && embedData.embeddings[0]);
    if (!embedding) return null;

    var base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    var hSupa = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
    var qvec = '[' + embedding.map(function(x) { return Number(x); }).join(',') + ']';
    var ragRes = await fetchWithTimeout(
      base + '/rpc/bruce_rag_hybrid_search_text',
      { method: 'POST', headers: hSupa,
        body: JSON.stringify({ qtext: topic.substring(0, 200), qvec: qvec, k: 8 }) },
      8000
    );
    var ragData = await ragRes.json();
    if (!Array.isArray(ragData) || ragData.length === 0) return null;

    var items = ragData.slice(0, 6).map(function(r) {
      var score = Math.round((r.hybrid_score || r.cos_sim || 0) * 100) / 100;
      var preview = truncateToTokens((r.preview || '').trim(), 80);
      return '(' + score + ') ' + preview;
    });
    var ragText = 'CONTEXTE RAG SEMANTIQUE:\n' + items.join('\n');
    return truncateToTokens(ragText, budgetTokens);
  } catch (err) {
    console.error('[screensaver-context][1228] RAG error:', err.message);
    return null;
  }
}

// [1228] Fetch bootstrap-critical KB for essential context
async function fetchBootstrapCriticalKB(budgetTokens) {
  try {
    var base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    var headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
    var resp = await fetchWithTimeout(
      base + '/knowledge_base?bootstrap_critical=eq.true&archived=is.false&select=id,question,answer&limit=15',
      { headers: headers }, 5000
    );
    if (!resp.ok) return null;
    var entries = await resp.json();
    if (!Array.isArray(entries) || entries.length === 0) return null;

    var lines = entries.map(function(e) {
      var summary = (e.answer || '').substring(0, 120).replace(/\n/g, ' ');
      return '- [KB#' + e.id + '] ' + summary;
    });
    var text = 'KB BOOTSTRAP-CRITICAL (regles immuables):\n' + lines.join('\n');
    return truncateToTokens(text, budgetTokens);
  } catch (err) {
    console.error('[screensaver-context][1228] Bootstrap KB error:', err.message);
    return null;
  }
}

// Original static infra context (kept as fallback/complement)
async function buildInfraContext() {
  var base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  var headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  var sections = [];
  try {
    var kbResp = await fetchWithTimeout(
      base + '/knowledge_base?category=eq.infrastructure&archived=is.false&select=id,question,answer&order=id.desc&limit=10',
      { headers: headers }, 5000
    );
    if (kbResp.ok) {
      var entries = await kbResp.json();
      var infraLines = [];
      for (var i = 0; i < entries.length; i++) {
        var summary = (entries[i].answer || '').substring(0, 150).replace(/\n/g, ' ');
        if (summary.length > 20) infraLines.push('- [KB#' + entries[i].id + '] ' + summary);
      }
      if (infraLines.length > 0) sections.push('INFRASTRUCTURE ACTUELLE:\n' + infraLines.join('\n'));
    }
  } catch (err) {
    console.error('[screensaver-context] Infra KB fetch error:', err.message);
  }
  return sections;
}

function buildObsoleteBlock() {
  var lines = [];
  for (var i = 0; i < OBSOLETE_TECH.length; i++) {
    var t = OBSOLETE_TECH[i];
    lines.push('- ' + t.name + ' -> REMPLACE PAR: ' + t.replacement + '. ' + t.detail);
  }
  return 'TECHNOLOGIES OBSOLETES (archiver si presentees comme actuelles):\n' + lines.join('\n');
}

function buildJobRules(jobType) {
  var common = [
    'JAMAIS archiver les lessons de type user_wish. Les souhaits de Yann sont sacres.',
    'JAMAIS upgrader a critical une lesson mentionnant une technologie obsolete.',
    'Les lessons <80 caracteres sans information actionnable doivent etre archivees.',
    'improved_text doit etre concis, max 300 chars. Ne pas recopier le texte original.',
    'JAMAIS promouvoir a critical un evenement PONCTUEL ou TERMINE.',
    'Les lessons documentant une decision historique sont valides comme historique low/normal.',
    'JAMAIS raccourcir une lesson au point de perdre IPs, noms de fichiers, commandes.',
  ];
  var jobSpecific = {
    lesson_review: [
      'Si .206 reference comme Supabase actif -> OBSOLETE.',
      'Si vLLM/Qwen7B/Qwen2.5-8B prescrits comme actuels -> OBSOLETE.',
      'Si Gate-2/CURRENT_STATE/roadmap_extractor vLLM references comme workflow actif -> OBSOLETE.',
    ],
    kb_audit: [
      'Verifier coherence entre KB et infra actuelle.',
      'KB avec secrets/tokens en clair -> signaler pour nettoyage.',
      'KB contradictoires -> archiver la plus ancienne.',
    ],
    dedup_semantic: [
      'Similarite > 0.85 = doublon probable. Garder la plus recente/complete.',
      'Ne jamais deduper des user_wish meme similaires.',
    ],
    session_summary: [
      'Extraire: taches completees, decisions, erreurs, handoff.',
      'Identifier: user_wishes, user_profile updates, discoveries.',
    ],
    ingestion: [
      'Extraire TOUS les faits techniques: IPs, ports, noms de fichiers, commandes.',
      'Classification: user_wish > decision > regle > observation.',
    ],
  };
  var specific = jobSpecific[jobType] || [];
  var allRules = common.concat(specific);
  var result = [];
  for (var i = 0; i < allRules.length; i++) {
    result.push((i + 1) + '. ' + allRules[i]);
  }
  return 'REGLES STRICTES:\n' + result.join('\n');
}

// [1228] Main endpoint — enriched with RAG semantic + LightRAG context
router.post('/bruce/screensaver/context', async function(req, res) {
  var auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  var startMs = Date.now();
  var jobType = (req.body || {}).job_type;
  var itemHint = (req.body || {}).item_hint || '';
  if (!jobType || VALID_JOBS.indexOf(jobType) === -1) {
    return res.status(400).json({ ok: false, error: 'Invalid job_type. Must be one of: ' + VALID_JOBS.join(', ') });
  }

  try {
    // Build search topic from job type + item content
    var searchTopic = buildSearchTopic(jobType, itemHint);

    // [1228] Fetch all context sources in parallel for speed
    var results = await Promise.all([
      fetchRAGContext(searchTopic, 250).catch(function() { return null; }),
      fetchLightRAGContext(searchTopic, 200).catch(function() { return null; }),
      fetchBootstrapCriticalKB(200).catch(function() { return null; }),
      buildInfraContext().catch(function() { return []; }),
    ]);

    var ragContext = results[0];
    var lightragContext = results[1];
    var bootstrapKB = results[2];
    var infraSections = results[3];
    var obsoleteBlock = buildObsoleteBlock();
    var jobRules = buildJobRules(jobType);
    var now = new Date().toISOString().split('T')[0];

    // Track which sources contributed
    var sourcesUsed = [];

    var contextParts = [
      'CONTEXTE DYNAMIQUE BRUCE v2 (genere ' + now + ', job: ' + jobType + ')',
    ];

    // 1. Bootstrap-critical KB (always first — immutable rules)
    if (bootstrapKB) {
      contextParts.push(bootstrapKB);
      sourcesUsed.push('bootstrap_critical');
    }

    // 2. RAG semantic (item-specific if item_hint provided)
    if (ragContext) {
      contextParts.push(ragContext);
      sourcesUsed.push('rag_semantic');
    }

    // 3. LightRAG graph context (relational knowledge)
    if (lightragContext && lightragContext.text) {
      var lrText = 'CONTEXTE GRAPHE LIGHTRAG:\n' + truncateToTokens(lightragContext.text, 200);
      contextParts.push(lrText);
      sourcesUsed.push('lightrag_graph');
    }

    // 4. Infrastructure KB (reduced — bootstrap + RAG already cover most)
    if (infraSections.length > 0) {
      contextParts.push(infraSections.join('\n'));
      sourcesUsed.push('infra_kb');
    }

    // 5. Obsolete tech (always — compact, essential for review/audit)
    contextParts.push(obsoleteBlock);
    sourcesUsed.push('obsolete_tech');

    // 6. Architecture summary (compact)
    contextParts.push(
      'ARCHITECTURE ACTUELLE:',
      '- Write-path: POST /bruce/write -> staging_queue -> validate.py -> canonical REST.',
      '- SSH: TOUJOURS via alias (furymcp, furycomai, furysupa), JAMAIS IP directe.',
      '- LLM: Qwen3-32B Alpha principal. Screensaver reviewed_at + is_canon + bootstrap_critical.',
      '- Supabase .146. Gateway .230:4000. LLM .32:8000. Embedder .85:8081. LightRAG .230:9621.'
    );

    // 7. Job-specific rules (always last — closest to the task)
    contextParts.push(jobRules);
    sourcesUsed.push('job_rules');

    var contextBlock = contextParts.join('\n\n');
    var totalTokens = estimateTokens(contextBlock);

    res.json({
      ok: true,
      job_type: jobType,
      context: contextBlock,
      context_length: contextBlock.length,
      context_tokens: totalTokens,
      sources_used: sourcesUsed,
      item_hint_used: itemHint.length > 0,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startMs
    });
  } catch (err) {
    console.error('[screensaver-context][1228] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;