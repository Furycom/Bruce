// shared/llm-profiles.js — [773] C7 REFONTE
// LLM profile system: detectLLMIdentity, loadLLMProfile, buildContextForProfile
const { SUPABASE_URL, SUPABASE_KEY } = require('./config');
const { bruceClampInt } = require('./helpers');
const { fetchWithTimeout } = require('./fetch-utils');

/**
 * Resolves the effective client IP from forwarding headers or socket metadata.
 * @param {import('express').Request} req - Request object containing network metadata.
 * @returns {string} Best-effort client IP string for identity detection.
 */
function bruceClientIp(req) {

  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown");
}

const BRUCE_OPERATING_PRINCIPLES = `BRUCE OPERATING PRINCIPLES:
- Projet: homelab intelligent avec mémoire persistante (Supabase)
- Écriture: TOUJOURS via staging_queue → validate.py → canon. Jamais directe.
- Documentation: noter toute découverte/action immédiatement dans Supabase
- Stabilité: ne jamais modifier ce qui fonctionne sans raison explicite
- Consolidation: documenter avant de passer à la tâche suivante
- Source de vérité: Supabase canon tables (pas legacy_)`;

const LLM_PROFILES_FALLBACK = {
  claude: {
    profile_name: 'claude',
    display_name: 'Claude (Sonnet/Opus)',
    blind_spots: [
      'INTERDICTION: JAMAIS invoke_expression pour SSH → Start-Job + Wait-Job -Timeout 25',
      'INTERDICTION: JAMAIS guillemets doubles imbriqués SSH → script .sh + SCP + exec',
      'INTERDICTION: JAMAIS sed/Go templates/heredoc via PowerShell → script .sh',
      'INTERDICTION: JAMAIS docker restart pour nouveaux volumes → docker compose up -d',
      'INTERDICTION: JAMAIS déclarer terminal bloqué sans preuve → vérifier list_sessions',
      'Documenter avant d\'avancer — staging_queue puis validate.py',
      'Pas de réécriture claude.md',
      'AVANT toute action SSH/docker/transfert/ecriture REST: consulter /bruce/preflight {action_type}'
    ],
    tools_available: ['mcp_semantic_search', 'powershell_rest', 'ssh_start_process', 'desktop_commander'],
    rules: ['Écriture: staging → validate → canon', 'SSH: start_process, jamais invoke_expression bloquant', 'Consolider avant d\'avancer'],
    context_format: 'markdown_structured',
    max_context_tokens: 5000
  },
  chatgpt: {
    profile_name: 'chatgpt',
    display_name: 'ChatGPT (relais Yann SSH)',
    blind_spots: ['Pas d\'accès direct — snapshot uniquement', 'Commandes copiées manuellement par Yann'],
    tools_available: [],
    rules: ['Formule des commandes que Yann copiera en SSH', 'Indique quand Claude devrait traiter la tâche'],
    context_format: 'narrative_concise',
    max_context_tokens: 2000
  },
  'local-llm': {
    profile_name: 'local-llm',
    display_name: 'llama.cpp Local LLM (Dell 7910)',
    blind_spots: ['Raisonnement stratégique limité', 'Hallucine sans sources RAG - modele alpha via LiteLLM .230:4100'],
    tools_available: [],
    rules: ['Base ta réponse sur les sources RAG', 'Ne propose pas d\'actions techniques', 'Indique si Claude devrait traiter'],
    context_format: 'concise_factual',
    max_context_tokens: 800
  }
};

let _profileCache = { data: null, ts: 0 };
const PROFILE_CACHE_TTL = 5 * 60 * 1000;

/**
 * Detects which LLM profile should be used for the current request.
 * @param {import('express').Request} req - Request containing optional identity headers and source metadata.
 * @returns {string} Profile identity key such as `claude`, `chatgpt`, or `local-llm`.
 */
function detectLLMIdentity(req) {

  const explicit = (req.headers['x-llm-identity'] || '').trim().toLowerCase();
  if (explicit && (LLM_PROFILES_FALLBACK[explicit] || explicit === 'claude' || explicit === 'chatgpt' || explicit === 'local-llm')) {
    return explicit;
  }
  const ip = bruceClientIp(req);
  if (ip.includes('192.168.2.190')) return 'claude';
  if (ip === '172.18.0.1' || ip === '::ffff:172.18.0.1') return 'chatgpt';
  if (ip.includes('192.168.2.32')) return 'local-llm'; // [902] llama.cpp Dell 7910
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('powershell')) return 'claude';
  return 'claude';
}

/**
 * Loads a profile definition from Supabase with fallback to local defaults.
 * @param {string} identity - Profile identity key to resolve.
 * @returns {Promise<Record<string, any>>} Profile configuration object for prompt/context shaping.
 */
