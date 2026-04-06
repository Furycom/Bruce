// routes/data-patch.js — [S1426-T04] PATCH endpoint for screensaver + other consumers
// Route: POST /bruce/patch
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');

// Colonnes valides par table pour PATCH (superset of write — includes screensaver fields)
const PATCH_SCHEMAS = {
  knowledge_base: new Set([
    'question', 'answer', 'category', 'subcategory', 'tags', 'tag_domain',
    'author_system', 'confidence_score', 'validated', 'actor', 'session_id',
    'intent', 'data_family', 'canonical_lock', 'authority_tier', 'protection_level',
    'project_scope', 'project_id', 'archived', 'llm_model', 'script_version', 'job_type',
    'screensaver_reviewed_at', 'bootstrap_critical', 'is_canon',
    'canon_promoted_at', 'canon_promoted_by', 'screensaver_keep_count',
    'screensaver_cycle_count', 'canon_nominated', 'canon_nomination_source',
    'canon_nomination_score', 'screensaver_jobs_completed', 'content_hash',
    'lifecycle_status',
  ]),
  lessons_learned: new Set([
    'lesson_text', 'lesson_type', 'importance', 'date_learned',
    'author_system', 'confidence_score', 'validated', 'actor', 'session_id',
    'intent', 'data_family', 'canonical_lock', 'authority_tier', 'protection_level',
    'project_scope', 'project_id', 'archived', 'llm_model', 'script_version', 'job_type',
    'screensaver_reviewed_at', 'screensaver_jobs_completed', 'content_hash',
    'lifecycle_status',
  ]),
  roadmap: new Set([
    'step_name', 'description', 'status', 'priority', 'model_hint',
    'author_system', 'data_family', 'project_scope', 'project_id', 'evidence',
    'acceptance_criteria', 'verified_at', 'verified_by',
  ]),
  media_library: new Set([
    'title', 'year', 'media_type', 'quality_tier', 'is_best_copy', 'is_complete',
    'tmdb_id', 'imdb_id', 'project_id',
  ]),
  session_history: new Set([
    'notes', 'summary', 'tasks_completed', 'author_system', 'session_start', 'session_end',
  ]),
  current_state: new Set([
    'key', 'value',
  ]),
  clarifications_pending: new Set([
    'status', 'answer', 'answered_at',
  ]),
};

// Colonnes auto-gerees: retirees silencieusement
const AUTO_COLS = new Set(['id', 'created_at', 'updated_at']);

// [1287] Protected types — refuse to archive these
const PROTECTED_LESSON_TYPES = new Set(['rule_canon', 'user_wish']);

router.post('/bruce/patch', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { table, match, patch } = req.body || {};

  if (!table || !match || !patch) {
    return res.status(400).json({ ok: false, error: 'Champs requis: table, match (ex: {id: 123}), patch (ex: {archived: true})' });
  }

  const ALLOWED = Object.keys(PATCH_SCHEMAS);
  if (!ALLOWED.includes(table)) {
    return res.status(400).json({ ok: false, error: `Table '${table}' non autorisee. Tables: ${ALLOWED.join(', ')}` });
  }

  // Validate columns
  const schema = PATCH_SCHEMAS[table];
  const cleaned = {};
  const warnings = [];
  for (const [key, val] of Object.entries(patch)) {
    if (AUTO_COLS.has(key)) continue;
    if (schema.has(key)) {
      cleaned[key] = val;
    } else {
      warnings.push(key);
    }
  }
  if (warnings.length > 0) {
    return res.status(400).json({ ok: false, error: `Colonnes invalides pour ${table}: ${warnings.join(', ')}`, invalid_columns: warnings });
  }
  if (Object.keys(cleaned).length === 0) {
    return res.status(400).json({ ok: false, error: 'Payload vide apres filtrage colonnes' });
  }

  // [1287] Guard: refuse to archive protected lessons
  if (cleaned.archived === true && table === 'lessons_learned' && match.id) {
    try {
      const base = String(SUPABASE_URL).replace(/\/+$/, '');
      const key = String(SUPABASE_KEY);
      const hdr = { 'apikey': key, 'Authorization': `Bearer ${key}` };
      const chk = await fetchWithTimeout(`${base}/lessons_learned?id=eq.${match.id}&select=lesson_type,canonical_lock`, { headers: hdr }, 5000);
      const data = await chk.json();
      const row = Array.isArray(data) ? data[0] : data;
      if (row && (PROTECTED_LESSON_TYPES.has(row.lesson_type) || row.canonical_lock)) {
        console.log(`[1287] BLOCKED archive lesson#${match.id}: type=${row.lesson_type} lock=${row.canonical_lock}`);
        return res.status(403).json({ ok: false, error: `[1287] Archive bloquee: lesson#${match.id} est ${row.lesson_type} ou canonical_lock` });
      }
    } catch (e) {
      console.error('[1287] Guard check error:', e.message);
      // Non-blocking: if guard check fails, allow the PATCH (fail open for now)
    }
  }

  // Forward PATCH to Supabase
  const base = String(SUPABASE_URL).replace(/\/+$/, '');
  const key = String(SUPABASE_KEY);
  const hSupa = { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };

  // Build PostgREST query params from match
  const params = Object.entries(match).map(([k, v]) => `${k}=eq.${v}`).join('&');
  const url = `${base}/${table}?${params}`;

  try {
    const resp = await fetchWithTimeout(url, { method: 'PATCH', headers: hSupa, body: JSON.stringify(cleaned) }, 10000);
    const data = await resp.json();

    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: `Supabase PATCH failed: ${JSON.stringify(data)}` });
    }

    const rowsAffected = Array.isArray(data) ? data.length : (data ? 1 : 0);
    console.log(`[T04] PATCH ${table} match=${JSON.stringify(match)} cols=${Object.keys(cleaned).join(',')} rows=${rowsAffected}`);

    return res.json({ ok: true, table, match, rows_affected: rowsAffected, patched_columns: Object.keys(cleaned) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
