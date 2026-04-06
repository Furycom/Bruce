// routes/data-write.js — [773] C7 REFONTE + [PA4-S1329] Schema validation + [1226] Auto-classeur S1338
// Route: POST /bruce/write
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  BRUCE_AUTH_TOKEN,
  VALIDATE_SERVICE_URL,
} = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');
const { autoClassifyScope } = require('./scope-classifier');

// [PA4-S1329] Colonnes valides par table (verifiees en production)
// Colonnes auto-gerees (retirees silencieusement si presentes): id, created_at, updated_at, content_hash
const TABLE_SCHEMAS = {
  knowledge_base: new Set([
    'question', 'answer', 'category', 'subcategory', 'tags', 'tag_domain',
    'author_system', 'confidence_score', 'validated', 'actor', 'session_id',
    'intent', 'data_family', 'canonical_lock', 'authority_tier', 'protection_level',
    'project_scope', 'archived', 'llm_model', 'script_version', 'job_type',
    'screensaver_reviewed_at', 'bootstrap_critical', 'is_canon',
    'canon_promoted_at', 'canon_promoted_by', 'screensaver_keep_count',
    'screensaver_cycle_count', 'canon_nominated', 'canon_nomination_source',
    'canon_nomination_score',
    'lifecycle_status', 'project_id', 'screensaver_jobs_completed',
  ]),
  lessons_learned: new Set([
    'lesson_text', 'lesson_type', 'importance', 'date_learned',
    'author_system', 'confidence_score', 'validated', 'actor', 'session_id',
    'intent', 'data_family', 'canonical_lock', 'authority_tier', 'protection_level',
    'project_scope', 'archived', 'llm_model', 'script_version', 'job_type',
    'screensaver_reviewed_at',
    'lifecycle_status', 'project_id', 'screensaver_jobs_completed',
  ]),
  roadmap: new Set([
    'step_name', 'description', 'status', 'priority', 'model_hint',
    'author_system', 'data_family', 'project_scope', 'evidence',
    'acceptance_criteria', 'verified_at', 'verified_by',
    'project_id',
  ]),
  session_history: new Set([
    'summary', 'tasks_completed', 'notes', 'session_start', 'session_end',
    'author_system', 'data_family', 'project_scope', 'profile_used',
    'tokens_bootstrap', 'tokens_infrastructure', 'tokens_llm_est',
    'ssh_ops_count', 'rest_ops_count', 'validated',
  ]),
  current_state: new Set([
    'key', 'value', 'data_family', 'canonical_lock', 'authority_tier',
    'protection_level',
  ]),
};

// Colonnes auto-gerees: retirees silencieusement
const AUTO_COLS = new Set(['id', 'created_at', 'updated_at', 'content_hash']);

function validateColumns(table, obj) {
  const schema = TABLE_SCHEMAS[table];
  if (!schema) return { cleaned: obj, warnings: [] };

  const cleaned = {};
  const warnings = [];
  const stripped = [];

  for (const [key, val] of Object.entries(obj)) {
    if (AUTO_COLS.has(key)) {
      stripped.push(key);
      continue;
    }
    if (schema.has(key)) {
      cleaned[key] = val;
    } else {
      warnings.push(key);
    }
  }

  return { cleaned, warnings, stripped };
}

