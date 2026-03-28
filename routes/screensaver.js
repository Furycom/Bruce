// routes/screensaver.js — [1036] Dynamic context for screensaver LLM jobs
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');

const VALID_JOBS = ['lesson_review', 'kb_audit', 'dedup_semantic', 'lightrag_populate', 'session_summary', 'ingestion'];

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

async function buildInfraContext() {
  var base = SUPABASE_URL.replace(/\/+$/, '');
  var headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  var sections = [];
  try {
    var kbResp = await fetchWithTimeout(
      base + '/knowledge_base?category=eq.infrastructure&archived=is.false&select=id,question,answer&order=id.desc&limit=15',
      { headers: headers }, 5000
    );
    if (kbResp.ok) {
      var entries = await kbResp.json();
      var infraLines = [];
      for (var i = 0; i < entries.length; i++) {
        var summary = (entries[i].answer || '').substring(0, 200).replace(/\n/g, ' ');
        if (summary.length > 20) infraLines.push('- [KB#' + entries[i].id + '] ' + summary);
      }
      if (infraLines.length > 0) sections.push('INFRASTRUCTURE ACTUELLE (depuis KB):\n' + infraLines.join('\n'));
    }
    var govResp = await fetchWithTimeout(
      base + '/knowledge_base?category=eq.governance&subcategory=eq.anti-patterns&archived=is.false&select=id,answer&order=id.asc&limit=10',
      { headers: headers }, 5000
    );
    if (govResp.ok) {
      var rules = await govResp.json();
      var ruleLines = [];
      for (var j = 0; j < rules.length; j++) {
        ruleLines.push('- [KB#' + rules[j].id + '] ' + (rules[j].answer || '').substring(0, 150).replace(/\n/g, ' '));
      }
      if (ruleLines.length > 0) sections.push('REGLES DE GOUVERNANCE:\n' + ruleLines.join('\n'));
    }
    var llmResp = await fetchWithTimeout(
      base + '/knowledge_base?tags=ov.{llm,qwen,llama}&archived=is.false&select=id,answer&limit=5',
      { headers: headers }, 5000
    );
    if (llmResp.ok) {
      var llmEntries = await llmResp.json();
      var llmLines = [];
      for (var k = 0; k < llmEntries.length; k++) {
        llmLines.push('- [KB#' + llmEntries[k].id + '] ' + (llmEntries[k].answer || '').substring(0, 200).replace(/\n/g, ' '));
      }
      if (llmLines.length > 0) sections.push('MODELES LLM (depuis KB):\n' + llmLines.join('\n'));
    }
  } catch (err) {
    console.error('[screensaver-context] KB fetch error:', err.message);
    sections.push('ERREUR: Impossible de charger le contexte KB dynamique.');
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

router.post('/bruce/screensaver/context', async function(req, res) {
  var auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  var startMs = Date.now();
  var jobType = (req.body || {}).job_type;
  if (!jobType || VALID_JOBS.indexOf(jobType) === -1) {
    return res.status(400).json({ ok: false, error: 'Invalid job_type. Must be one of: ' + VALID_JOBS.join(', ') });
  }
  try {
    var infraSections = await buildInfraContext();
    var obsoleteBlock = buildObsoleteBlock();
    var jobRules = buildJobRules(jobType);
    var now = new Date().toISOString().split('T')[0];
    var contextBlock = [
      'CONTEXTE DYNAMIQUE BRUCE (genere ' + now + ')',
      '',
      infraSections.join('\n\n'),
      '',
      obsoleteBlock,
      '',
      'ARCHITECTURE ACTUELLE:',
      '- Write-path: POST /bruce/write -> staging_queue -> validate.py -> canonical REST. PAS PostgREST direct.',
      '- Bootstrap: claude.md v7.1 -> Memory MCP -> POST /bruce/bootstrap -> context_prompt + context.',
      '- SSH: TOUJOURS via alias (furymcp, furycomai, furysupa), JAMAIS IP directe.',
      '- LLM multi-modele: MoE35B (triage+dedup+lesson_review DSPy 100%), 14B (kb_audit DSPy 97%), 32B Alpha (lesson_review+ingestion+session_summary+kb_audit fallback). 9B review ABANDONNE.',
      '',
      jobRules,
    ].join('\n');
    res.json({ ok: true, job_type: jobType, context: contextBlock, context_length: contextBlock.length, generated_at: new Date().toISOString(), elapsed_ms: Date.now() - startMs });
  } catch (err) {
    console.error('[screensaver-context] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;