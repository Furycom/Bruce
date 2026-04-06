// routes/scope-classifier.js — [1226]+[1367] Auto-classeur projets v3.0 S1440 Opus
// Classifie automatiquement project_scope ET project_id par analyse de keywords.
// v3.0: registre DYNAMIQUE charge depuis table projects (Supabase).
// Cache de 5 minutes pour eviter de requeter a chaque INSERT.

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _cachedRegistry = null;
let _cacheLoadedAt = 0;

/**
 * Load project registry from Supabase projects table.
 * Caches for CACHE_TTL_MS. Falls back to empty array on error.
 */
async function loadRegistry() {
  const now = Date.now();
  if (_cachedRegistry && (now - _cacheLoadedAt) < CACHE_TTL_MS) {
    return _cachedRegistry;
  }

  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(process.env.SUPABASE_KEY || '');

  if (!base || !key) {
    console.error('[1367] scope-classifier: SUPABASE_URL or SUPABASE_KEY missing');
    return _cachedRegistry || [];
  }

  try {
    const url = base + '/projects?select=id,name,keywords&keywords=not.is.null&keywords=neq.[]';
    const resp = await fetch(url, {
      headers: { 'apikey': key, 'Authorization': 'Bearer ' + key }
    });

    if (!resp.ok) {
      console.error('[1367] scope-classifier: failed to load projects:', resp.status);
      return _cachedRegistry || [];
    }

    const projects = await resp.json();
    _cachedRegistry = projects
      .filter(p => p.keywords && Array.isArray(p.keywords) && p.keywords.length > 0)
      .map(p => ({
        scope: p.name,
        project_id: p.id,
        keywords: p.keywords.map(k => String(k).toLowerCase()),
      }));
    _cacheLoadedAt = now;
    console.log(`[1367] scope-classifier: loaded ${_cachedRegistry.length} projects from Supabase`);
    return _cachedRegistry;
  } catch (err) {
    console.error('[1367] scope-classifier: load error:', err.message);
    return _cachedRegistry || [];
  }
}

/**
 * Classify text content against project registry.
 * @param {string[]} textFields - Array of text strings to analyze
 * @returns {Promise<{ scope: string|null, project_id: number|null, score: number, runner_up: object|null }>}
 */
async function classifyScope(textFields) {
  const registry = await loadRegistry();
  const combined = textFields
    .filter(Boolean)
    .map(t => String(t).toLowerCase())
    .join(' ');

  if (!combined || combined.length < 10) return { scope: null, project_id: null, score: 0, runner_up: null };

  const scores = [];
  for (const project of registry) {
    let score = 0;
    for (const kw of project.keywords) {
      if (combined.includes(kw)) score++;
    }
    if (score > 0) scores.push({ scope: project.scope, project_id: project.project_id, score });
  }

  if (scores.length === 0) return { scope: null, project_id: null, score: 0, runner_up: null };

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const runner_up = scores.length > 1 ? scores[1] : null;

  // Minimum 2 keyword matches to reclassify
  if (best.score < 2) {
    return { scope: null, project_id: null, score: best.score, runner_up, below_threshold: true };
  }

  // Ambiguity check: if top 2 are within 1 point, don't reclassify
  if (runner_up && (best.score - runner_up.score) <= 1) {
    return { scope: null, project_id: null, score: best.score, runner_up, ambiguous: true };
  }

  return { scope: best.scope, project_id: best.project_id, score: best.score, runner_up };
}

/**
 * Auto-classify project_scope AND project_id for a data write payload.
 * Only operates if current scope is absent, empty, or 'homelab' (default).
 */
async function autoClassifyScope(table, data) {
  const currentScope = (data.project_scope || '').toLowerCase().trim();
  const isDefault = !currentScope || currentScope === 'homelab';

  if (!isDefault) {
    return { applied: false, original: currentScope, classified: null, project_id: null, detail: { reason: 'explicit_scope' } };
  }

  let textFields = [];
  switch (table) {
    case 'knowledge_base':
      textFields = [data.question, data.answer, data.category, data.subcategory];
      break;
    case 'lessons_learned':
      textFields = [data.lesson_text, data.lesson_type];
      break;
    case 'roadmap':
      textFields = [data.step_name, data.description];
      break;
    case 'session_history':
      textFields = [data.summary, data.tasks_completed, data.notes];
      break;
    default:
      return { applied: false, original: currentScope || 'homelab', classified: null, project_id: null, detail: { reason: 'unsupported_table' } };
  }

  const result = await classifyScope(textFields);

  if (!result.scope) {
    return {
      applied: false,
      original: currentScope || 'homelab',
      classified: null,
      project_id: null,
      detail: { reason: result.ambiguous ? 'ambiguous' : result.below_threshold ? 'below_threshold' : 'no_match', ...result }
    };
  }

  return {
    applied: true,
    original: currentScope || 'homelab',
    classified: result.scope,
    project_id: result.project_id,
    detail: result
  };
}

/** Force reload cache (e.g. after creating a new project) */
function invalidateCache() {
  _cachedRegistry = null;
  _cacheLoadedAt = 0;
}

module.exports = { classifyScope, autoClassifyScope, invalidateCache };
