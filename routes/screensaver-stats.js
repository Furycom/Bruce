/**
 * routes/screensaver-stats.js — S1459 [1510]
 * Endpoint d'agrégation complète pour le tableau screensaver dashboard.
 * Retourne: couverture par table/job, anomalies séquentielles, qualité, fraîcheur, canon.
 */
const express = require('express');
const router = express.Router();

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

function supaHeaders() {
  return { 'Authorization': `Bearer ${SUPA_KEY}`, 'apikey': SUPA_KEY, 'Content-Type': 'application/json' };
}

async function supaGet(table, query = '') {
  const sep = query ? '?' : '';
  const r = await fetch(`${SUPA_URL}/${table}${sep}${query}`, { headers: supaHeaders() });
  if (!r.ok) return [];
  return r.json();
}

async function supaCount(table, filter = '') {
  const q = filter ? `?select=id&${filter}` : '?select=id';
  const r = await fetch(`${SUPA_URL}/${table}${q}`, {
    headers: { ...supaHeaders(), 'Prefer': 'count=exact' }
  });
  const range = r.headers.get('content-range') || '0/0';
  return parseInt(range.split('/')[1]) || 0;
}

// Pipeline order per table
const PIPELINE_LESSONS = ['dedup', 'coherence', 'lesson_review', 'lightrag'];
const PIPELINE_KB = ['kb_audit', 'lightrag', 'canon_nomination', 'vrc_pipeline'];

function analyzeJobs(rows, pipeline) {
  const jobCounts = {};
  pipeline.forEach(j => { jobCounts[j] = 0; });
  const anomalies = [];
  let latestByJob = {};
  let fullyComplete = 0;

  for (const row of rows) {
    const jobs = row.screensaver_jobs_completed || {};
    const jobKeys = new Set(Object.keys(jobs));
    // Remove non-pipeline keys
    jobKeys.delete('cross_table_coherence');

    let hasAll = true;
    for (const j of pipeline) {
      if (jobKeys.has(j)) {
        jobCounts[j]++;
        // Track latest timestamp
        const val = jobs[j];
        const ts = typeof val === 'object' && val?.at ? val.at : (typeof val === 'string' ? val : null);
        if (ts && (!latestByJob[j] || ts > latestByJob[j])) latestByJob[j] = ts;
      } else {
        hasAll = false;
      }
    }
    if (hasAll) fullyComplete++;

    // Sequence check
    for (let i = 0; i < pipeline.length; i++) {
      if (jobKeys.has(pipeline[i])) {
        for (let p = 0; p < i; p++) {
          if (!jobKeys.has(pipeline[p])) {
            anomalies.push({ id: row.id, has: pipeline[i], missing: pipeline[p] });
            break;
          }
        }
      }
    }
  }

  return { jobCounts, anomalies: anomalies.length, anomalyDetails: anomalies.slice(0, 20), latestByJob, fullyComplete };
}

