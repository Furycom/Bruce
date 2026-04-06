// shared/scope-classifier.js — [1226]+[1367] Auto-classeur projets S1338+S1440 Opus
// Classifie automatiquement le project_scope ET project_id par analyse de keywords.
// REGLE: n'opere que si scope absent, vide ou "homelab" (defaut).
// Si le caller a explicitement choisi un scope != homelab, on le respecte.
// v2.0 S1440: ajout project_id (FK) + registre etendu a tous les projets actifs.

/**
 * Registre des projets connus avec leurs mots-cles de detection.
 * Score = nombre de keywords matches. Le scope avec le plus de hits gagne.
 * Seuil minimum: 2 keyword matches pour reclassifier (v1.1).
 * v2.0: chaque entree a un project_id numerique (FK vers table projects).
 */
const PROJECT_REGISTRY = [
  {
    scope: 'screensaver',
    project_id: 1,
    keywords: [
      'bruce_screensaver', 'screensaver_state', 'screensaver job',
      'screensaver pipeline', 'screensaver context',
      'screensaver.js', 'bruce_screensaver.py',
      'canon_nomination', 'screensaver_keep_count', 'screensaver_cycle_count',
      'screensaver_modules', 'job_dedup', 'job_vrc', 'job_lesson_review',
      'job_kb_audit', 'job_ingestion', 'job_session_summary',
      'screensaver_jobs_completed', 'screensaver_reviewed_at'
    ],
  },
  {
    scope: 'media',
    project_id: 3,
    keywords: [
      'mediatheque', 'media_library', 'videoway', 'vidéoway', 'vhs',
      'cassette vhs', 'tmdb', 'tmdb_id', 'smb inbox',
      'media library', 'scan_disk', 'pool 6x', 'disque offline',
      'yamtrack', 'empreinte cinematographique'
    ],
  },
  {
    scope: 'dspy',
    project_id: 4,
    keywords: [
      'dspy', 'dspy module', 'dspy optimization', 'dspy optimize',
      'dspy signature', 'dspy teleprompter', 'dspy compiled'
    ],
  },
  {
    scope: 'domotique',
    project_id: 5,
    keywords: [
      'home assistant', 'hass', 'zigbee', 'z-wave', 'domotique',
      'sonnette ha', 'automatisation maison', 'thermostat connecte',
      'reolink', 'camera ip'
    ],
  },
  {
    scope: 'vrc',
    project_id: 6,
    keywords: [
      'vrc', 'verification rigoureuse', 'clarifications_pending',
      'vrc_escalate', 'vrc_llm_evaluate', 'canon review',
      'gate factuelle', 'gate survie', 'gate dedup',
      'score_llm', 'worthy'
    ],
  },
  {
    scope: 'openwebui',
    project_id: 7,
    keywords: [
      'openwebui', 'open-webui', 'open webui', 'aura v2', 'workspace model',
      'filter pipeline', 'bruce_context_injector', 'filterids', 'toolids',
      'webui.db', 'sqlite openwebui', '/api/v1/models', '/api/v1/auths',
      'is_global', 'base_model_id', 'workspace models'
    ],
  },
  {
    scope: 'truenas',
    project_id: 8,
    keywords: [
      'truenas', 'true nas', 'zpool', 'raidz', 'raidz2',
      'tank dataset', 'smb share truenas', 'nfs truenas',
      'sg_format', 'sas enterprise', 'st6000nm',
      '192.168.2.60', 'truenas_admin'
    ],
  },
  {
    scope: 'slickwear',
    project_id: 9,
    keywords: [
      'slickwear', 'shopify slickwear', 'boutique slickwear',
      'slickwear.furycom.com', 'theme shopify slickwear'
    ],
  },
  {
    scope: 'dashboard',
    project_id: 10,
    keywords: [
      'dashboard bruce', 'bruce dashboard', 'bruce-dashboard',
      'tableau projet', 'tableau projets', 'tuile projet',
      'expansion in-place', 'react tailwind recharts',
      '192.168.2.12:8029', 'box2-daily dashboard',
      'health-all', 'drag-and-drop projet'
    ],
  },
  {
    scope: 'transformation',
    project_id: 11,
    keywords: [
      'transformation bruce', 'cahier exigences', 'plan travail bruce',
      'score conformite', 'exigence a0', 'exigence p0',
      's1400 extraction', 'backlog investigation'
    ],
  },
  {
    scope: 'gateway',
    project_id: 13,
    keywords: [
      'mcp gateway', 'mcp-gateway', 'bruce gateway', 'context engine',
      'context-engine.js', 'topic-context.js',
      'exec-security.js', 'data-write.js', 'data-patch.js', 'data-read.js',
      'session.js', 'server.js gateway', 'routes gateway',
      'scope-classifier', 'context-rules.json',
      '192.168.2.230:4000', 'bruce_exec', 'kb_write'
    ],
  },
  {
    scope: 'llm_local',
    project_id: 14,
    keywords: [
      'llama-router', 'llama.cpp', 'llama server', 'gguf',
      'qwen3-32b', 'qwen3-14b', 'qwen35-9b', 'alpha model',
      'vram gpu', 'models-max', '192.168.2.32:8000',
      'litellm', 'litellm proxy'
    ],
  },
  {
    scope: 'infrastructure',
    project_id: 15,
    keywords: [
      'proxmox', 'box1', 'box2', 'vm proxmox', 'vzdump',
      'thin pool', 'lvm', 'dell precision 7910',
      'ssh config', 'homelab_key', 'mcp servers liste',
      'cloudflare tunnel', 'nginx proxy'
    ],
  },
  {
    scope: 'n8n',
    project_id: 16,
    keywords: [
      'n8n', 'workflow n8n', 'wf90', 'wf101', 'wf102',
      'n8n automation', 'n8n api', 'n8n webhook',
      '192.168.2.174:5678', 'box2-automation n8n'
    ],
  },
  {
    scope: 'lightrag',
    project_id: 17,
    keywords: [
      'lightrag', 'light rag', 'graphe connaissance',
      'knowledge graph lightrag', 'bruce_chunks',
      '192.168.2.230:9621', 'lightrag index'
    ],
  },
  {
    scope: 'observability',
    project_id: 18,
    keywords: [
      'grafana', 'prometheus', 'loki', 'alertmanager',
      'langfuse', 'pulse monitoring', 'uptime kuma',
      '192.168.2.154', 'box2-observability'
    ],
  },
  {
    scope: 'backup',
    project_id: 20,
    keywords: [
      'backup supabase', 'pg_dump', 'backup proxmox',
      'vzdump backup', 'backup rotation', 'backup tank',
      'pg_backup_supabase', 'backup_supabase_storage'
    ],
  },
  {
    scope: 'forgejo',
    project_id: 27,
    keywords: [
      'forgejo', 'git forge', 'forgejo repo',
      '192.168.2.230:3300', 'versionner scripts'
    ],
  },
  {
    scope: 'supabase',
    project_id: 28,
    keywords: [
      'supabase schema', 'supabase migration', 'postgrest',
      'supabase rls', 'supabase-db', 'psql supabase',
      'staging_queue', 'validate.py', 'gate-1',
      '192.168.2.146:8000', '5-tiers', 'table_schemas'
    ],
  },
  {
    scope: 'gouvernance',
    project_id: 29,
    keywords: [
      'gouvernance bruce', 'adr-001', 'zone canon',
      'regle canon', 'trust graduation', 'authority tier',
      'bootstrap session', 'anti-pattern', 'piege actif'
    ],
  },
  {
    scope: 'elevage',
    project_id: null,
    keywords: [
      'elevage canin', 'élevage canin', 'chiot', 'portee canine', 'portée canine',
      'saillie', 'reproduction canine', 'pedigree', 'eleveur canin', 'éleveur canin',
      'gestation chien', 'vermifuge chien'
    ],
  },
  {
    scope: 'musique',
    project_id: null,
    keywords: [
      'flac', 'musicbee', 'collection musicale', 'lossless',
      'beets', 'lidarr', 'picard', 'acoustid', 'album musique',
      'playlist musicale'
    ],
  },
];