router.post('/bruce/write', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { table_cible, contenu_json, author_system, content_hash, auto_validate } = req.body || {};

  const ALLOWED_TABLES = ['lessons_learned', 'knowledge_base', 'current_state', 'roadmap', 'session_history', 'clarifications_pending', 'projects'];
  if (!table_cible || !ALLOWED_TABLES.includes(table_cible)) {
    return res.status(400).json({ ok: false, error: 'table_cible invalide ou manquante. Tables autorisees: ' + ALLOWED_TABLES.join(', ') });
  }

  // [S1327] GUARD: roadmap PATCH via kb_write est silencieusement invalide.
  let _check = contenu_json;
  if (typeof _check === 'string') { try { _check = JSON.parse(_check); } catch(e) {} }
  if (table_cible === 'roadmap' && _check && typeof _check === 'object' && _check.id) {
    return res.status(400).json({
      ok: false,
      error: '[S1327] ROADMAP UPDATE interdit via kb_write (INSERT uniquement). SOLUTION CANON: ecrire payload JSON via bruce_file_write vers /home/furycom/uploads/patch.json puis curl -s -X PATCH "http://192.168.2.146:8000/rest/v1/roadmap?id=eq.{ID}" -d @/home/furycom/uploads/patch.json avec headers Supabase. Voir KB#1220.'
    });
  }

  // [1184] Fix: MCP bridge serialise contenu_json en string
  let parsedContenu = contenu_json;
  if (typeof contenu_json === 'string') {
    try { parsedContenu = JSON.parse(contenu_json); }
    catch (e) { return res.status(400).json({ ok: false, error: 'contenu_json est une string non-JSON: ' + e.message }); }
  }
  if (!parsedContenu || typeof parsedContenu !== 'object') {
    return res.status(400).json({ ok: false, error: 'contenu_json manquant ou invalide (type=' + typeof contenu_json + ')' });
  }

  // [PA4-S1329] Valider colonnes avant push staging
  const colCheck = validateColumns(table_cible, parsedContenu);
  if (colCheck.warnings.length > 0) {
    return res.status(400).json({
      ok: false,
      error: '[PA4] Colonnes invalides pour ' + table_cible + ': ' + colCheck.warnings.join(', ') + '. Ces colonnes n\'existent PAS dans la table. Verifier KB#1247 (roadmap) ou KB#1248 (lessons_learned) pour le schema exact.',
      invalid_columns: colCheck.warnings,
    });
  }
  // Utiliser le JSON nettoye (sans colonnes auto-gerees)
  parsedContenu = colCheck.cleaned;
  const _stripped = colCheck.stripped || [];

  // [1226] Auto-classeur projets S1338 — classification automatique du project_scope
  let scopeClassification = null;
  try {
    scopeClassification = await autoClassifyScope(table_cible, parsedContenu);
    if (scopeClassification.applied) {
      parsedContenu.project_scope = scopeClassification.classified;
      if (scopeClassification.project_id != null && !parsedContenu.project_id) {
        parsedContenu.project_id = scopeClassification.project_id;
      }
      console.log(`[1367] Auto-classified scope=${scopeClassification.classified} project_id=${scopeClassification.project_id} (score=${scopeClassification.detail.score}, table=${table_cible})`);
    }
  } catch (classErr) {
    console.error('[1226] scope-classifier error (non-blocking):', classErr.message);
    // Non-blocking: if classifier fails, keep original scope
  }

  // [1446] S1442: project_id OBLIGATOIRE pour KB, lessons, roadmap
  const REQUIRE_PROJECT_ID = ['knowledge_base', 'lessons_learned', 'roadmap'];
  if (REQUIRE_PROJECT_ID.includes(table_cible) && !parsedContenu.project_id) {
    return res.status(400).json({
      ok: false,
      error: '[1446] project_id obligatoire pour ' + table_cible + '. Le scope-classifier n\'a pas pu determiner le projet automatiquement. Ajouter project_id explicitement dans contenu_json.',
      fix: 'Ajouter "project_id": <id_projet> dans contenu_json. Liste des projets: GET /rest/v1/projects?select=id,name,keywords',
    });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };

  try {
    if (table_cible === 'lessons_learned' && parsedContenu && !parsedContenu.lesson_type) {
      parsedContenu.lesson_type = 'solution';
      console.log('[779] lesson_type absent -> fallback solution injecte');
    }

    const stagingPayload = { table_cible, contenu_json: parsedContenu, author_system: author_system || 'mcp-gateway', content_hash: content_hash || null };
    const stagingRes = await fetchWithTimeout(base + '/staging_queue', { method: 'POST', headers: hSupa, body: JSON.stringify(stagingPayload) }, 8000);

    if (!stagingRes.ok) {
      const errText = await stagingRes.text();
      return res.status(stagingRes.status).json({ ok: false, error: 'staging_queue push failed: ' + errText });
    }

    const stagingData = await stagingRes.json();
    const stagingId = Array.isArray(stagingData) ? stagingData[0]?.id : stagingData?.id;

    const shouldValidate = auto_validate !== false;
    let validateResult = null;

    if (shouldValidate) {
      try {
        const valRes = await fetchWithTimeout(VALIDATE_SERVICE_URL + '/run/validate', { method: 'POST', headers: { 'X-BRUCE-TOKEN': String(process.env.BRUCE_AUTH_TOKEN || '') } }, 20000);
        const valData = await valRes.json();
        validateResult = {
          exit: valData?.validate?.exit,
          valides: (valData?.validate?.stdout || '').match(/Valides:\s+(\d+)/)?.[1] || '?',
          erreurs: (valData?.validate?.stdout || '').match(/Erreurs:\s+(\d+)/)?.[1] || '?'
        };
      } catch(ve) { validateResult = { error: 'validate non disponible: ' + ve.message }; }
    }

    const validesCount = parseInt(validateResult?.valides) || 0;
    const wasValidated = shouldValidate && validateResult?.exit === 0 && validesCount > 0;

    let rejectionReason = null;
    if (shouldValidate && validateResult?.exit === 0 && validesCount === 0 && stagingId) {
      try {
        const stgCheck = await fetchWithTimeout(base + '/staging_queue?id=eq.' + stagingId + '&select=status,rejection_reason', { headers: hSupa }, 5000);
        const stgData = await stgCheck.json();
        const stgEntry = Array.isArray(stgData) ? stgData[0] : stgData;
        if (stgEntry?.rejection_reason) rejectionReason = stgEntry.rejection_reason;
        if (stgEntry?.status === 'rejected' && !rejectionReason) rejectionReason = 'Rejected by validate.py (no reason captured)';
      } catch(re) { console.error('[data-write.js] rejection fetch error:', re.message || re); }
    }

    // [S1442] Write to audit_log for traceability (who did what)
    if (wasValidated && ['knowledge_base', 'lessons_learned'].includes(table_cible)) {
      try {
        const actorType = (author_system || parsedContenu.author_system || 'unknown');
        const itemType = table_cible === 'knowledge_base' ? 'kb' : 'lesson';
        const auditEntry = {
          item_type: itemType,
          item_id: stagingId,
          action: 'gateway_insert',
          job_type: 'gateway',
          actor_type: actorType,
          actor_name: actorType,
          script_version: 'data-write.js',
          new_values: { table: table_cible, project_id: parsedContenu.project_id },
        };
        fetchWithTimeout(base + '/screensaver_audit_log', {
          method: 'POST', headers: hSupa, body: JSON.stringify(auditEntry)
        }, 5000).catch(e => console.error('[S1442] audit_log write failed:', e.message));
      } catch(ae) { console.error('[S1442] audit_log error:', ae.message); }
    }

    const response = { ok: true, staging_id: stagingId, table_cible, validated: wasValidated, validate_result: validateResult };
    if (rejectionReason) response.rejection_reason = rejectionReason;
    if (_stripped.length > 0) response._stripped_auto_cols = _stripped;
    // [1226] Include classification info in response
    if (scopeClassification && scopeClassification.applied) {
      response._scope_classified = { from: scopeClassification.original, to: scopeClassification.classified, score: scopeClassification.detail.score };
    }
    return res.json(response);

  } catch(e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