router.get('/bruce/screensaver-stats', async (req, res) => {
  const t0 = Date.now();
  try {
    // Parallel fetches
    const [
      lessonsAll, kbAll,
      lessonsActiveCount, lessonsArchivedCount, kbCount,
      userProfileCount, currentStateCount, sessionHistoryCount,
      mediaLibraryCount, projectsCount, openProblemsCount,
      pretachesCount, bruceChunksCount,
      canonLessons, canonKb,
      vrcPending,
      pendingLessonReview, pendingKbAudit
    ] = await Promise.all([
      supaGet('lessons_learned', 'select=id,screensaver_jobs_completed,confidence_score,validated,authority_tier,canonical_lock,archived,created_at&limit=5000'),
      supaGet('knowledge_base', 'select=id,screensaver_jobs_completed,authority_tier,canonical_lock,created_at&limit=5000'),
      supaCount('lessons_learned', 'archived=eq.false'),
      supaCount('lessons_learned', 'archived=eq.true'),
      supaCount('knowledge_base', ''),
      supaCount('user_profile', ''),
      supaCount('current_state', ''),
      supaCount('session_history', ''),
      supaCount('media_library', ''),
      supaCount('projects', ''),
      supaCount('open_problems', ''),
      supaCount('pretaches', ''),
      supaCount('bruce_chunks', ''),
      supaGet('lessons_learned', 'select=id,lesson_text&canonical_lock=eq.true&limit=50'),
      supaGet('knowledge_base', 'select=id,question&canonical_lock=eq.true&limit=50'),
      supaCount('clarifications_pending', 'status=neq.resolved'),
      // S1461: pending counts for rhythm
      supaCount('lessons_learned', 'archived=eq.false&screensaver_jobs_completed->lesson_review=is.null'),
      supaCount('knowledge_base', 'archived=eq.false&screensaver_jobs_completed->kb_audit=is.null'),
    ]);

    // Analyze pipelines
    const lessonsAnalysis = analyzeJobs(lessonsAll, PIPELINE_LESSONS);
    const kbAnalysis = analyzeJobs(kbAll, PIPELINE_KB);

    // Confidence score distribution
    const scores = lessonsAll.filter(r => r.confidence_score != null).map(r => r.confidence_score);
    const scoreBuckets = { '0.9-1.0': 0, '0.8-0.9': 0, '0.7-0.8': 0, '0.6-0.7': 0, '0.5-0.6': 0, '<0.5': 0 };
    let scoreSum = 0;
    for (const s of scores) {
      scoreSum += s;
      if (s >= 0.9) scoreBuckets['0.9-1.0']++;
      else if (s >= 0.8) scoreBuckets['0.8-0.9']++;
      else if (s >= 0.7) scoreBuckets['0.7-0.8']++;
      else if (s >= 0.6) scoreBuckets['0.6-0.7']++;
      else if (s >= 0.5) scoreBuckets['0.5-0.6']++;
      else scoreBuckets['<0.5']++;
    }

    // Validated distribution
    const validatedTrue = lessonsAll.filter(r => r.validated === true).length;
    const validatedFalse = lessonsAll.filter(r => r.validated === false).length;

    // Authority tier distribution
    const lessonTiers = {};
    lessonsAll.forEach(r => { const t = r.authority_tier || 'unknown'; lessonTiers[t] = (lessonTiers[t] || 0) + 1; });
    const kbTiers = {};
    kbAll.forEach(r => { const t = r.authority_tier || 'unknown'; kbTiers[t] = (kbTiers[t] || 0) + 1; });

    // Tables coverage map
    const tables = [
      { name: 'lessons_learned', count: lessonsAll.length, active: lessonsActiveCount, archived: lessonsArchivedCount, covered: true, pipeline: PIPELINE_LESSONS, jobs: lessonsAnalysis.jobCounts },
      { name: 'knowledge_base', count: kbCount, covered: true, pipeline: PIPELINE_KB, jobs: kbAnalysis.jobCounts },
      { name: 'user_profile', count: userProfileCount, covered: false, reason: 'oubli', desc: 'Souhaits, profil et buts de Yann' },
      { name: 'current_state', count: currentStateCount, covered: false, reason: 'semi', desc: 'Configurations, passe-bête, inventaires' },
      { name: 'session_history', count: sessionHistoryCount, covered: false, reason: 'semi', desc: 'Historique sessions (lu mais non traqué)' },
      { name: 'open_problems', count: openProblemsCount, covered: false, reason: 'oubli', desc: 'Problèmes ouverts détectés' },
      { name: 'media_library', count: mediaLibraryCount, covered: false, reason: 'voulu', desc: 'Catalogue média (films, séries, musique)' },
      { name: 'projects', count: projectsCount, covered: false, reason: 'voulu', desc: 'Métadonnées projets' },
      { name: 'pretaches', count: pretachesCount, covered: false, reason: 'voulu', desc: 'Pré-tâches dashboard' },
      { name: 'bruce_chunks', count: bruceChunksCount, covered: false, reason: 'voulu', desc: 'Embeddings RAG' },
    ];

    const totalDataRows = lessonsAll.length + kbCount + userProfileCount + currentStateCount + sessionHistoryCount + openProblemsCount;
    const coveredRows = lessonsAll.length + kbCount;

    res.json({
      ok: true,
      elapsed_ms: Date.now() - t0,
      // Global
      totalTables: tables.length,
      coveredTables: tables.filter(t => t.covered).length,
      totalDataRows,
      coveredRows,
      coveragePct: totalDataRows > 0 ? Math.round(coveredRows / totalDataRows * 100) : 0,
      // S1461: Rhythm metrics for dashboard
      rhythm: {
        pendingLessonReview,
        pendingKbAudit,
        totalProcessedLessons: lessonsAnalysis.fullyComplete,
        totalProcessedKb: kbAnalysis.fullyComplete,
        recentArchived: lessonsAll.filter(r => r.archived).length,
      },
      // Per-table
      tables,
      // Lessons pipeline
      lessons: {
        total: lessonsAll.length,
        active: lessonsActiveCount,
        archived: lessonsArchivedCount,
        pipeline: PIPELINE_LESSONS,
        ...lessonsAnalysis,
      },
      // KB pipeline
      kb: {
        total: kbCount,
        pipeline: PIPELINE_KB,
        ...kbAnalysis,
      },
      // Quality
      quality: {
        confidence: {
          count: scores.length,
          avg: scores.length > 0 ? Math.round(scoreSum / scores.length * 1000) / 1000 : null,
          min: scores.length > 0 ? Math.min(...scores) : null,
          max: scores.length > 0 ? Math.max(...scores) : null,
          buckets: scoreBuckets,
        },
        validated: { true: validatedTrue, false: validatedFalse },
        tiers: { lessons: lessonTiers, kb: kbTiers },
      },
      // Canon
      canon: {
        lockedLessons: canonLessons.length,
        lockedKb: canonKb.length,
        lockedLessonIds: canonLessons.map(r => r.id),
        lockedKbIds: canonKb.map(r => ({ id: r.id, q: (r.question || '').slice(0, 80) })),
      },
      // VRC
      vrc: {
        pending: vrcPending,
      },
    });
  } catch (err) {
    console.error('[screensaver-stats] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