// Pre-compile lowercase keywords for each project
const COMPILED_REGISTRY = PROJECT_REGISTRY.map(p => ({
  scope: p.scope,
  project_id: p.project_id,
  keywords: p.keywords.map(k => k.toLowerCase()),
}));

/**
 * Classify text content against project registry.
 * @param {string[]} textFields - Array of text strings to analyze
 * @returns {{ scope: string|null, project_id: number|null, score: number, runner_up: object|null }}
 */
function classifyScope(textFields) {
  const combined = textFields
    .filter(Boolean)
    .map(t => String(t).toLowerCase())
    .join(' ');

  if (!combined || combined.length < 10) return { scope: null, project_id: null, score: 0, runner_up: null };

  const scores = [];
  for (const project of COMPILED_REGISTRY) {
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

  // v1.1: Minimum 2 keyword matches to reclassify
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
 * @param {string} table - Target table name
 * @param {object} data - The contenu_json payload
 * @returns {{ applied: boolean, original: string, classified: string|null, project_id: number|null, detail: object }}
 */
function autoClassifyScope(table, data) {
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

  const result = classifyScope(textFields);

  if (!result.scope) {
    return {
      applied: false,
      original: currentScope || 'homelab',
      classified: null,
      project_id: null,
      detail: { reason: result.ambiguous ? 'ambiguous' : result.below_threshold ? 'below_threshold' : 'no_match', ...result }
    };
  }

  if (result.scope === 'homelab') {
    return { applied: false, original: 'homelab', classified: 'homelab', project_id: null, detail: { reason: 'already_homelab', ...result } };
  }

  return {
    applied: true,
    original: currentScope || 'homelab',
    classified: result.scope,
    project_id: result.project_id,
    detail: result
  };
}

module.exports = { classifyScope, autoClassifyScope, PROJECT_REGISTRY };