async function loadLLMProfile(identity) {

  const now = Date.now();
  if (_profileCache.data && (now - _profileCache.ts) < PROFILE_CACHE_TTL) {
    const cached = _profileCache.data[identity];
    if (cached) return cached;
  }
  try {
    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key = String(SUPABASE_KEY || '');
    const res = await fetchWithTimeout(
      base + '/llm_profiles?active=eq.true',
      { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
      5000
    );
    const profiles = await res.json();
    if (Array.isArray(profiles) && profiles.length > 0) {
      const map = {};
      for (const p of profiles) map[p.profile_name] = p;
      _profileCache = { data: map, ts: now };
      if (map[identity]) return map[identity];
    }
  } catch (e) { /* Supabase indisponible — fallback */ }
  return LLM_PROFILES_FALLBACK[identity] || LLM_PROFILES_FALLBACK['claude'];
}

/**
 * Builds the formatted context block tailored to a selected LLM profile.
 * @param {Record<string, any>} profile - Active LLM profile configuration.
 * @param {Record<string, any>|null} dashboard - Dashboard summary metrics.
 * @param {Array<Record<string, any>>} tasks - Pending roadmap tasks.
 * @param {Array<Record<string, any>>} lessons - Critical lessons learned entries.
 * @param {Array<Record<string, any>>} ragResults - Semantic retrieval results.
 * @param {Array<Record<string, any>>} currentState - Current state rows used to enrich context.
 * @returns {string} Context text ready to be injected into prompts.
 */
function buildContextForProfile(profile, dashboard, tasks, lessons, ragResults, currentState) {

  const parts = [];
  const format = profile.context_format || 'markdown_structured';
  const isClaude = profile.profile_name === 'claude';

  if (format === 'markdown_structured' && Array.isArray(currentState)) {
    const csEntry = currentState.find(s => s.key === 'CURRENT_STATE');
    if (csEntry && csEntry.value) {
      try {
        const cs = typeof csEntry.value === 'string' ? JSON.parse(csEntry.value) : csEntry.value;
        const csLines = ['**ÉTAT COURANT DU PROJET:**'];
        if (cs.session_en_cours) csLines.push('- Session: ' + cs.session_en_cours);
        if (cs.phase) csLines.push('- Phase: ' + cs.phase);
        if (Array.isArray(cs.fait) && cs.fait.length > 0) csLines.push('- Fait: ' + cs.fait.join(', '));
        if (Array.isArray(cs.next_sonnet) && cs.next_sonnet.length > 0) csLines.push('- Next Sonnet: ' + cs.next_sonnet.slice(0,3).join(', '));
        if (Array.isArray(cs.next_opus) && cs.next_opus.length > 0) csLines.push('- Next Opus: ' + cs.next_opus.slice(0,2).join(', '));
        if (Array.isArray(cs.blockers) && cs.blockers.length > 0) csLines.push('- Blockers: ' + cs.blockers.join(', '));
        parts.push(csLines.join('\n'));
      } catch(e) {
        parts.push('**ÉTAT COURANT:** ' + String(csEntry.value).slice(0, 300));
      }
    }
  }

  if (format === 'markdown_structured' && !isClaude && Array.isArray(currentState)) {
    const scEntry = currentState.find(s => s.key === 'SERVICES_CONFIG');
    if (scEntry && scEntry.value) {
      try {
        const sc = typeof scEntry.value === 'string' ? JSON.parse(scEntry.value) : scEntry.value;
        if (Array.isArray(sc.services)) {
          const svcLine = sc.services.map(s => s.name + '(' + (s.url || '').replace('http://','').split('/')[0] + ')').join(' | ');
          parts.push('**SERVICES:** ' + svcLine);
        }
      } catch(e) {}
    }
  }

  if (!isClaude) parts.push(BRUCE_OPERATING_PRINCIPLES);

  const blindSpots = Array.isArray(profile.blind_spots) ? profile.blind_spots : [];
  const tools = Array.isArray(profile.tools_available) ? profile.tools_available : [];
  const rules = Array.isArray(profile.rules) ? profile.rules : [];

  if (blindSpots.length > 0 && !isClaude) {
    parts.push('RAPPELS SPÉCIFIQUES (' + profile.display_name + '):\n' + blindSpots.map(b => '- ' + b).join('\n'));
  }
  if (tools.length > 0 && !isClaude) parts.push('OUTILS DISPONIBLES: ' + tools.join(', '));
  if (rules.length > 0 && !isClaude) parts.push('RÈGLES:\n' + rules.map(r => '- ' + r).join('\n'));

  if (dashboard) {
    if (format === 'concise_factual') {
      parts.push('ÉTAT: lessons=' + (dashboard.lessons_total||0) + ' kb=' + (dashboard.kb_total||0) + ' roadmap_done=' + (dashboard.roadmap_done||0) + ' staging=' + (dashboard.staging_pending||0));
    } else {
      parts.push('**Dashboard:** lessons=' + (dashboard.lessons_total||0) + ' | kb=' + (dashboard.kb_total||0) + ' | roadmap_done=' + (dashboard.roadmap_done||0) + ' | staging_pending=' + (dashboard.staging_pending||0));
    }
  }

  if (Array.isArray(tasks) && tasks.length > 0) {
    const maxTasks = (format === 'concise_factual') ? 2 : 5;
    if (format === 'concise_factual') {
      const taskLines = tasks.slice(0, maxTasks).map(t => '[' + t.id + '] ' + t.step_name + ' (P' + t.priority + ')');
      parts.push('PROCHAINES TÂCHES: ' + taskLines.join(' | '));
    } else if (format === 'narrative_concise') {
      const taskLines = tasks.slice(0, 3).map(t => '- [' + t.id + '] ' + t.step_name + ' (priorité ' + t.priority + ')' + (t.model_hint ? ' [' + t.model_hint + ']' : ''));
      parts.push('Prochaines tâches:\n' + taskLines.join('\n'));
    } else {
      const taskLines = tasks.slice(0, maxTasks).map(t => '- [' + t.id + '] ' + (t.model_hint === 'opus' ? '[OPUS] ' : '') + t.step_name + ' (P' + t.priority + ')');
      parts.push('**Prochaines tâches:**\n' + taskLines.join('\n'));
    }
  }

  if (Array.isArray(lessons) && lessons.length > 0) {
    const maxLessons = (format === 'concise_factual') ? 2 : (format === 'narrative_concise') ? 3 : 5;
    const truncLen = (format === 'concise_factual') ? 80 : 150;
    const lessonLines = lessons.slice(0, maxLessons).map(l => '- ' + (l.lesson_text || '').slice(0, truncLen));
    if (format === 'concise_factual') {
      parts.push('LEÇONS: ' + lessonLines.join(' | '));
    } else {
      parts.push((format === 'markdown_structured' ? '**Leçons critiques:**' : 'Leçons critiques:') + '\n' + lessonLines.join('\n'));
    }
  }

  if (format !== 'concise_factual' && Array.isArray(currentState)) {
    const regles = currentState
      .filter(s => s.key && s.key.startsWith('REGLE_YANN_'))
      .slice(0, isClaude ? 0 : (format === 'narrative_concise') ? 2 : 4)
      .map(s => '- ' + s.value.replace(/RÈGLE CANON YANN: /, '').replace(/REGLE CANON YANN: /, '').slice(0, 100));
    if (regles.length > 0) {
      parts.push((format === 'markdown_structured' ? '**Règles Yann (canon):**' : 'Règles Yann:') + '\n' + regles.join('\n'));
    }
  }

  if (format === 'markdown_structured' && !isClaude) {
    parts.push('**Outils disponibles:** /bruce/ask {question} | /bruce/integrity | /bruce/state | /bruce/rag/context | GET /bruce/roadmap/list');
    parts.push('**CHECKLIST DOCUMENTATION (apres chaque action/installation):**\n' +
      '- [ ] Ce qui a echoue: commande exacte + message erreur exact + cause\n' +
      '- [ ] Ce qui a fonctionne: commande exacte complete, reproductible copier-coller\n' +
      '- [ ] Ce qui va se repeter: documenter comme runbook generique\n' +
      '- [ ] Correction idee recue: si hypothese fausse, la corriger explicitement en KB');
    parts.push('**CHECKLIST CLOTURE SESSION (obligatoire avant de terminer):**\n' +
      '- [ ] Decisions explicites de Yann\n' +
      '- [ ] Corrections de comportement demandees par Yann\n' +
      '- [ ] Decouvertes techniques\n' +
      '- [ ] Nouveaux patterns ou anti-patterns\n' +
      '- [ ] Etat des taches modifie\n' +
      '- [ ] Informations infrastructure nouvelles\n' +
      '- [ ] Tout ne-fais-plus-ca ou fais-toujours-ca\n' +
      'Chaque categorie doit etre verifiee et extraite via staging_queue AVANT de cloturer.\n' +
      '\n**CHOIX FIN DE SESSION (obligatoire):** Presenter a Yann: A) Continuer B) Nouvelle session Sonnet C) Nouvelle session Opus');
  }

  return parts.join('\n\n');
}

module.exports = {
  bruceClientIp,
  BRUCE_OPERATING_PRINCIPLES,
  LLM_PROFILES_FALLBACK,
  detectLLMIdentity,
  loadLLMProfile,
  buildContextForProfile
};
