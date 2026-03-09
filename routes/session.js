// routes/session.js — [774] C8 REFONTE
// Routes: /bruce/session/init, /bruce/session/close/checklist, /bruce/session/close
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const {
  SUPABASE_URL, SUPABASE_KEY, BRUCE_AUTH_TOKEN, BRUCE_LITELLM_KEY
} = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');
const { bruceRagContext } = require('./rag');
const { detectLLMIdentity, loadLLMProfile, buildContextForProfile } = require('../shared/llm-profiles');
const { buildContextForClaude } = require('../shared/context-engine');

// Dependency injection for safePythonSpawn (defined in server.js)
let _safePythonSpawn = null;
function setSafePythonSpawn(fn) { _safePythonSpawn = fn; }

// --- POST /bruce/session/init ---
router.post('/bruce/session/init', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const topic = (req.body && req.body.topic) ? String(req.body.topic).slice(0, 200) : '';
  // [90] Contexte d'intention - ce que la session va accomplir concretement
  const intention = (req.body && req.body.intention) ? String(req.body.intention).slice(0, 400) : '';
  // [602] project_scope filtering — default: homelab + general
  const projectScope = (req.body && req.body.scope) ? String(req.body.scope).split(',').map(s => s.trim().toLowerCase()) : ['homelab', 'general'];

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  try {
    // ── 1. [820] RPC bootstrap_payload + fetch residuels en PARALLELE ────────
    const rpcProfile = (req.body && req.body.profile && ['standard','light','minimal'].includes(req.body.profile)) ? req.body.profile : 'standard'; // [772] C6 profil adaptatif
    const hSupaJson = { ...hSupa, 'Content-Type': 'application/json' };

    const [rpcRes, bruceToolsRes, clarifRes] = await Promise.all([
      // [820] 1 RPC remplace 5 fetch (current_state, lessons, roadmap, dashboard, last_session)
      fetchWithTimeout(base + '/rpc/bootstrap_payload', {
        method: 'POST',
        headers: hSupaJson,
        body: JSON.stringify({ p_model: null, p_profile: rpcProfile })
      }, 10000),
      // Kept: bruce_tools (not in RPC)
      fetchWithTimeout(base + '/bruce_tools?status=in.(active,available)&order=subcategory.asc,name.asc&select=id,name,description,subcategory,status,underutilized,trigger_text', { headers: hSupa }, 8000),
      // Kept: clarifications_pending (not in RPC)
      fetchWithTimeout(base + '/clarifications_pending?status=eq.pending&order=id.asc&select=id,question_text,created_at', { headers: hSupa }, 5000),
    ]);

    const rpcPayload = await rpcRes.json();
    const bruceToolsArr = await bruceToolsRes.json();
    const clarifArr = await clarifRes.json().catch(() => []);

    // [820] Extract from RPC result
    const currentState = rpcPayload.current_state || [];
    const criticalLessons = rpcPayload.critical_lessons || [];
    const roadmap = rpcPayload.next_tasks || [];
    const dashboard = rpcPayload.dashboard || {};
    const lastSession = rpcPayload.last_session || null;
    // [828] homelab_services removed — already in claude.md + SERVICES_CONFIG
    const bruceTools = Array.isArray(bruceToolsArr) ? bruceToolsArr : [];
    const clarificationsPending = Array.isArray(clarifArr) ? clarifArr : [];

    // [816] Create new session in session_history and capture session_id
    let newSessionId = null;
    try {
      const sessionPayload = {
        session_start: new Date().toISOString(),
        author_system: 'claude',
        notes: topic ? ('session/init: ' + topic) : 'session/init',
        project_scope: projectScope.join(',')
      };
      const createRes = await fetchWithTimeout(base + '/session_history', {
        method: 'POST',
        headers: { ...hSupa, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify(sessionPayload)
      }, 5000);
      const createData = await createRes.json();
      if (Array.isArray(createData) && createData[0] && createData[0].id) {
        newSessionId = createData[0].id;
      } else if (createData && createData.id) {
        newSessionId = createData.id;
      }
    } catch (sessErr) {
      // Non-blocking: session creation failure doesn't break init
    }

    // -- 2. RAG semantique multi-query [90+91] --
    // [91] Pour sujets larges: plusieurs requetes RAG avec sous-questions
    let ragResults = [];
    const ragQuery = topic || (roadmap.length > 0 ? roadmap[0].step_name : 'etat session homelab BRUCE');

    // [91] Construire les queries RAG (principale + derivees si intention fournie)
    const ragQueries = [ragQuery];
    if (intention && intention.length > 10) {
      ragQueries.push(intention);  // [90] sous-query sur l'intention
    }
    if (roadmap.length > 0 && roadmap[0].step_name !== ragQuery) {
      ragQueries.push(roadmap[0].step_name);  // sous-query sur la 1ere tache
    }

    const embedAndSearch = async (queryText) => {
      try {
        const embedRes = await fetchWithTimeout(
          'http://192.168.2.85:8081/embed',
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputs: queryText, max_length: 256 }) },
          6000
        );
        const embedData = await embedRes.json();
        const ej2 = embedData; const embedding = Array.isArray(ej2) ? ej2[0] : (ej2 && ej2.embeddings && ej2.embeddings[0]);
        if (!embedding) return [];
        const qvec = '[' + embedding.map(x => Number(x)).join(',') + ']';
        const ragRes = await fetchWithTimeout(
          base + '/rpc/bruce_rag_hybrid_search_text',
          { method: 'POST', headers: { ...hSupa, 'Content-Type': 'application/json' },
            body: JSON.stringify({ qtext: queryText, qvec: qvec, k: 6 }) },
          8000
        );
        const ragData = await ragRes.json();
        return Array.isArray(ragData) ? ragData : [];
      } catch { return []; }
    };

    try {
      // [91] Lancer toutes les queries en parallele
      const allRagResults = await Promise.all(ragQueries.map(q => embedAndSearch(q)));
      // Fusionner et dedupliquer par preview (prendre le meilleur score)
      const seenPreviews = new Map();
      for (const results of allRagResults) {
        for (const r of results) {
          const key = (r.preview || '').slice(0, 60);
          const score = r.hybrid_score || r.cos_sim || 0;
          if (!seenPreviews.has(key) || seenPreviews.get(key).score < score) {
            seenPreviews.set(key, { ...r, score });
          }
        }
      }
      // Trier par score, prendre les 6 meilleurs
      ragResults = Array.from(seenPreviews.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 6)
        .map(r => ({
          score: Math.round(r.score * 100) / 100,
          preview: (r.preview || '').slice(0, 200)
        }));
    } catch (ragErr) {
      // RAG optionnel - ne bloque pas
    }

    // [719] CONTEXT ROUTER v2: FTS + semantique hybride en parallele
    // Amelioration de [134]: lance FTS Postgres ET bruceRagContext en parallele.
    // Fusionne les resultats par score composite. Canonical_lock toujours prioritaire.
    let routedLessons = Array.isArray(criticalLessons) ? [...criticalLessons] : [];
    if (topic) {
      try {
        const topicWords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 4).join(' | ');

        // Lancer FTS et semantique EN PARALLELE
        const [ftsResult, semResult] = await Promise.allSettled([
          // [A] FTS Postgres: keywords du topic -> lessons validees
          topicWords ? fetchWithTimeout(
            base + '/lessons_learned?validated=eq.true&lesson_text=fts.' + encodeURIComponent(topicWords) + '&order=importance.desc,id.desc&limit=8',
            { headers: hSupa }, 5000
          ).then(r => r.json()).catch(() => []) : Promise.resolve([]),

          // [B] Semantique: bruceRagContext sur le topic -> anchors lessons_learned
          bruceRagContext(topic, 12).then(ragCtx => {
            const lessonIds = [];
            for (const r of (ragCtx.results || [])) {
              const anchor = r.anchor || r;
              if (anchor.source === 'lessons_learned' && anchor.source_id) {
                lessonIds.push({ id: parseInt(anchor.source_id, 10), score: r.hybrid_score || r.cos_sim || 0.5 });
              }
            }
            return lessonIds;
          }).catch(() => [])
        ]);

        const ftsLessons = (ftsResult.status === 'fulfilled' && Array.isArray(ftsResult.value)) ? ftsResult.value : [];
        const semIds = (semResult.status === 'fulfilled' && Array.isArray(semResult.value)) ? semResult.value : [];

        // Recuperer les lessons semantiques par IDs
        let semLessons = [];
        const validSemIds = semIds.filter(s => Number.isFinite(s.id) && s.id > 0);
        if (validSemIds.length > 0) {
          try {
            const idsStr = validSemIds.map(s => s.id).join(',');
            const semRes = await fetchWithTimeout(
              base + '/lessons_learned?id=in.(' + idsStr + ')&select=*',
              { headers: hSupa }, 4000
            );
            const semRaw = await semRes.json();
            if (Array.isArray(semRaw)) {
              const scoreMap = {};
              validSemIds.forEach(s => { scoreMap[s.id] = s.score; });
              semLessons = semRaw.map(l => ({ ...l, _sem_score: scoreMap[l.id] || 0.5 }));
            }
          } catch (_) {}
        }

        // Fusionner FTS + semantique avec score composite
        const importanceWeight = { critical: 1.0, high: 0.8, normal: 0.6 };
        const allCandidates = new Map();

        for (const l of ftsLessons) {
          const ftsScore = importanceWeight[l.importance] || 0.6;
          allCandidates.set(l.id, { lesson: l, score: ftsScore, sources: 1 });
        }
        for (const l of semLessons) {
          const semScore = l._sem_score || 0.5;
          if (allCandidates.has(l.id)) {
            const existing = allCandidates.get(l.id);
            existing.score = Math.min(1.0, existing.score + semScore * 0.5 + 0.2);
            existing.sources = 2;
          } else {
            allCandidates.set(l.id, { lesson: l, score: semScore, sources: 1 });
          }
        }

        // Trier par score composite desc
        const fusedSorted = Array.from(allCandidates.values())
          .sort((a, b) => b.score - a.score)
          .map(c => c.lesson);

        if (fusedSorted.length > 0) {
          const canonicalLock = routedLessons.filter(l => l.canonical_lock);
          const recentCritical = routedLessons.filter(l => !l.canonical_lock);
          const seen = new Set(canonicalLock.map(l => l.id));
          const fusedFiltered = fusedSorted.filter(l => !seen.has(l.id));
          fusedFiltered.forEach(l => seen.add(l.id));
          const recentFiltered = recentCritical.filter(l => !seen.has(l.id));
          const lessonLimit = (rpcProfile === 'light') ? 3 : (rpcProfile === 'minimal') ? 1 : 10; // [772] C6
          routedLessons = [...canonicalLock, ...fusedFiltered, ...recentFiltered].slice(0, lessonLimit);
        }
      } catch (routerErr) {
        // Context router v2 optionnel - fallback sur criticalLessons originales
        routedLessons = Array.isArray(criticalLessons) ? criticalLessons : [];
      }
    }
    // Utiliser routedLessons à la place de criticalLessons pour la suite
    const effectiveLessonsRaw = routedLessons.length > 0 ? routedLessons : (Array.isArray(criticalLessons) ? criticalLessons : []);
    // [602] Filtrer par project_scope
    const effectiveLessons = effectiveLessonsRaw.filter(l => {
      const ls = (l.project_scope || 'homelab').toLowerCase();
      return projectScope.includes(ls);
    });

    // ── 3. Résumé vLLM local (dégradé gracieux si down) ─────────────────────
    // [877] INJECTION FORCÃE: profil Yann + donnÃ©es critiques (indÃ©pendant du topic)
    let userProfileContext = '';
    try {
      const profileRes = await fetchWithTimeout(
        base + '/knowledge_base?category=eq.user_profile&subcategory=eq.profil_yann&select=answer&limit=1',
        { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
        5000
      );
      const profiles = await profileRes.json();
      if (Array.isArray(profiles) && profiles.length > 0) {
        userProfileContext = '\n\n**PROFIL UTILISATEUR YANN (injection [877]):**\n'
          + profiles.map(p => p.answer.slice(0, 600)).join('\n');
      }
    } catch (e) { /* non-bloquant */ }

    let llmSummary = null;
    let llmOk = false;

    const nextTask = roadmap.length > 0
      ? `[${roadmap[0].id}] ${roadmap[0].step_name} (priorité ${roadmap[0].priority})`
      : 'aucune tâche en cours';

    const lastSessionSummary = lastSession
      ? `Dernière session: ${lastSession.tasks_completed || ''} | Notes: ${(lastSession.notes || '').slice(0, 300)}`
      : 'Pas de session précédente trouvée.';

    const ragContext = ragResults.length > 0
      ? ragResults.map((r, i) => `[${i+1}] (score ${r.score}) ${r.preview}`).join('\n')
      : 'Aucun resultat RAG pour ce topic.';

    // Extraire les règles Yann et leçons critiques pour le prompt
    const reglesYann = Array.isArray(currentState)
      ? currentState
          .filter(s => s.key && s.key.startsWith('REGLE_YANN_'))
          .map(s => `- ${s.value}`)
          .join('\n')
      : '';
    const topLessons = Array.isArray(criticalLessons)
      ? criticalLessons.slice(0, 5).map((l, i) => `[L${i+1}] ${(l.lesson_text||'').slice(0,150)}`).join('\n')
      : '';

    const prompt = `Tu es BRUCE, assistant IA du homelab de Yann. Genere un briefing de demarrage de session concis en francais.

ETAT SYSTEME:
- lessons=${dashboard.lessons_total}, kb=${dashboard.kb_total}, roadmap_done=${dashboard.roadmap_done}, staging_pending=${dashboard.staging_pending}
- Prochaine tache: ${nextTask}
- ${lastSessionSummary}

${intention ? "INTENTION DE SESSION: " + intention + "\n\n" : ""}CONTEXT RAG (topic="${ragQuery}"):
${ragContext}

LECONS CRITIQUES A RAPPELER:
${topLessons}

REGLES CANON DE YANN (toujours respecter):
${reglesYann}

INSTRUCTIONS: En 6-8 phrases max:
1. Etat chiffre du projet.
2. Prochaine action prioritaire avec ID roadmap.
3. Points d attention immediats (staging, erreurs).
4. Rappel 2-3 regles canon les plus pertinentes pour cette session.
Sois direct, precis, actionnable.`;


    try {
      // [730] Route via LiteLLM proxy (was direct vLLM .32:8000)
      const llmRes = await fetchWithTimeout(
        'http://192.168.2.230:4100/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + (BRUCE_LITELLM_KEY || 'bruce-litellm-key-01'), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen2.5-7b',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 500,
            temperature: 0.2,
            metadata: { trace_name: 'bruce-bootstrap', generation_name: 'bootstrap-summary' }
          })
        },
        15000
      );
      const llmData = await llmRes.json();
      llmSummary = llmData?.choices?.[0]?.message?.content || null;
      llmOk = !!llmSummary;
    } catch (llmErr) {
      llmSummary = null; // dégradé gracieux
    }

    // ── 4. Réponse finale ────────────────────────────────────────────────────
    // ── Détection profil LLM + Construction contexte adapté ──────────────
    const llmIdentity = detectLLMIdentity(req);
    const llmProfile = await loadLLMProfile(llmIdentity);

    // Construire context_prompt via le système de profils 3 couches
    // [90] Ajouter l'intention declaree au context_prompt
    const intentionBlock = intention
      ? '**Intention de session:** ' + intention + '\n\n'
      : '';
    // [602] Scope indicator (only shown when non-default)
    const scopeBlock = projectScope.join(',') !== 'homelab,general'
      ? '**\uD83D\uDD12 Scope projet:** ' + projectScope.join(', ') + '\n\n'
      : '';
    // [742] REFLEXE OUTILS BRUCE — instruction active (remplace listing passif [601])
    let toolsBlock = (llmIdentity === 'claude') ? '' : '\n\n**🧰 REFLEXE OUTILS BRUCE (' + bruceTools.length + ' outils) — AVANT toute action technique:**\n'
      + 'Executer `semantic_search_advanced("bruce_tools [description action]", top_k=3)`.\n'
      + 'Si outil pertinent (score > 0.6), l\'UTILISER au lieu de SSH/docker/curl direct.\n'
      + 'Outils frequemment sous-utilises : Pulse (audit infra), Portainer (containers), BookStack (docs).';

    // [690] PROTOCOLE OBLIGATOIRE — en tête absolu du context_prompt Claude
    // [830] Skip PROTOCOLE_690 for Claude — already in claude.md
    const PROTOCOLE_690 = (llmProfile.context_format === 'markdown_structured' && llmIdentity !== 'claude')
      ? '╔══════════════════════════════════════════════════════════════════╗\n' +
        '║         PROTOCOLE OBLIGATOIRE — AVANT TOUTE ACTION              ║\n' +
        '╚══════════════════════════════════════════════════════════════════╝\n' +
        '🔴 #1 SSH    : JAMAIS invoke_expression → Start-Job + Wait-Job -Timeout 25\n' +
        '🔴 #2 QUOTE  : JAMAIS guillemets imbriqués SSH → script .sh + SCP + exec\n' +
        '🔴 #3 SED/GO : JAMAIS sed newlines / Go templates / heredoc via SSH → script .sh\n' +
        '🔴 #4 DOCKER : JAMAIS restart si nouveau volume → docker compose up -d\n' +
        '🔴 #5 DIAG   : JAMAIS déclarer bloqué sans list_sessions → changer approche\n' +
        '🔴 #6 WRITE  : roadmap=POST /rest/v1/roadmap direct. lessons/KB=staging_queue\n' +
        '               staging_queue champs EXACTS: table_cible + contenu_json + author_system\n' +
        '⚡  AVANT SSH/docker/transfert/ecriture REST: POST /bruce/preflight {action_type}\n\n'
      : '';
    // [878] CONTEXT ENGINE: Use intelligent context for Claude, legacy for others
    let contextPrompt;
    let contextMeta = null;
    if (llmIdentity === 'claude') {
      const ceResult = await buildContextForClaude({
        dashboard,
        tasks: roadmap,
        lessons: effectiveLessons,
        ragResults,
        currentState,
        topic: ragQuery
      });
      contextPrompt = (llmSummary ? '**Briefing:** ' + llmSummary + '\n\n' : '')
        + intentionBlock + scopeBlock + ceResult.context_prompt;
      contextMeta = ceResult.context_meta;
    } else {
      contextPrompt = PROTOCOLE_690
        + (llmSummary ? '**Briefing:** ' + llmSummary + '\n\n' : '')
        + intentionBlock
        + scopeBlock
        + buildContextForProfile(llmProfile, dashboard, roadmap, effectiveLessons, ragResults, currentState)
        + toolsBlock
        + userProfileContext;
    }

    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      session_id: newSessionId,
      topic: ragQuery,
      project_scope: projectScope,
      llm_identity: llmIdentity,
      profile_used: llmProfile.profile_name || llmIdentity,
      context_prompt: contextPrompt,
      context_meta: contextMeta,
      briefing: llmSummary,
      llm_ok: llmOk,
      dashboard,
      // [829] Compact next_tasks: strip descriptions to save ~4000 tokens
      next_tasks: roadmap.slice(0, 100).map(t => ({ id: t.id, status: t.status, priority: t.priority, step_name: t.step_name, model_hint: t.model_hint })),
      critical_lessons: effectiveLessons,
      last_session: lastSession,
      rag_context: ragResults,
      current_state: currentState,
      // [828] homelab_services removed — see claude.md + SERVICES_CONFIG
      clarifications_pending: clarificationsPending,
      // [779] Rappel obligatoire pour sessions Code
      code_checklist: (req.body && req.body.model === 'code') ? {
        warning: '[779] SESSION CODE: checklist obligatoire',
        session_close: 'POST /bruce/session/close avec session_id + summary + handoff_next + tasks_done[]',
        staging_lesson_schema: {
          table_cible: 'lessons_learned',
          contenu_json: {
            lesson_type: 'solution|warning|discovery|best_practice|pattern|debug_trace|architecture_decision',
            lesson_text: 'min 80 chars',
            importance: 'critical|high|normal|low',
            confidence_score: '0-1',
            author_system: 'claude',
            project_scope: 'homelab'
          },
          note: 'lesson_type OBLIGATOIRE (Gate-1 rejette si absent). Fallback auto: solution'
        }
      } : undefined,
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: GET /bruce/session/close/checklist  [676]
// Rôle: Retourne la checklist interactive de clôture de session.
//       Guide Claude en montrant l'état de la session, ce qui a été fait,
//       et les 7 catégories à remplir AVANT de clôturer.
// Query params:
//   session_id: number (required) — ID de la session en cours
// Output: { ok, session_id, session_summary, checklist, warnings }
// ─────────────────────────────────────────────────────────────────────────────
// --- GET /bruce/session/close/checklist ---
router.get('/bruce/session/close/checklist', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const sessionId = parseInt(req.query.session_id);
  if (!sessionId || isNaN(sessionId)) {
    return res.status(400).json({ ok: false, error: 'session_id (number) query param is required' });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' };

  try {
    // ── 1. Récupérer la session_history courante ──
    let sessionInfo = null;
    try {
      const r = await fetchWithTimeout(
        base + '/session_history?id=eq.' + sessionId + '&select=*',
        { headers: hSupa }, 8000
      );
      const data = await r.json();
      sessionInfo = Array.isArray(data) && data[0] ? data[0] : null;
    } catch (e) {
      // pas bloquant
    }

    // ── 2. Récupérer les lessons créées pendant cette session ──
    let sessionLessons = [];
    try {
      const r = await fetchWithTimeout(
        base + '/lessons_learned?session_id=eq.' + sessionId + '&select=id,lesson_type,lesson_text,importance&order=id.asc',
        { headers: hSupa }, 8000
      );
      sessionLessons = await r.json();
    } catch (e) {}

    // ── 3. Récupérer les tâches roadmap modifiées (doing/done récentes) ──
    let recentTasks = [];
    try {
      const r = await fetchWithTimeout(
        base + '/roadmap?status=in.(doing,done)&order=id.desc&limit=15&select=id,step_name,status,priority',
        { headers: hSupa }, 8000
      );
      recentTasks = await r.json();
    } catch (e) {}

    // ── 4. Récupérer le staging pending (devrait être 0 avant clôture) ──
    let stagingPending = 0;
    try {
      const r = await fetchWithTimeout(
        base + '/staging_queue?status=eq.pending&select=id',
        { headers: hSupa }, 5000
      );
      const data = await r.json();
      stagingPending = Array.isArray(data) ? data.length : 0;
    } catch (e) {}

    // ── 5. Récupérer CURRENT_STATE handoff_vivant ──
    let currentHandoff = '';
    try {
      const r = await fetchWithTimeout(
        base + '/current_state?key=eq.handoff_vivant&select=value',
        { headers: hSupa }, 5000
      );
      const data = await r.json();
      currentHandoff = Array.isArray(data) && data[0] ? data[0].value : '';
    } catch (e) {}

    // ── 6. Construire la checklist avec avertissements ──
    const warnings = [];

    // [876] VÃ©rification handoff_vivant MAJ depuis dÃ©but session
    try {
      const hvRes = await fetchWithTimeout(
        base + '/current_state?key=eq.handoff_vivant&select=updated_at',
        { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
        5000
      );
      const hvData = await hvRes.json();
      if (Array.isArray(hvData) && hvData.length > 0) {
        const hvUpdated = new Date(hvData[0].updated_at);
        const sessionStart = new Date(); // approximation: si pas MAJ rÃ©cemment c'est suspect
        const ageMinutes = (Date.now() - hvUpdated.getTime()) / 60000;
        if (ageMinutes > 120) {
          warnings.push('[876] WARNING: handoff_vivant non mis Ã  jour depuis ' + Math.round(ageMinutes) + ' min. La sauvegarde de session est-elle complÃ¨te?');
        }
      }
    } catch (e) { warnings.push('[876] Could not verify handoff_vivant: ' + e.message); }

    // [876] VÃ©rification git status sur .230
    try {
      const { execFile } = require('child_process');
      const gitOut = await new Promise((resolve) => {
        execFile('git', ['status', '--porcelain'], { cwd: '/home/furycom/mcp-stack', timeout: 5000 }, (err, stdout) => {
          resolve(stdout || '');
        });
      });
      if (gitOut.trim().length > 0) {
        const uncommitted = gitOut.trim().split('\n').length;
        warnings.push('[876] WARNING: ' + uncommitted + ' fichier(s) non commite(s) dans mcp-stack. Git commit recommande avant fermeture.');
      }
    } catch (e) { /* git check optionnel */ }

    if (stagingPending > 0) {
      warnings.push(`⚠️ ${stagingPending} items en staging pending — valider AVANT de clôturer.`);
    }
    if (sessionInfo && sessionInfo.session_end) {
      warnings.push('⚠️ Cette session a déjà un session_end — clôture possiblement déjà faite.');
    }
    if (!sessionInfo) {
      warnings.push('⚠️ Aucune entrée session_history trouvée pour session_id=' + sessionId + '. Elle sera créée à la clôture si summary fourni.');
    }

    const checklist = {
      categories: [
        {
          key: 'decisions',
          label: 'Décisions explicites de Yann',
          description: 'Règles, préférences, arbitrages exprimés par Yann pendant la session',
          type: 'string[]',
          required: false,
          warning_if_empty: 'Vérifier si Yann a donné des directives ou fait des choix.'
        },
        {
          key: 'rules_learned',
          label: 'Corrections de comportement',
          description: 'Ne-fais-plus-ça, fais-toujours-ça, corrections demandées par Yann',
          type: 'string[]',
          required: false,
          warning_if_empty: 'Vérifier si Yann a corrigé un comportement de Claude.'
        },
        {
          key: 'tech_discoveries',
          label: 'Découvertes techniques',
          description: 'Bugs trouvés, fixes appliqués, configurations découvertes',
          type: 'string[]',
          required: false,
          warning_if_empty: null
        },
        {
          key: 'patterns',
          label: 'Patterns et anti-patterns',
          description: 'Nouvelles bonnes pratiques ou erreurs à éviter identifiées',
          type: 'string[]',
          required: false,
          warning_if_empty: null
        },
        {
          key: 'tasks_status',
          label: 'État des tâches modifié',
          description: 'Tâches commencées, terminées, bloquées ou redéfinies. Format: [{id, status, notes}]',
          type: 'object[]',
          required: true,
          warning_if_empty: 'OBLIGATOIRE — Chaque session modifie au moins une tâche.'
        },
        {
          key: 'infrastructure_changes',
          label: 'Changements infrastructure',
          description: 'Nouvelles IPs, ports, configs, services déployés ou modifiés',
          type: 'string[]',
          required: false,
          warning_if_empty: null
        },
        {
          key: 'handoff_next',
          label: 'Message pour la prochaine session',
          description: 'Résumé de ce qui reste à faire, état, recommandation Sonnet/Opus',
          type: 'string',
          required: true,
          warning_if_empty: 'OBLIGATOIRE — La prochaine session en dépend.'
        }
      ],
      also_required: [
        { key: 'session_id', type: 'number', description: 'ID de la session en cours' },
        { key: 'summary', type: 'string', description: 'Résumé global de ce qui a été fait. OBLIGATOIRE.' }
      ]
    };

    // [711] COUCHE 3 — fire-and-forget session_error_detector.py
    try {
      const det = safePythonSpawn('/home/furycom/session_error_detector.py',
        ['--session-id', String(sessionId)], { detached: true, stdio: 'ignore' });
      if (det) det.unref();

    // [712] COUCHE 4 — fire-and-forget escalation_engine.py (30s après detector)
    setTimeout(() => {
      const esc = safePythonSpawn('/home/furycom/escalation_engine.py',
        ['--session-id', String(sessionId)], { detached: true, stdio: 'ignore' });
      if (esc) esc.unref();
    }, 30000);
    } catch (_e711) {
      warnings.push('session_error_detector spawn: ' + _e711.message);
    }

    return res.json({
      ok: true,
      session_id: sessionId,
      session_info: sessionInfo ? {
        started: sessionInfo.session_start,
        ended: sessionInfo.session_end,
        tasks_completed: sessionInfo.tasks_completed,
        notes: sessionInfo.notes
      } : null,
      lessons_this_session: sessionLessons.length,
      lessons_preview: (sessionLessons || []).slice(0, 5).map(l => ({
        id: l.id,
        type: l.lesson_type,
        preview: (l.lesson_text || '').slice(0, 100)
      })),
      staging_pending: stagingPending,
      current_handoff: currentHandoff ? currentHandoff.slice(0, 300) : null,
      recent_tasks: (recentTasks || []).slice(0, 10),
      checklist: checklist,
      warnings: warnings,
      instructions: 'Remplir les 7 catégories ci-dessus puis POST /bruce/session/close avec le JSON complet. Les catégories vides génèrent des warnings mais seuls summary, tasks_status et handoff_next sont obligatoires.'
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


// ENDPOINT: POST /bruce/session/close  [423 Phase B]
// Rôle: Clôture structurée de session — force la revue des 7 catégories
//       d'extraction et pousse automatiquement vers staging_queue + validate.
// Input JSON:
//   session_id: number (required)
//   summary: string (résumé global de session)
//   decisions: string[] (décisions explicites de Yann)
//   rules_learned: string[] (corrections, "ne fais plus ça", préférences)
//   tech_discoveries: string[] (bugs, fixes, configurations)
//   patterns: string[] (patterns ou anti-patterns identifiés)
//   tasks_status: [{id:number, status:string, notes?:string}]
//   tasks_done: [number] (shortcut: array of task IDs to mark done [684])
//   infrastructure_changes: string[] (IPs, ports, configs)
//   handoff_next: string (message pour la prochaine session)
// ─────────────────────────────────────────────────────────────────────────────
// --- POST /bruce/session/close ---
router.post('/bruce/session/close', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const body = req.body || {};
  const sessionId = body.session_id;
  if (!sessionId || typeof sessionId !== 'number') {
    return res.status(400).json({ ok: false, error: 'session_id (number) is required' });
  }

  // [676] Validation champs obligatoires
  const summary = (body.summary || '').trim();
  const handoffNext = (body.handoff_next || '').trim();
  if (!summary) {
    return res.status(400).json({ ok: false, error: 'summary (string) is required — describe what was done this session.' });
  }
  if (!handoffNext) {
    return res.status(400).json({ ok: false, error: 'handoff_next (string) is required — the next session depends on this.' });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };

  // ── Helper: hash simple pour content_hash ──
  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(16).padStart(8, '0').slice(0, 16);
  }

  // ── Helper: push un item vers staging_queue ──
  async function pushToStaging(tableCible, contenuJson, intent) {
    const payload = {
      table_cible: tableCible,
      contenu_json: contenuJson,
      author_system: 'session-close-endpoint',
      author_session: String(sessionId),
      content_hash: simpleHash(JSON.stringify(contenuJson)),
      status: 'pending'
    };
    const r = await fetchWithTimeout(base + '/staging_queue', {
      method: 'POST',
      headers: hSupa,
      body: JSON.stringify(payload)
    }, 8000);
    const data = await r.json();
    return { ok: r.ok, table: tableCible, intent: intent, id: Array.isArray(data) && data[0] ? data[0].id : null };
  }

  try {
    const results = [];
    const warnings = [];

    // ── 1. DÉCISIONS YANN → lessons_learned (rule_canon) ──
    const decisions = Array.isArray(body.decisions) ? body.decisions.filter(d => d && d.trim()) : [];
    if (decisions.length === 0) {
      warnings.push('Aucune decision Yann extraite - verifier si la session en contenait.');
    }
    for (const decision of decisions) {
      const r = await pushToStaging('lessons_learned', {
        lesson_type: 'rule_canon',
        lesson_text: decision,
        importance: 'critical',
        confidence_score: 0.9,
        actor: 'yann',
        session_id: sessionId,
        intent: 'decision_yann_session_close'
      }, 'decision: ' + decision.slice(0, 60));
      results.push(r);
    }

    // ── 2. RÈGLES / CORRECTIONS COMPORTEMENT → lessons_learned ──
    const rules = Array.isArray(body.rules_learned) ? body.rules_learned.filter(r => r && r.trim()) : [];
    if (rules.length === 0) {
      warnings.push('Aucune regle/correction extraite - verifier si Yann a donne des corrections.');
    }
    for (const rule of rules) {
      const r = await pushToStaging('lessons_learned', {
        lesson_type: 'rule_canon',
        lesson_text: rule,
        importance: 'critical',
        confidence_score: 0.85,
        actor: 'yann',
        session_id: sessionId,
        intent: 'rule_learned_session_close'
      }, 'rule: ' + rule.slice(0, 60));
      results.push(r);
    }

    // ── 3. DÉCOUVERTES TECHNIQUES → lessons_learned (best_practice) ──
    const techDisc = Array.isArray(body.tech_discoveries) ? body.tech_discoveries.filter(d => d && d.trim()) : [];
    for (const disc of techDisc) {
      const r = await pushToStaging('lessons_learned', {
        lesson_type: 'best_practice',
        lesson_text: disc,
        importance: 'high',
        confidence_score: 0.8,
        actor: 'claude',
        session_id: sessionId,
        intent: 'tech_discovery_session_close'
      }, 'tech: ' + disc.slice(0, 60));
      results.push(r);
    }

    // ── 4. PATTERNS / ANTI-PATTERNS → lessons_learned ──
    const patterns = Array.isArray(body.patterns) ? body.patterns.filter(p => p && p.trim()) : [];
    for (const pattern of patterns) {
      const r = await pushToStaging('lessons_learned', {
        lesson_type: 'best_practice',
        lesson_text: pattern,
        importance: 'high',
        confidence_score: 0.8,
        actor: 'claude',
        session_id: sessionId,
        intent: 'pattern_session_close'
      }, 'pattern: ' + pattern.slice(0, 60));
      results.push(r);
    }

    // ── 5. CHANGEMENTS INFRA → knowledge_base ──
    const infraChanges = Array.isArray(body.infrastructure_changes) ? body.infrastructure_changes.filter(i => i && i.trim()) : [];
    for (const infra of infraChanges) {
      const r = await pushToStaging('knowledge_base', {
        title: 'Infra change session ' + sessionId,
        content: infra,
        category: 'infrastructure',
        importance: 'high',
        validated: false,
        session_id: sessionId,
        intent: 'infra_change_session_close'
      }, 'infra: ' + infra.slice(0, 60));
      results.push(r);
    }

    // ── 6. MISE À JOUR TÂCHES ROADMAP (statut seulement) ──
    const tasksStatus = Array.isArray(body.tasks_status) ? body.tasks_status : [];
    const taskResults = [];
    for (const task of tasksStatus) {
      if (!task.id || !task.status) continue;
      try {
        const patchBody = { status: task.status };
        if (task.notes) patchBody.description = task.notes;
        const r = await fetchWithTimeout(
          base + '/roadmap?id=eq.' + task.id,
          { method: 'PATCH', headers: hSupa, body: JSON.stringify(patchBody) },
          5000
        );
        taskResults.push({ id: task.id, status: task.status, ok: r.ok });
      } catch (e) {
        taskResults.push({ id: task.id, status: task.status, ok: false, error: e.message });
      }
    }


    // ── 6b. TASKS_DONE SHORTCUT [684] ──
    // Accepts tasks_done: [id1, id2, ...] as a simple array of task IDs to mark done.
    // Convenience shortcut so sessions don't forget to update roadmap status.
    // Merges with tasks_status (tasks_status takes precedence if same ID in both).
    // [863] tasks_done accepts: [id, ...] or [{id, evidence}, ...]
    // Simple IDs get auto-evidence from session summary. Objects use their own evidence.
    const rawTasksDone = Array.isArray(body.tasks_done) ? body.tasks_done : [];
    const tasksDoneParsed = rawTasksDone.map(item => {
      if (typeof item === 'number' && item > 0) return { id: item, evidence: 'Completed in session ' + sessionId + ': ' + (body.summary || '').slice(0, 200) };
      if (item && typeof item === 'object' && typeof item.id === 'number' && item.id > 0 && item.evidence) return { id: item.id, evidence: String(item.evidence).trim() };
      return null;
    }).filter(Boolean);
    const alreadyHandled = new Set(tasksStatus.map(t => t.id));
    for (const task of tasksDoneParsed) {
      if (alreadyHandled.has(task.id)) continue;
      try {
        const r = await fetchWithTimeout(
          base + '/roadmap?id=eq.' + task.id,
          { method: 'PATCH', headers: hSupa, body: JSON.stringify({ status: 'done', evidence: task.evidence }) },
          5000
        );
        taskResults.push({ id: task.id, status: 'done', ok: r.ok, via: 'tasks_done_shortcut' });
      } catch (e) {
        taskResults.push({ id: task.id, status: 'done', ok: false, error: e.message, via: 'tasks_done_shortcut' });
      }
    }

    // ── 6c. SUCCESS CAPTURE [717] ──
    // Quand une tache roadmap est DONE, propose automatiquement son pattern reussi
    // en staging knowledge_base. Comble le gap boucle succes identifie en [695].
    // Input optionnel: success_captures?: [{task_id, title, pattern}]
    // Si tasks_done fourni sans success_captures -> warning pedagogique (non bloquant).
    const successCaptures = Array.isArray(body.success_captures)
      ? body.success_captures.filter(s => s && s.task_id && s.pattern && s.pattern.trim())
      : [];
    const allDoneIds = new Set([
      ...tasksDone,
      ...tasksStatus.filter(t => t.status === 'done').map(t => t.id)
    ]);
    const capturedTaskIds = new Set(successCaptures.map(s => s.task_id));
    const successCaptureResults = [];

    for (const sc of successCaptures) {
      const title = sc.title || ('[DONE][' + sc.task_id + '] pattern reussi');
      const kbContent = '[DONE][' + sc.task_id + '] ' + sc.pattern.trim();
      const r = await pushToStaging('knowledge_base', {
        title: title.slice(0, 200),
        content: kbContent.slice(0, 2000),
        category: 'pattern_success',
        subcategory: 'success_pattern',
        importance: 'high',
        validated: false,
        session_id: sessionId,
        intent: 'success_capture_717'
      }, 'success_capture task ' + sc.task_id);
      successCaptureResults.push({ task_id: sc.task_id, ok: r.ok, staging_id: r.id });
    }

    // Warning pedagogique si taches DONE sans success_capture fourni
    const missingCaptures = [...allDoneIds].filter(id => !capturedTaskIds.has(id));
    if (missingCaptures.length > 0 && successCaptures.length === 0) {
      warnings.push('[717] success_capture: ' + missingCaptures.length + ' tache(s) DONE sans pattern capture (' + missingCaptures.join(', ') + '). Ajouter success_captures:[{task_id,title,pattern}] au prochain session/close.');
    }

    // [715] Gate lesson: warning si tasks_done sans lesson documentee dans ce batch
    const lessonsInBatch = results.filter(r => r.table === 'lessons_learned' && r.ok).length;
    if (allDoneIds.size > 0 && lessonsInBatch === 0) {
      warnings.push('[715] lesson_gate: ' + allDoneIds.size + ' tache(s) DONE (' + [...allDoneIds].join(', ') + ') mais aucune lesson_learned poussee dans ce batch. Documenter via tech_discoveries, patterns ou rules_learned.');
    }

    // ── 7b. CRÉER session_history si absente [676] ──
    try {
      const checkR = await fetchWithTimeout(
        base + '/session_history?id=eq.' + sessionId + '&select=id',
        { headers: hSupa }, 5000
      );
      const checkData = await checkR.json();
      if (!Array.isArray(checkData) || checkData.length === 0) {
        // Créer l'entrée
        await fetchWithTimeout(
          base + '/session_history',
          {
            method: 'POST',
            headers: { ...hSupa, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: sessionId,
              session_start: new Date().toISOString(),
              tasks_completed: summary.slice(0, 1000),
              notes: handoffNext.slice(0, 1000),
              author_system: 'session-close-endpoint-676',
              data_family: 'journal',
              project_scope: 'homelab'
            })
          },
          5000
        );
        warnings.push('session_history créée automatiquement pour session ' + sessionId);
      }
    } catch (e) {
      warnings.push('Echec check/create session_history: ' + e.message);
    }

    // ── 7. MISE À JOUR SESSION_HISTORY ──
    // summary et handoffNext déjà validés en amont [676]
    // (voir validation [676] ci-dessus)
    try {
      const sessionPatch = {
        session_end: new Date().toISOString(),
        tasks_completed: summary.slice(0, 1000),
        notes: handoffNext.slice(0, 1000)
      };
      await fetchWithTimeout(
        base + '/session_history?id=eq.' + sessionId,
        { method: 'PATCH', headers: hSupa, body: JSON.stringify(sessionPatch) },
        5000
      );
    } catch (e) {
      warnings.push('Echec mise a jour session_history: ' + e.message);
    }

    // ── 8. MISE À JOUR HANDOFF_VIVANT dans current_state ──
    if (handoffNext) {
      try {
        await fetchWithTimeout(
          base + '/current_state?key=eq.handoff_vivant',
          {
            method: 'PATCH',
            headers: hSupa,
            body: JSON.stringify({ value: handoffNext.slice(0, 2000), updated_at: new Date().toISOString() })
          },
          5000
        );
      } catch (e) {
        warnings.push('Echec mise a jour handoff_vivant: ' + e.message);
      }
    }

    // ── 9. APPELER VALIDATE pour promouvoir les staging items ──
    let validateResult = null;
    const pendingCount = results.filter(r => r.ok).length;
    if (pendingCount > 0) {
      try {
        const valRes = await fetchWithTimeout(
          'http://172.17.0.1:4001/run/validate',
          { method: 'POST', headers: { 'X-BRUCE-TOKEN': (BRUCE_AUTH_TOKEN || 'bruce-secret-token-01'), 'Content-Type': 'application/json' } },
          65000
        );
        validateResult = await valRes.json();
      } catch (e) {
        warnings.push('validate.py call failed: ' + e.message + ' - items restent en staging pending.');
      }
    }


    // ── 9b. MISE À JOUR CURRENT_STATE [676] ──
    try {
      const currentStateValue = JSON.stringify({
        session_en_cours: 'Session ' + sessionId + ' TERMINEE',
        phase: summary.slice(0, 200),
        derniere_maj: new Date().toISOString().split('T')[0],
        fait: (body.tasks_status || []).filter(t => t.status === 'done').map(t => '[' + t.id + '] DONE'),
        next: handoffNext.slice(0, 300)
      });
      await fetchWithTimeout(
        base + '/current_state?key=eq.CURRENT_STATE',
        {
          method: 'PATCH',
          headers: hSupa,
          body: JSON.stringify({ value: currentStateValue, updated_at: new Date().toISOString() })
        },
        5000
      );
    } catch (e) {
      warnings.push('Echec mise a jour CURRENT_STATE: ' + e.message);
    }

    // ── 10. RÉSUMÉ FINAL ──
    const categoryCounts = {
      decisions: decisions.length,
      rules_learned: rules.length,
      tech_discoveries: techDisc.length,
      patterns: patterns.length,
      infrastructure_changes: infraChanges.length,
      tasks_updated: taskResults.length,
    };
    const totalExtracted = Object.values(categoryCounts).reduce((a, b) => a + b, 0);
    const emptyCategories = Object.entries(categoryCounts)
      .filter(([_, v]) => v === 0)
      .map(([k]) => k);

    return res.json({
      ok: true,
      session_id: sessionId,
      summary: summary.slice(0, 200),
      total_items_extracted: totalExtracted,
      staging_pushed: results.filter(r => r.ok).length,
      staging_failed: results.filter(r => !r.ok).length,
      category_counts: categoryCounts,
      empty_categories: emptyCategories,
      task_updates: taskResults,
      success_capture_results: successCaptureResults,
      validate_result: validateResult,
      warnings: warnings,
      message: emptyCategories.length > 0
        ? `⚠️ ${emptyCategories.length} categories vides: ${emptyCategories.join(', ')}. Verifier si la session contenait ces informations.`
        : `✅ Toutes les categories couvertes. ${totalExtracted} items extraits.`
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
module.exports.setSafePythonSpawn = setSafePythonSpawn;
