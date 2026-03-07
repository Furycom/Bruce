const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// ========== SHARED MODULES (C1 refonte) ==========
const {
  PORT, SUPABASE_URL, SUPABASE_KEY, EMBEDDER_URL, MANUAL_ROOT,
  BRUCE_AUTH_TOKEN, BRUCE_LLM_API_BASE, BRUCE_LLM_MODEL, BRUCE_LLM_API_KEY, BRUCE_LITELLM_KEY,
  BRUCE_MAX_MESSAGE_CHARS, BRUCE_LLM_TIMEOUT_MS, BRUCE_MAX_CONCURRENT,
  BRUCE_FALLBACK_LOG_PATH, BRUCE_SOURCE_DEFAULT, CONNECTORS_PATH,
} = require('./shared/config');
const { validateBruceAuth } = require('./shared/auth');
const {
  utcNowIso, stripThinkBlock, isSupabaseConfigured, appendLineToFile,
  logFallback, bruceClampInt, safeJoinManual, listMarkdownFiles, pingUrl,
} = require('./shared/helpers');
const { insertMemoryEvent, insertConversationMessage } = require('./shared/supabase-client');
const { acquireLlmSlot, releaseLlmSlot, callLlm } = require('./shared/llm-queue');

// ========== ROUTE MODULES (C2a refonte) ==========
const adminRoutes = require('./routes/admin');
const connectorsRoutes = require('./routes/connectors');
const manualRoutes = require('./routes/manual');
const toolsRoutes = require('./routes/tools');
const browserRoutes = require('./routes/browser');
const memoryRoutes = require('./routes/memory');
const stagingRoutes = require('./routes/staging');
const dockerRoutes = require('./routes/docker');
const execRoutes = require('./routes/exec');
const chatgptRoutes = require('./routes/chatgpt');
const searchRoutes = require('./routes/search');

const app = express();

// ============================================================
// [775-P1] Global error handlers — prevent container crash
// ============================================================
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception (caught by P1 handler):', err.message);
  console.error(err.stack);
  // Do NOT exit — keep the server running
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection (caught by P1 handler):', reason);
});
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received — graceful shutdown');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('[SHUTDOWN] SIGINT received — graceful shutdown');
  process.exit(0);
});

// [775-P1] Safe python spawn — returns null if python3 unavailable
function safePythonSpawn(scriptPath, args, options) {
  try {
    const { execSync } = require('child_process');
    try { execSync('which python3', { stdio: 'ignore' }); } catch (_) {
      console.warn('[P1-SKIP] python3 not found in container, skipping:', scriptPath);
      return null;
    }
    const { spawn } = require('child_process');
    const child = spawn('python3', [scriptPath, ...args], options || {});
    child.on('error', (err) => {
      console.error('[P1-SPAWN-ERR]', scriptPath, err.message);
    });
    return child;
  } catch (err) {
    console.error('[P1-SPAWN-ERR] Failed to spawn:', scriptPath, err.message);
    return null;
  }
}

// Basic JSON parsing
app.use(express.json());

// Simple CORS for local tools / front-ends
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Mount extracted routes (C2a)
app.use(adminRoutes);
app.use(connectorsRoutes);
app.use(manualRoutes);
app.use(toolsRoutes);
app.use(browserRoutes);
app.use(memoryRoutes);
app.use(stagingRoutes);
app.use(dockerRoutes);
app.use(execRoutes);
app.use(chatgptRoutes);
app.use('/bruce/search', searchRoutes);

// ========== HEALTH ==========

// --- OpenAPI spec for OpenWebUI Tool Server (VB1) ---
const BRUCE_OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "BRUCE MCP Gateway (VB1)",
    version: "1.0.0",
    description: "Minimal OpenAPI Tool Server for OpenWebUI: health, open issues, memory append (Supabase-backed)."
  },
  servers: [{ url: "http://192.168.2.230:4000" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" }
    },
    schemas: {
      MemoryAppendRequest: {
        type: "object",
        required: ["source"],
        properties: {
          source:   { type: "string", description: "Required. Example: openwebui" },
          author:   { type: "string" },
          channel:  { type: "string" },
          content:  { type: "string" },
          tags:     { type: "array", items: { type: "string" } },
          metadata: { type: "object", additionalProperties: true }
        }
      }
    }
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": {
      get: {
        operationId: "bruce_health",
        summary: "Health check for gateway + Supabase connectivity",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          }
        }}
    },
    "/bruce/issues/open": {
      get: {
        operationId: "bruce_open_issues",
        summary: "List current open issues (from Supabase view/function)",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          }
        }}
    },
    "/bruce/introspect/last-seen": {
      get: {
        operationId: "bruce_introspect_last_seen",
        summary: "Last seen timestamps per source/host (from public.bruce_last_seen)",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer" } }
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          }
        }}
    },
    "/bruce/introspect/docker/summary": {
      get: {
        operationId: "bruce_introspect_docker_summary",
        summary: "Docker container counts per host (from public.docker_summary)",
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer" } }
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          }
        }}
    },
    "/bruce/memory/append": {
      post: {
        operationId: "bruce_memory_append",
        summary: "Append a memory journal entry (requires source)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { "$ref": "#/components/schemas/MemoryAppendRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true }
              }
            }
          }
        }}
    }
  ,
      
      "/bruce/config/llm": {
        get: {
          operationId: "bruce_config_llm",
          summary: "Read-only LLM configuration (base + model)",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true }
                }
              }
            }
          }
        }
      },
        "/bruce/llm/models": {
          get: {
            operationId: "bruce_llm_models",
            summary: "Proxy: list models via configured LLM base",
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object", additionalProperties: true }
                  }
                }
              }
            }
          }
        },
        "/bruce/llm/chat": {
          post: {
            operationId: "bruce_llm_chat",
            summary: "Proxy: chat completions via configured LLM base",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true }
                }
              }
            },
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object", additionalProperties: true }
                  }
                }
              }
            }
          }
        },
      "/bruce/rag/metrics": {
        get: {
          operationId: "bruce_rag_metrics",
          summary: "RAG metrics (rate-limit + latency + counters)",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true }
                }
              }
            }
          }
        }
      },
"/bruce/rag/search": {
        post: {
          operationId: "bruce_rag_search",
          summary: "Hybrid RAG search (BGE-M3 embedder + Supabase bruce_rag_hybrid_search)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["q"],
                  properties: {
                    q: { type: "string", description: "Query text" },
                    k: { type: "integer", description: "Top K (default 10)", default: 10 }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true }
                }
              }
            }
          }
        }
      },
      "/bruce/rag/context": {
        post: {
          operationId: "bruce_rag_context",
          summary: "Hybrid RAG context (embedder + Supabase bruce_rag_hybrid_search_text)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["q"],
                  properties: {
                    q: { type: "string", description: "Query text" },
                    k: { type: "integer", description: "Top K (default 10)", default: 10 }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "object", additionalProperties: true }
                }
              }
            }
          }
        }
      }
    }
};


// --- PATCH: OpenAPI expose /bruce/agent/chat ---
BRUCE_OPENAPI_SPEC.paths["/bruce/agent/chat"] = {
  post: {
    summary: "BRUCE Agent chat",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", additionalProperties: true }
        }
      }
    },
    responses: {
      "200": {
        description: "OK",
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: true }
          }
        }
      }
    }
  }
};
// --- /PATCH ---


app.get("/openapi.json", (req, res) => {
  // Safe to expose spec without auth; actual tool calls remain protected by gateway auth.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(JSON.stringify(BRUCE_OPENAPI_SPEC, null, 2));
});

// --- READ-ONLY: LLM config (Pack A / VB15) ---
app.get("/bruce/config/llm", (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });

  return res.json({
    ok: true,
    base: BRUCE_LLM_API_BASE || null,
    model: BRUCE_LLM_MODEL || null
  });
});

  // --- LLM PROXY (VB16) ---

  function bruceLlmBase() {
    return String(BRUCE_LLM_API_BASE || "").replace(/\/+$/, "");
  }

  async function bruceFetchWithTimeout(url, opts, timeoutMs) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // List models via MCP (auth required)
  app.get("/bruce/llm/models", async (req, res) => {
    const auth = validateBruceAuth(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });

    const base = bruceLlmBase();
    if (!base) return res.status(503).json({ ok: false, error: "LLM base is not configured" });

    try {
      const upstream = `${base}/models`;
      const r = await bruceFetchWithTimeout(
        upstream,
        {
          method: "GET",
          headers: {
            ...(BRUCE_LLM_API_KEY ? { Authorization: `Bearer ${BRUCE_LLM_API_KEY}` } : {}),
          }
        },
        BRUCE_LLM_TIMEOUT_MS
      );
      const text = await r.text();
      res.status(r.status);
      res.setHeader("Content-Type", r.headers.get("content-type") || "application/json; charset=utf-8");
      return res.send(text);
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  // Chat completions via MCP (auth required)
  app.post("/bruce/llm/chat", async (req, res) => {
    const auth = validateBruceAuth(req);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });

    const base = bruceLlmBase();
    if (!base) return res.status(503).json({ ok: false, error: "LLM base is not configured" });

    try {
      const upstream = `${base}/chat/completions`;
      const payload = (req.body && typeof req.body === "object") ? req.body : {};

      if (payload.stream) {
        return res.status(400).json({ ok: false, error: "stream=true is not supported via MCP proxy; call vLLM directly for streaming" });
      }

      if (!payload.model && BRUCE_LLM_MODEL) payload.model = BRUCE_LLM_MODEL;

      const r = await bruceFetchWithTimeout(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(BRUCE_LLM_API_KEY ? { Authorization: `Bearer ${BRUCE_LLM_API_KEY}` } : {}),
        },
        body: JSON.stringify(payload)
      }, BRUCE_LLM_TIMEOUT_MS);

      const text = await r.text();
      res.status(r.status);
      res.setHeader("Content-Type", r.headers.get("content-type") || "application/json; charset=utf-8");
      return res.send(text);
    } catch (e) {
      return res.status(502).json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
  // --- /LLM PROXY ---

// --- /READ-ONLY: LLM config ---

// --- /OpenAPI spec ---


// --- READ-ONLY unified endpoint (VB1) ---
app.post("/bruce/read", async (req, res) => {
  // auth (same pattern as other /bruce routes)
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: auth.error });

  try {
    const q = String((req.body && req.body.q) ? req.body.q : "").trim();
    const params = (req.body && typeof req.body.params === "object" && req.body.params) ? req.body.params : {};

    if (!q) return res.status(400).json({ ok: false, error: "Missing q" });

    // Call Supabase RPC: public.bruce_read(q, params)
    const url = `${SUPABASE_URL.replace(/\/+$/, "")}rpc/bruce_read`;

    const base = SUPABASE_URL.replace(/\/+$/, "");
    const candidates = [
      `${base}/rpc/bruce_read`,
      `${base}/rest/v1/rpc/bruce_read`
    ];

    let r = null;
    let lastText = null;
    for (const candidate of candidates) {
      r = await fetch(candidate, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`
        },
        body: JSON.stringify({ q, params })
      });
      lastText = await r.text();
      if (r.ok) { lastText = lastText; break; }
      // si 404, on essaie l'autre candidate
      if (r.status !== 404) break;
    }

    const text = lastText || "";
    if (!r.ok) return res.status(r.status).send(text);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});
// --- /READ-ONLY unified endpoint ---

  // --- RAG HARDENED PACK A (VB15) ---
const BRUCE_RAG_MAX_Q_CHARS = bruceClampInt(process.env.BRUCE_RAG_MAX_Q_CHARS, 4000, 256, 20000);
const BRUCE_RAG_EMBED_TIMEOUT_MS = bruceClampInt(process.env.BRUCE_RAG_EMBED_TIMEOUT_MS, 8000, 1000, 60000);
const BRUCE_RAG_SUPABASE_TIMEOUT_MS = bruceClampInt(process.env.BRUCE_RAG_SUPABASE_TIMEOUT_MS, 8000, 1000, 60000);
const BRUCE_RAG_RATE_WINDOW_MS = bruceClampInt(process.env.BRUCE_RAG_RATE_WINDOW_MS, 10000, 1000, 600000);
const BRUCE_RAG_RATE_MAX = bruceClampInt(process.env.BRUCE_RAG_RATE_MAX, 30, 1, 1000);

function bruceClientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown");
}

// ══════════════════════════════════════════════════════════════════════════════
// LLM PROFILE SYSTEM — Injection contextuelle intelligente par profil
// Tâche [92] — Session Opus, 2026-02-21
// 3 couches: COMMON (principes) + PROFIL (capacités/angles morts) + SESSION/RAG
// ══════════════════════════════════════════════════════════════════════════════

const BRUCE_OPERATING_PRINCIPLES = `BRUCE OPERATING PRINCIPLES:
- Projet: homelab intelligent avec mémoire persistante (Supabase)
- Écriture: TOUJOURS via staging_queue → validate.py → canon. Jamais directe.
- Documentation: noter toute découverte/action immédiatement dans Supabase
- Stabilité: ne jamais modifier ce qui fonctionne sans raison explicite
- Consolidation: documenter avant de passer à la tâche suivante
- Source de vérité: Supabase canon tables (pas legacy_)`;

// Fallback hardcodé si Supabase indisponible
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
  vllm: {
    profile_name: 'vllm',
    display_name: 'vLLM Qwen 7B (Open WebUI)',
    blind_spots: ['Raisonnement stratégique limité', 'Hallucine sans sources RAG'],
    tools_available: [],
    rules: ['Base ta réponse sur les sources RAG', 'Ne propose pas d\'actions techniques', 'Indique si Claude devrait traiter'],
    context_format: 'concise_factual',
    max_context_tokens: 800
  }
};

// Cache profils (évite de requêter Supabase à chaque appel)
let _profileCache = { data: null, ts: 0 };
const PROFILE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ── Détection automatique du LLM appelant ────────────────────────────────────
function detectLLMIdentity(req) {
  // 1. Header explicite (priorité absolue)
  const explicit = (req.headers['x-llm-identity'] || '').trim().toLowerCase();
  if (explicit && (LLM_PROFILES_FALLBACK[explicit] || explicit === 'claude' || explicit === 'chatgpt' || explicit === 'vllm')) {
    return explicit;
  }

  // 2. Détection par IP source
  const ip = bruceClientIp(req);

  // .190 = Windows (PowerShell Claude)
  if (ip.includes('192.168.2.190')) return 'claude';

  // 172.18.0.1 = host Docker .230 (SSH Yann avec commandes ChatGPT)
  if (ip === '172.18.0.1' || ip === '::ffff:172.18.0.1') return 'chatgpt';

  // .32 = box GPU (Open WebUI + vLLM)
  if (ip.includes('192.168.2.32')) return 'vllm';

  // 3. Détection par User-Agent
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('powershell')) return 'claude';

  // 4. Défaut: claude (le plus fréquent)
  return 'claude';
}

// ── Chargement du profil depuis Supabase (avec cache + fallback) ─────────────
async function loadLLMProfile(identity) {
  const now = Date.now();

  // Cache valide?
  if (_profileCache.data && (now - _profileCache.ts) < PROFILE_CACHE_TTL) {
    const cached = _profileCache.data[identity];
    if (cached) return cached;
  }

  // Charger depuis Supabase
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
      for (const p of profiles) {
        map[p.profile_name] = p;
      }
      _profileCache = { data: map, ts: now };
      if (map[identity]) return map[identity];
    }
  } catch (e) {
    // Supabase indisponible — fallback
  }

  // Fallback hardcodé
  return LLM_PROFILES_FALLBACK[identity] || LLM_PROFILES_FALLBACK['claude'];
}

// ── Construction du contexte adapté au profil ────────────────────────────────
function buildContextForProfile(profile, dashboard, tasks, lessons, ragResults, currentState) {
  const parts = [];
  const format = profile.context_format || 'markdown_structured';
  const isClaude = profile.profile_name === 'claude'; // [830] Skip redundant blocks for Claude

  // ── [123] CURRENT_STATE structuré - injecté EN PREMIER pour Claude ──
  if (format === 'markdown_structured' && Array.isArray(currentState)) {
    const csEntry = currentState.find(s => s.key === 'CURRENT_STATE');
    if (csEntry && csEntry.value) {
      try {
        const cs = typeof csEntry.value === 'string' ? JSON.parse(csEntry.value) : csEntry.value;
        const csLines = ['**🔄 ÉTAT COURANT DU PROJET:**'];
        if (cs.session_en_cours) csLines.push('- Session: ' + cs.session_en_cours);
        if (cs.phase) csLines.push('- Phase: ' + cs.phase);
        if (Array.isArray(cs.fait) && cs.fait.length > 0)
          csLines.push('- ✅ Fait: ' + cs.fait.join(', '));
        if (Array.isArray(cs.next_sonnet) && cs.next_sonnet.length > 0)
          csLines.push('- 📋 Next Sonnet: ' + cs.next_sonnet.slice(0,3).join(', '));
        if (Array.isArray(cs.next_opus) && cs.next_opus.length > 0)
          csLines.push('- 🔬 Next Opus: ' + cs.next_opus.slice(0,2).join(', '));
        if (Array.isArray(cs.blockers) && cs.blockers.length > 0)
          csLines.push('- ⚠️ Blockers: ' + cs.blockers.join(', '));
        parts.push(csLines.join('\n'));
      } catch(e) {
        // Si JSON invalide, afficher brut
        parts.push('**🔄 ÉTAT COURANT:** ' + String(csEntry.value).slice(0, 300));
      }
    }
  }
  // ── [127] SERVICES_CONFIG - résumé services pour Claude ──
  if (format === 'markdown_structured' && !isClaude && Array.isArray(currentState)) { // [830]
    const scEntry = currentState.find(s => s.key === 'SERVICES_CONFIG');
    if (scEntry && scEntry.value) {
      try {
        const sc = typeof scEntry.value === 'string' ? JSON.parse(scEntry.value) : scEntry.value;
        if (Array.isArray(sc.services)) {
          const svcLine = sc.services.map(s => s.name + '(' + (s.url || '').replace('http://','').split('/')[0] + ')').join(' | ');
          parts.push('**🔧 SERVICES:** ' + svcLine);
        }
      } catch(e) { /* optionnel */ }
    }
  }

  // ── Couche 1: COMMON (toujours) ──
  if (!isClaude) parts.push(BRUCE_OPERATING_PRINCIPLES); // [830]

  // ── Couche 2: PROFIL ──
  const blindSpots = Array.isArray(profile.blind_spots) ? profile.blind_spots : [];
  const tools = Array.isArray(profile.tools_available) ? profile.tools_available : [];
  const rules = Array.isArray(profile.rules) ? profile.rules : [];

  if (blindSpots.length > 0 && !isClaude) { // [830]
    parts.push('⚠️ RAPPELS SPÉCIFIQUES (' + profile.display_name + '):\n' + blindSpots.map(b => '- ' + b).join('\n'));
  }
  if (tools.length > 0 && !isClaude) { // [830]
    parts.push('🔧 OUTILS DISPONIBLES: ' + tools.join(', '));
  }
  if (rules.length > 0 && !isClaude) { // [830]
    parts.push('📋 RÈGLES:\n' + rules.map(r => '- ' + r).join('\n'));
  }

  // ── Couche 3: SESSION (adapté au budget tokens) ──
  const maxTokens = profile.max_context_tokens || 2000;

  // Dashboard (compact)
  if (dashboard) {
    if (format === 'concise_factual') {
      parts.push('ÉTAT: lessons=' + (dashboard.lessons_total||0) + ' kb=' + (dashboard.kb_total||0) + ' roadmap_done=' + (dashboard.roadmap_done||0) + ' staging=' + (dashboard.staging_pending||0));
    } else {
      parts.push('**Dashboard:** lessons=' + (dashboard.lessons_total||0) + ' | kb=' + (dashboard.kb_total||0) + ' | roadmap_done=' + (dashboard.roadmap_done||0) + ' | staging_pending=' + (dashboard.staging_pending||0));
    }
  }

  // Tâches (filtrées selon profil)
  if (Array.isArray(tasks) && tasks.length > 0) {
    let filteredTasks = tasks;
    const maxTasks = (format === 'concise_factual') ? 2 : 5;

    if (format === 'concise_factual') {
      // vLLM: juste les 2 prochaines, sans détails
      const taskLines = filteredTasks.slice(0, maxTasks).map(t => '[' + t.id + '] ' + t.step_name + ' (P' + t.priority + ')');
      parts.push('PROCHAINES TÂCHES: ' + taskLines.join(' | '));
    } else if (format === 'narrative_concise') {
      // ChatGPT: format narratif
      const taskLines = filteredTasks.slice(0, 3).map(t => '- [' + t.id + '] ' + t.step_name + ' (priorité ' + t.priority + ')' + (t.model_hint ? ' [' + t.model_hint + ']' : ''));
      parts.push('Prochaines tâches:\n' + taskLines.join('\n'));
    } else {
      // Claude: format markdown complet avec model_hint
      const taskLines = filteredTasks.slice(0, maxTasks).map(t => '- [' + t.id + '] ' + (t.model_hint === 'opus' ? '[OPUS] ' : '') + t.step_name + ' (P' + t.priority + ')');
      parts.push('**Prochaines tâches:**\n' + taskLines.join('\n'));
    }
  }

  // Leçons critiques (budget adapté)
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

  // Règles Yann (seulement pour Claude et ChatGPT)
  if (format !== 'concise_factual' && Array.isArray(currentState)) {
    const regles = currentState
      .filter(s => s.key && s.key.startsWith('REGLE_YANN_'))
      .slice(0, isClaude ? 0 : (format === 'narrative_concise') ? 2 : 4) // [830]
      .map(s => '- ' + s.value.replace(/RÈGLE CANON YANN: /, '').replace(/REGLE CANON YANN: /, '').slice(0, 100));
    if (regles.length > 0) {
      parts.push((format === 'markdown_structured' ? '**Règles Yann (canon):**' : 'Règles Yann:') + '\n' + regles.join('\n'));
    }
  }

  // Outils endpoint — [830] skip for Claude (already in claude.md)
  if (format === 'markdown_structured' && !isClaude) {
    parts.push('**Outils disponibles:** /bruce/ask {question} | /bruce/integrity | /bruce/state | /bruce/rag/context | GET /bruce/roadmap/list (tableau roadmap ordonné P+LLM+tâche)');

    // [675] Checklist documentation apres chaque action - injectee pour Claude (session 152 Sonnet)
    parts.push('**CHECKLIST DOCUMENTATION (apres chaque action/installation):**\n' +
      '- [ ] Ce qui a echoue: commande exacte + message erreur exact + cause\n' +
      '- [ ] Ce qui a fonctionne: commande exacte complete, reproductible copier-coller\n' +
      '- [ ] Ce qui va se repeter: documenter comme runbook generique (pas specifique a une machine)\n' +
      '- [ ] Correction idee recue: si hypothese fausse, la corriger explicitement en KB\n' +
      'Principe: ne pas attendre que Yann pointe un oubli. Apres chaque etape: la prochaine session pourrait-elle echouer faute de doc?');

    // [423] Checklist cloture session - injectee pour Claude (session 73 Opus)
    parts.push('**CHECKLIST CLOTURE SESSION (obligatoire avant de terminer):**\n' +
      '- [ ] Decisions explicites de Yann (regles, preferences, arbitrages)\n' +
      '- [ ] Corrections de comportement demandees par Yann\n' +
      '- [ ] Decouvertes techniques (bugs, fixes, configurations)\n' +
      '- [ ] Nouveaux patterns ou anti-patterns identifies\n' +
      '- [ ] Etat des taches modifie (done, bloque, redefini)\n' +
      '- [ ] Informations infrastructure nouvelles (IPs, ports, configs)\n' +
      '- [ ] Tout ne-fais-plus-ca ou fais-toujours-ca\n' +
      'Chaque categorie doit etre verifiee et extraite via staging_queue AVANT de cloturer.\n' +
      '\n**CHOIX FIN DE SESSION (obligatoire):** Presenter a Yann: A) Continuer cette session  B) Nouvelle session Sonnet  C) Nouvelle session Opus — avec recommandation justifiee selon taches restantes et leur model_hint.');
  }

  return parts.join('\n\n');
}


async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...(options || {}), signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

const BRUCE_RAG_METRICS = {
  started_at: new Date().toISOString(),
  rate_limited: 0,
  search: { calls: 0, ok: 0, err: 0, last_ms: null, avg_ms: null, total_ms: 0, last_error: null },
  context:{ calls: 0, ok: 0, err: 0, last_ms: null, avg_ms: null, total_ms: 0, last_error: null }
};

function bruceRagMetricOk(name, ms) {
  const m = BRUCE_RAG_METRICS[name];
  if (!m) return;
  m.ok += 1;
  m.last_ms = ms;
  m.total_ms += ms;
  m.avg_ms = Math.round(m.total_ms / Math.max(1, m.ok));
  m.last_error = null;
}

function bruceRagMetricErr(name, ms, err) {
  const m = BRUCE_RAG_METRICS[name];
  if (!m) return;
  m.err += 1;
  m.last_ms = ms;
  m.last_error = String(err || "").slice(0, 400);
}

const __ragRate = (() => {
  const m = new Map();
  return {
    check(key) {
      const now = Date.now();
      const rec = m.get(key);
      if (!rec || now >= rec.reset_at) {
        const r = { count: 1, reset_at: now + BRUCE_RAG_RATE_WINDOW_MS };
        m.set(key, r);
        return { ok: true, retry_after_ms: 0 };
      }
      rec.count += 1;
      if (rec.count > BRUCE_RAG_RATE_MAX) {
        return { ok: false, retry_after_ms: Math.max(1, rec.reset_at - now) };
      }
      return { ok: true, retry_after_ms: 0 };
    }
  };
})();

function bruceRagRateLimitOr429(req, res) {
  const ip = bruceClientIp(req);
  const r = __ragRate.check(ip);
  if (!r.ok) {
    BRUCE_RAG_METRICS.rate_limited += 1;
    res.setHeader("Retry-After", String(Math.ceil(r.retry_after_ms / 1000)));
    res.status(429).json({ ok: false, error: "Rate limited", retry_after_ms: r.retry_after_ms });
    return false;
  }
  return true;
}

// GET /bruce/rag/metrics (auth protected)
app.get("/bruce/rag/metrics", (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });
  return res.json({ ok: true, metrics: BRUCE_RAG_METRICS });
});

// POST /bruce/rag/search
// Body: { q: string, k?: number }
app.post("/bruce/rag/search", async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });
  if (!bruceRagRateLimitOr429(req, res)) return;

  const t0 = Date.now();
  BRUCE_RAG_METRICS.search.calls += 1;

  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const q = String(body.q || body.query || "").trim();
    const k = Number.isFinite(Number(body.k)) ? Math.max(1, Math.min(50, Number(body.k))) : 10;

    if (!q) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "Missing q");
      return res.status(400).json({ ok: false, error: "Missing q" });
    }
    if (q.length > BRUCE_RAG_MAX_Q_CHARS) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "q too large");
      return res.status(413).json({ ok: false, error: "Query too large", max_chars: BRUCE_RAG_MAX_Q_CHARS });
    }

    const baseEmbed = String(EMBEDDER_URL || "").replace(/\/+$/, "");
    if (!baseEmbed) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "EMBEDDER_URL missing");
      return res.status(500).json({ ok: false, error: "Embedder not configured (EMBEDDER_URL missing)" });
    }

    let er;
    try {
      er = await fetchWithTimeout(baseEmbed + "/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: q, max_length: 256 }),
      }, BRUCE_RAG_EMBED_TIMEOUT_MS);
    } catch (e) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "embedder timeout/error: " + String(e && e.message ? e.message : e));
      return res.status(504).json({ ok: false, error: "Embedder timeout/error" });
    }

    const et = await er.text();
    if (!er.ok) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "embedder http " + String(er.status));
      return res.status(502).json({ ok: false, error: "Embedder error", status: er.status, detail: et.slice(0, 800) });
    }

    let ej;
    try { ej = JSON.parse(et); } catch (_) { ej = null; }
    if (!Array.isArray(ej) || !Array.isArray(ej[0])) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "embedder format");
      return res.status(502).json({ ok: false, error: "Embedder returned unexpected format", detail: et.slice(0, 800) });
    }

    const vec = ej[0].map((x) => Number(x));
    if (!vec.length) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "empty embedding");
      return res.status(502).json({ ok: false, error: "Empty embedding vector" });
    }

    const qvec = "[" + vec.join(",") + "]";

    const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
    const key  = String(SUPABASE_KEY || "");
    if (!base) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "SUPABASE_URL missing");
      return res.status(500).json({ ok: false, error: "Supabase not configured (SUPABASE_URL missing)" });
    }
    if (!key) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "SUPABASE_KEY missing");
      return res.status(500).json({ ok: false, error: "Supabase not configured (SUPABASE_KEY missing)" });
    }

    const candidates = [
      base + "/rpc/bruce_rag_hybrid_search_text",
      base.replace(/\/rest\/v1$/, "") + "/rest/v1/rpc/bruce_rag_hybrid_search_text",
    ];

    let r = null;
    let lastText = null;
    for (const candidate of candidates) {
      try {
        r = await fetchWithTimeout(candidate, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": key,
            "Authorization": "Bearer " + key,
          },
          body: JSON.stringify({ qtext: q, qvec, k }),
        }, BRUCE_RAG_SUPABASE_TIMEOUT_MS);
      } catch (e) {
        r = null
        lastText = null
        break
      }

      lastText = await r.text();
      if (r.ok) break;
      if (r.status !== 404) break;
    }

    if (!r || !r.ok) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("search", ms, "supabase rpc error");
      return res.status(r ? r.status : 504).send(lastText || "");
    }

    const ms = Date.now() - t0;
    bruceRagMetricOk("search", ms);

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.send(lastText || "[]");
  } catch (e) {
    const ms = Date.now() - t0;
    bruceRagMetricErr("search", ms, String(e && e.message ? e.message : e));
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// [744] POST /bruce/tool-check — find relevant BRUCE tools for an action
app.post("/bruce/tool-check", async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });

  try {
    const body = (req.body && typeof req.body === "object") ? req.body : {};
    const action = String(body.action || "").trim();
    const topK = Math.max(1, Math.min(10, Number(body.top_k) || 3));

    if (!action) return res.status(400).json({ ok: false, error: "Missing action" });
    if (action.length > 500) return res.status(413).json({ ok: false, error: "Action too long (max 500 chars)" });

    // Embed the action query
    const baseEmbed = String(EMBEDDER_URL || "").replace(/\/+$/, "");
    if (!baseEmbed) return res.status(500).json({ ok: false, error: "Embedder not configured" });

    const er = await fetchWithTimeout(baseEmbed + "/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: "bruce_tools " + action, max_length: 256 }),
    }, 5000);

    if (!er.ok) return res.status(502).json({ ok: false, error: "Embedder error" });
    const et = await er.text();
    let ej; try { ej = JSON.parse(et); } catch(_) { ej = null; }
    if (!Array.isArray(ej) || !Array.isArray(ej[0])) return res.status(502).json({ ok: false, error: "Embedder format error" });

    const vec = ej[0].map(x => Number(x));
    const qvec = "[" + vec.join(",") + "]";

    // [744] Use dedicated bruce_tool_search RPC (vector search filtered to [TOOL] chunks)
    const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
    const key  = String(SUPABASE_KEY || "");
    if (!base || !key) return res.status(500).json({ ok: false, error: "Supabase not configured" });

    const rpcUrl = base.replace(/\/rest\/v1$/, "") + "/rest/v1/rpc/bruce_tool_search";
    const sr = await fetchWithTimeout(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": key, "Authorization": "Bearer " + key },
      body: JSON.stringify({ qvec: "[" + vec.join(",") + "]", k: topK }),
    }, 8000);

    if (!sr.ok) {
      const errText = await sr.text();
      return res.status(sr.status).json({ ok: false, error: "Search error", detail: errText.slice(0, 500) });
    }

    const results = JSON.parse(await sr.text());

    // Parse tool results
    const tools = [];
    for (const r of results) {
      const txt = r.tool_text || "";
      const lines = txt.split("\n");
      const nameLine = r.tool_name || lines[0].replace("[TOOL] ", "").trim();
      const description = lines.slice(2).join(" ").trim().substring(0, 200);
      const score = r.similarity || 0;

      tools.push({
        name: nameLine,
        score: Math.round(score * 1000) / 1000,
        how: description || nameLine,
      });
    }

    return res.json({
      ok: true,
      action,
      tools_found: tools,
      count: tools.length,
      threshold_hint: 0.6,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});

// POST /bruce/rag/context
app.post("/bruce/rag/context", async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });
  if (!bruceRagRateLimitOr429(req, res)) return;

  const t0 = Date.now();
  BRUCE_RAG_METRICS.context.calls += 1;

  try {
    const body = req.body || {};
    const q = String(body.q || body.query || "").trim();
    const kRaw = parseInt(String((body.k === undefined || body.k === null) ? "10" : body.k), 10);
    const k = Math.max(1, Math.min(50, Number.isFinite(kRaw) ? kRaw : 10));

    if (!q) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "Missing q");
      return res.status(400).json({ ok: false, error: "Missing q" });
    }
    if (q.length > BRUCE_RAG_MAX_Q_CHARS) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "q too large");
      return res.status(413).json({ ok: false, error: "Query too large", max_chars: BRUCE_RAG_MAX_Q_CHARS });
    }

    const embedUrl = String(EMBEDDER_URL || "").replace(/\/+$/, "") + "/embed";

    let er;
    try {
      er = await fetchWithTimeout(embedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: q, max_length: 256 })
      }, BRUCE_RAG_EMBED_TIMEOUT_MS);
    } catch (e) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "embedder timeout/error: " + String(e && e.message ? e.message : e));
      return res.status(504).json({ ok: false, error: "Embedder timeout/error" });
    }

    const etxt = await er.text();
    if (!er.ok) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "embedder http " + String(er.status));
      return res.status(502).json({ ok: false, error: "Embedder error", status: er.status, body: etxt.slice(0, 2000) });
    }

    const ej = JSON.parse(etxt);
    const vec = Array.isArray(ej) ? ej[0] : (ej && ej.embeddings && ej.embeddings[0]);
    if (!Array.isArray(vec)) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "embedder format");
      return res.status(502).json({ ok: false, error: "Embedder returned unexpected format" });
    }

    const qvec = "[" + vec.map((x) => Number(x)).join(",") + "]";

    const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
    const key  = String(SUPABASE_KEY || "");
    if (!base) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "SUPABASE_URL missing");
      return res.status(500).json({ ok: false, error: "Supabase not configured (SUPABASE_URL missing)" });
    }
    if (!key) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "SUPABASE_KEY missing");
      return res.status(500).json({ ok: false, error: "Supabase not configured (SUPABASE_KEY missing)" });
    }

    const candidates = [
      base + "/rpc/bruce_rag_hybrid_search_text",
      base.replace(/\/rest\/v1$/, "") + "/rest/v1/rpc/bruce_rag_hybrid_search_text"
    ];

    let rr = null;
    let rtxt = null;
    for (const u of candidates) {
      try {
        rr = await fetchWithTimeout(u, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": key,
            "Authorization": "Bearer " + key
          },
          body: JSON.stringify({ qtext: q, qvec: qvec, k: k })
        }, BRUCE_RAG_SUPABASE_TIMEOUT_MS);
      } catch (e) {
        rr = null
        rtxt = null
        break
      }

      rtxt = await rr.text();
      if (rr.ok) break;
      if (rr.status !== 404) break;
    }

    if (!rr || !rr.ok) {
      const ms = Date.now() - t0;
      bruceRagMetricErr("context", ms, "supabase rpc error");
      return res.status(rr ? rr.status : 504).send(rtxt || "");
    }

    const results = JSON.parse(rtxt || "[]");
    const context = (Array.isArray(results) ? results : []).map((r, i) => {
      const head = "SOURCE " + (i + 1) + " | doc_id=" + r.doc_id + " chunk_id=" + r.chunk_id + " chunk_index=" + r.chunk_index;
      return head + "\n" + String(r.preview || "").trim() + "\n";
    }).join("\n");

    const ms = Date.now() - t0;
    bruceRagMetricOk("context", ms);

    return res.json({ ok: true, q: q, k: k, results: results, context: context });
  } catch (e) {
    const ms = Date.now() - t0;
    bruceRagMetricErr("context", ms, String(e && e.message ? e.message : e));
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
});
// --- /RAG HARDENED PACK A (VB15) ---

app.get('/health', async (req, res) => {
  const result = {
    status: 'ok',
    supabase: {
      configured: Boolean(SUPABASE_URL && SUPABASE_KEY),
      url: SUPABASE_URL || null,
      status: 'unknown',
      error: null,
    },
    manual: {
      root: MANUAL_ROOT,
      accessible: false,
      error: null,
    },
    timestamp: new Date().toISOString(),
  };

  // Supabase quick ping
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const ping = await pingUrl(SUPABASE_URL);
      result.supabase.status = ping.status;
      if (ping.error) {
        result.supabase.error = ping.error;
      }
    } catch (err) {
      result.supabase.status = 'offline';
      result.supabase.error = err.message || String(err);
    }
  } else {
    result.supabase.status = 'not_configured';
  }

  // Manual root check
  try {
    const stats = fs.statSync(MANUAL_ROOT);
    result.manual.accessible = stats.isDirectory();
  } catch (err) {
    result.manual.accessible = false;
    result.manual.error = err.message || String(err);
  }

  res.json(result);
});


// ========== BRUCE (LEGACY HTTP API) ==========

app.get('/bruce/health', (req, res) => {
  return res.redirect(307, '/health');
});

// GET /bruce/state — contexte canonique pour démarrage de session LLM
app.get('/bruce/state', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const headers = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  try {
    const [stateRes, lessonsRes, roadmapRes, dashRes, decisionsRes, kgRes] = await Promise.all([
      fetchWithTimeout(base + '/current_state?order=key.asc', { headers }, 8000),
      fetchWithTimeout(base + '/lessons_learned?importance=eq.critical&order=id.desc&limit=10', { headers }, 8000),
      fetchWithTimeout(base + '/roadmap?status=in.(todo,doing)&order=priority.asc,id.asc&select=id,step_name,priority,status,category', { headers }, 8000),
      fetchWithTimeout(base + '/v_bruce_dashboard?limit=1', { headers }, 8000),
      fetchWithTimeout(base + '/v_decisions?limit=10', { headers }, 8000),
      Promise.resolve({ ok: true, json: async () => [] }),  // [840] knowledge_graph disabled (0 rows)
    ]);

    const [state, lessons, roadmap, dashArr, decisions, kg] = await Promise.all([
      stateRes.json(),
      lessonsRes.json(),
      roadmapRes.json(),
      dashRes.json(),
      decisionsRes.json(),
      kgRes.json(),
    ]);

    const dashboard = Array.isArray(dashArr) && dashArr.length > 0 ? dashArr[0] : {};

    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      dashboard: dashboard,
      current_state: state,
      critical_lessons: lessons,
      top_decisions: decisions,
      roadmap_todo: roadmap,
      knowledge_graph: kg,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/bruce/issues/open', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const sql = "select * from public.bruce_open_issues order by computed_at desc, severity, domain, type, scope1, scope2, scope3";

    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key  = String(SUPABASE_KEY || '');

    if (!base) return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_URL missing)' });
    if (!key)  return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_KEY missing)' });

    const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
    const rpcUrl = useRestV1
      ? `${base.replace(/\/rest\/v1$/, '')}/rest/v1/rpc/exec_sql`
      : `${base}/rpc/exec_sql`;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'apikey': key,
    };

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: sql }),
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(200).json({ ok: false, status: response.status, error: text || `HTTP ${response.status}` });
    }

    const parsed = text ? JSON.parse(text) : null;
    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) ? parsed.data : parsed;

    return res.status(200).json({ ok: true, status: response.status, data });
  } catch (err) {
    return res.status(200).json({ ok: false, status: 500, error: err && err.message ? err.message : String(err) });
  }
});

// --- NEW: BRUCE INTROSPECTION (VB1) ---

app.get('/bruce/introspect/last-seen', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const limit = bruceClampInt(req.query.limit, 50, 1, 500);

    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key  = String(SUPABASE_KEY || '');

    if (!base) return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_URL missing)' });
    if (!key)  return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_KEY missing)' });

    const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
    const viewUrl = useRestV1
      ? `${base.replace(/\/rest\/v1$/, '')}/rest/v1/bruce_last_seen`
      : `${base}/bruce_last_seen`;

    const qs = `select=source_id,hostname,last_ts,rows_total&order=last_ts.desc&limit=${limit}`;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${key}`,
      'apikey': key,
    };

    const response = await fetch(`${viewUrl}?${qs}`, { method: 'GET', headers });
    const text = await response.text();

    if (!response.ok) {
      return res.status(200).json({ ok: false, status: response.status, error: text || `HTTP ${response.status}` });
    }

    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (e) {
      return res.status(200).json({ ok: false, status: 500, error: 'JSON parse error', raw: text });
    }

    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) ? parsed.data : parsed;
    return res.status(200).json({ ok: true, status: response.status, data });
  } catch (err) {
    return res.status(200).json({ ok: false, status: 500, error: err && err.message ? err.message : String(err) });
  }
});

app.get('/bruce/introspect/docker/summary', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const limit = bruceClampInt(req.query.limit, 50, 1, 500);

    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key  = String(SUPABASE_KEY || '');

    if (!base) return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_URL missing)' });
    if (!key)  return res.status(500).json({ ok: false, error: 'Supabase not configured (SUPABASE_KEY missing)' });

    const useRestV1 = /:8000\b/.test(base) || /\/rest\/v1\b/.test(base);
    const viewUrl = useRestV1
      ? `${base.replace(/\/rest\/v1$/, '')}/rest/v1/docker_summary`
      : `${base}/docker_summary`;

    const qs = `select=hostname,ts,containers_total,containers_running,containers_exited,containers_paused&order=ts.desc&limit=${limit}`;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${key}`,
      'apikey': key,
    };

    const response = await fetch(`${viewUrl}?${qs}`, { method: 'GET', headers });
    const text = await response.text();

    if (!response.ok) {
      return res.status(200).json({ ok: false, status: response.status, error: text || `HTTP ${response.status}` });
    }

    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch (e) {
      return res.status(200).json({ ok: false, status: 500, error: 'JSON parse error', raw: text });
    }

    const data = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) ? parsed.data : parsed;
    return res.status(200).json({ ok: true, status: response.status, data });
  } catch (err) {
    return res.status(200).json({ ok: false, status: 500, error: err && err.message ? err.message : String(err) });
  }
});

// ========== BRUCE: CHAT ENDPOINT ==========


  // =========================================================
  // OpenAI-compatible shim (for OpenWebUI) - Combo 1
  // Base URL expected: http://<gateway>:4000/api/openai/v1
  // Endpoints:
  //   GET  /api/openai/v1/models
  //   POST /api/openai/v1/chat/completions
  // Also exposed as /v1/* for convenience.
  // =========================================================

  function openaiUnixNow() {
    return Math.floor(Date.now() / 1000);
  }

  function openaiMakeId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  function openaiSendAuthError(res, auth) {
    return res.status(auth.status || 401).json({
      error: {
        message: auth.error || 'Unauthorized',
        type: 'invalid_request_error',
      },
    });
  }

  async function openaiModelsHandler(req, res) {
    const auth = validateBruceAuth(req);
    if (!auth.ok) return openaiSendAuthError(res, auth);

    if (!BRUCE_LLM_MODEL) {
      return res.status(500).json({
        error: { message: 'BRUCE_LLM_MODEL is not configured', type: 'server_error' },
      });
    }

    return res.json({
      object: 'list',
      data: [
        { id: BRUCE_LLM_MODEL, object: 'model', created: 0, owned_by: 'bruce' },
      ],
    });
  }

  async function openaiChatCompletionsHandler(req, res) {
    const auth = validateBruceAuth(req);
    if (!auth.ok) return openaiSendAuthError(res, auth);

    const body = req && req.body ? req.body : {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const stream = Boolean(body.stream);

    if (!messages.length) {
      return res.status(400).json({
        error: { message: 'Missing or empty messages[]', type: 'invalid_request_error' },
      });
    }

    const normalized = messages
      .map((m) => ({
        role: String((m && m.role) || '').trim(),
        content: String((m && m.content) || ''),
      }))
      .filter((m) => m.role && typeof m.content === 'string');

    if (!normalized.length) {
      return res.status(400).json({
        error: { message: 'Invalid messages[] entries (need role + content)', type: 'invalid_request_error' },
      });
    }

    const model = BRUCE_LLM_MODEL;

    try {
      const msg = await callLlm(normalized);
      const id = openaiMakeId('chatcmpl');
      const created = openaiUnixNow();

      if (stream) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');

        const chunk1 = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        };

        const chunk2 = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }],
        };

        const chunk3 = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };

        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      return res.json({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: msg.content },
            finish_reason: 'stop',
          },
        ],
      });
    } catch (err) {
      const emsg = err && err.message ? String(err.message) : 'LLM call failed';
      return res.status(502).json({
        error: { message: emsg.slice(0, 800), type: 'server_error' },
      });
    }
  }

  app.get('/api/openai/v1/models', openaiModelsHandler);
  app.get('/v1/models', openaiModelsHandler);

  app.post('/api/openai/v1/chat/completions', openaiChatCompletionsHandler);
  app.post('/v1/chat/completions', openaiChatCompletionsHandler);

// ========== BRUCE: LLM GENERATE (Combo 2) ==========
// Goal: one stable endpoint for n8n/clients. Uses the same auth + callLlm().
// Request: { messages:[{role,content},...]} OR { prompt:"..." }
// Response: { ok:true, model, message:{role,content}, timestamp }


// --- RAG helper (LLM VB3) ---
async function bruceRagContext(qtext, k) {
  const q = String(qtext || "").trim();
  const kRaw = parseInt(String(k ?? "8"), 10);
  const kk = Math.max(1, Math.min(20, Number.isFinite(kRaw) ? kRaw : 8));

  const embedBase = String(EMBEDDER_URL || "").replace(/\/+$/, "");
  if (!embedBase) throw new Error("EMBEDDER_URL missing");

  const er = await fetch(embedBase + "/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs: q, max_length: 256 })
  });
  const etxt = await er.text();
  if (!er.ok) throw new Error("embedder http " + er.status + ": " + etxt.slice(0, 500));

  const ej = JSON.parse(etxt);
  const vec = Array.isArray(ej) ? ej[0] : (ej && ej.embeddings && ej.embeddings[0]);
  if (!Array.isArray(vec)) throw new Error("embedder format unexpected");

  const qvec = "[" + vec.map((x) => Number(x)).join(",") + "]";

  const base = String(SUPABASE_URL || "").replace(/\/+$/, "");
  const key  = String(SUPABASE_KEY || "");
  if (!base) throw new Error("SUPABASE_URL missing");
  if (!key)  throw new Error("SUPABASE_KEY missing");

  const candidates = [
    base + "/rpc/bruce_rag_hybrid_search_text",
    base.replace(/\/rest\/v1$/, "") + "/rest/v1/rpc/bruce_rag_hybrid_search_text"
  ];

  let rr = null;
  let rtxt = null;
  for (const u of candidates) {
    rr = await fetch(u, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": key,
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify({ qtext: q, qvec: qvec, k: kk })
    });
    rtxt = await rr.text();
    if (rr.ok) break;
    if (rr.status !== 404) break;
  }

  if (!rr || !rr.ok) {
    throw new Error("supabase rpc error " + (rr ? rr.status : "no_response") + ": " + String(rtxt || "").slice(0, 500));
  }

  const results = JSON.parse(rtxt || "[]");
  const arr = Array.isArray(results) ? results : [];

  const context = arr.map((r, i) => {
    const head = "SOURCE " + (i + 1) + " | doc_id=" + r.doc_id + " chunk_id=" + r.chunk_id + " chunk_index=" + r.chunk_index;
    return head + "\n" + String(r.preview || "").trim() + "\n";
  }).join("\n");

  const maxChars = 9000;
  const ctx = context.length > maxChars ? context.slice(0, maxChars) + "\n[TRUNCATED]\n" : context;

  return { q: q, k: kk, n: arr.length, qvec: qvec, results: arr, context: ctx };
}
// --- /RAG helper (LLM VB3) ---
app.post('/bruce/llm/generate', async (req, res) => {
  // RAG strict gate (rag===true only)
  // If caller didn't explicitly set rag:true, we skip retrieval + injection completely.
  if (!(req.body && req.body.rag === true)) {
    // ensure no accidental leftovers
    if (req.body) {
      req.body.rag = false;
      delete req.body.rag_k;
      delete req.body.rag_query;
    }
  }

  const auth = validateBruceAuth(req);
  if (!auth.ok) {
    return res.status(auth.status || 401).json({ ok: false, error: auth.error || 'Unauthorized' });
  }

  const body = req && req.body ? req.body : {};
  // --- RAG injection (LLM VB3) ---
  const ragEnabled = (body && (body.rag === true || body.use_rag === true));
  if (ragEnabled) {
    try {
      let q = String((body.rag_query || body.rag_q || body.q || "")).trim();
      if (!q) {
        if (typeof body.prompt === "string") q = body.prompt;
        else if (Array.isArray(body.messages)) {
          for (let i = body.messages.length - 1; i >= 0; i--) {
            const m = body.messages[i];
            if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) { q = m.content; break; }
          }
        }
      }
      q = String(q || "").trim();
      const kRaw = parseInt(String(body.rag_k ?? body.k ?? "8"), 10);
      const k = Math.max(1, Math.min(20, Number.isFinite(kRaw) ? kRaw : 8));
      if (q) {
        const rag = await bruceRagContext(q, k);
        const ragBlock = "### CONTEXTE RAG (bge-m3)\n" + rag.context + "\n### FIN CONTEXTE RAG\n\n";
        if (typeof body.prompt === "string") body.prompt = ragBlock + body.prompt;
        if (Array.isArray(body.messages)) {
          const first = body.messages[0];
          const already = first && first.role === "system" && typeof first.content === "string" && first.content.includes("CONTEXTE RAG");
          if (!already) body.messages.unshift({ role: "system", content: ragBlock });
        }
        body.rag_used = { q: rag.q, k: rag.k, n: rag.n, results_count: Array.isArray(rag.results) ? rag.results.length : 0, sources: Array.isArray(rag.results) ? rag.results.map(r => ({ doc_id: r.doc_id, chunk_id: r.chunk_id, chunk_index: r.chunk_index, score: (r.hybrid_score ?? r.cos_sim ?? null) })) : [] };
        // Strip fake SOURCE mentions (avoid hallucinated citations)
        if (body && body.message && typeof body.message.content === "string") {
          // Strip fake SOURCE mentions v2 (avoid hallucinated citations)
          // Removes: "source 2", "SOURCE 2", "dans la source 2", etc.
          body.message.content = body.message.content
            .replace(/\bcomme\s+indiqu[ée]?(?:e)?\s+dans\s+la\s+source\s*#?\s*\d+\b/gi, "")
            .replace(/\bdans\s+la\s+source\s*#?\s*\d+\b/gi, "")
            .replace(/\bsource\s*#?\s*\d+\b/gi, "")
            .replace(/\s{2,}/g, " ")
            .trim();
        }

      }
    } catch (e) {
      body.rag_error = String(e && e.message ? e.message : e);
    }
  }
  // --- /RAG injection (LLM VB3) ---
  let messages = Array.isArray(body.messages) ? body.messages : null;

  if (!messages) {
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (prompt.trim()) {
      messages = [{ role: 'user', content: prompt }];
    }
  }

  if (!messages || !messages.length) {
    return res.status(400).json({ ok: false, error: 'Missing messages[] or prompt' });
  }

  const normalized = messages
    .map((m) => ({
      role: String((m && m.role) || '').trim(),
      content: String((m && m.content) || ''),
    }))
    .filter((m) => m.role && typeof m.content === 'string');

  if (!normalized.length) {
    return res.status(400).json({ ok: false, error: 'Invalid messages[] entries (need role + content)' });
  }

  try {
    const msg = await callLlm(normalized);
    return res.json({
      ok: true,
      rag_used: body && body.rag_used ? body.rag_used : null,
      rag_error: body && body.rag_error ? body.rag_error : null,

      model: BRUCE_LLM_MODEL || null,
      message: msg,
      timestamp: utcNowIso(),
    });
  } catch (err) {
    const emsg = err && err.message ? String(err.message) : 'LLM call failed';
    return res.status(502).json({ ok: false, error: emsg.slice(0, 800), timestamp: utcNowIso() });
  }
});

app.post('/chat', async (req, res) => {
  // Auth
  const authCheck = validateBruceAuth(req);
  if (!authCheck.ok) {
    return res.status(authCheck.status || 401).json({
      error: authCheck.error || 'Unauthorized',
    });
  }

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : null;

  if (!messages || !messages.length) {
    return res.status(400).json({
      error: 'Missing or empty "messages" array',
    });
  }

  // Validate messages structure
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      return res.status(400).json({
        error: 'Each message must be an object with "role" and "content"',
      });
    }
    if (!msg.role || typeof msg.role !== 'string') {
      return res.status(400).json({
        error: 'Each message must have a "role" string',
      });
    }
    if (!msg.content || typeof msg.content !== 'string') {
      return res.status(400).json({
        error: 'Each message must have a "content" string',
      });
    }
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== 'user' && lastMessage.role !== 'system') {
    return res.status(400).json({
      error: "The last message must have role 'user' or 'system'",
    });
  }

  if (lastMessage.content.length > BRUCE_MAX_MESSAGE_CHARS) {
    return res.status(400).json({
      error: `Last message exceeds ${BRUCE_MAX_MESSAGE_CHARS} characters`,
    });
  }

  let conversationId =
    typeof body.conversation_id === 'string' && body.conversation_id.trim()
      ? body.conversation_id.trim()
      : randomUUID();

  const clientHost = req.ip || null;

  const incomingPayload = {
    direction: 'incoming',
    conversation_id: conversationId,
    messages,
    client_host: clientHost,
    received_at: utcNowIso(),
  };

  try {
    // Log incoming
    const eventIdIn = await insertMemoryEvent(
      BRUCE_SOURCE_DEFAULT,
      'conversation_message_in',
      incomingPayload
    );
    if (eventIdIn) {
      await insertConversationMessage(
        eventIdIn,
        conversationId,
        lastMessage.role,
        lastMessage.content
      );
    }

    // Call LLM
    const reply = await callLlm(messages);

    const outgoingPayload = {
      direction: 'outgoing',
      conversation_id: conversationId,
      message: reply,
      client_host: clientHost,
      sent_at: utcNowIso(),
    };

    const eventIdOut = await insertMemoryEvent(
      BRUCE_SOURCE_DEFAULT,
      'conversation_message_out',
      outgoingPayload
    );
    if (eventIdOut) {
      await insertConversationMessage(
        eventIdOut,
        conversationId,
        reply.role,
        reply.content
      );
    }

    return res.json({
      conversation_id: conversationId,
      reply,
    });
  } catch (err) {
    await logFallback({
      kind: 'bruce_chat_exception',
      timestamp: utcNowIso(),
      error: err.message || String(err),
    });

    return res.status(502).json({
      error: 'LLM backend unavailable or error',
      details: err.message || String(err),
    });
  }
});

// ============================================
// BRUCE AGENT ENDPOINT
// ============================================


// Charger system prompt
const SYSTEM_PROMPT_PATH = "/home/furycom/bruce-config/system_prompt.txt";
let SYSTEM_PROMPT = "";
try {
  SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8");
} catch (e) {
  // Ne pas throw ici pour ne pas tuer le serveur au boot; l'endpoint renverra une erreur claire.
  SYSTEM_PROMPT = "";
}

function clampStr(s, maxLen) {
  const x = String(s ?? "");
  if (x.length <= maxLen) return x;
  return x.slice(0, maxLen) + `\n...[truncated to ${maxLen} chars]`;
}

function parseLegacyToolCallFromContent(content) {
  const s = String(content || "");
  const m = s.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!m || !m[1]) return null;
  try {
    const obj = JSON.parse(m[1]);
    const name = obj && obj.name ? String(obj.name) : null;
    const args = obj && obj.arguments && typeof obj.arguments === "object" ? obj.arguments : {};
    return name ? { name, arguments: args } : null;
  } catch (_) {
    return null;
  }
}
// Extraire user/password depuis system_prompt.txt (évite de hardcoder un secret ici)
function extractSshCredsFromPrompt(promptText) {
  const out = { user: null, password: null };

  const userMatch = String(promptText).match(/^\s*-\s*User:\s*(.+)\s*$/mi);
  if (userMatch && userMatch[1]) out.user = userMatch[1].trim();

  const passMatch = String(promptText).match(/^\s*-\s*Password:\s*(.+)\s*$/mi);
  if (passMatch && passMatch[1]) out.password = passMatch[1].trim();

  return out;
}

const SSH_CREDS = extractSshCredsFromPrompt(SYSTEM_PROMPT);
const SSH_USER = SSH_CREDS.user || "furycom";

// Charger node-ssh depuis le volume /workspace (installé côté host)
let NodeSSH = null;
try {
  // chemin absolu pour éviter les problèmes de résolution de modules dans /app
  // (docker-compose monte /home/furycom/mcp-stack -> /workspace)
  ({ NodeSSH } = require("/workspace/mcp-gateway/node_modules/node-ssh"));
} catch (e1) {
  try {
    ({ NodeSSH } = require("node-ssh"));
  } catch (e2) {
    NodeSSH = null;
  }
}

async function sshExecViaNodeSsh(host, command, timeoutMs) {
  if (!NodeSSH) {
    throw new Error("node-ssh introuvable (vérifie l'installation npm dans /home/furycom/mcp-stack/mcp-gateway).");
  }
  if (!SSH_CREDS.password) {
    throw new Error("Mot de passe SSH introuvable dans system_prompt.txt (ligne '- Password: ...').");
  }

  const ssh = new NodeSSH();
  try {
    // BRUCE: prefer key auth; fallback to password
    const keyPath = "/home/furycom/bruce-config/bruce_gateway_ed25519";
    let privateKey = null;
    try { privateKey = fs.readFileSync(keyPath, "utf8"); } catch (_) {}

    if (privateKey) {
      try {
        await ssh.connect({
          host: String(host),
          username: SSH_USER,
          privateKey,
          readyTimeout: timeoutMs
        });
      } catch (e) {
        await ssh.connect({
          host: String(host),
          username: SSH_USER,
          password: SSH_CREDS.password,
          tryKeyboard: true,
          readyTimeout: timeoutMs
        });
      }
    } else {
      await ssh.connect({
        host: String(host),
        username: SSH_USER,
        password: SSH_CREDS.password,
        tryKeyboard: true,
        readyTimeout: timeoutMs
      });
    }
const r = await ssh.execCommand(String(command), { execOptions: { pty: false } });

    return {
      success: true,
      stdout: clampStr(r.stdout || "", 12000),
      stderr: clampStr(r.stderr || "", 12000),
      code: typeof r.code === "number" ? r.code : null,
      output: clampStr((r.stdout || r.stderr || "Command executed (no output)"), 12000)
    };
  } finally {
    try {
      ssh.dispose();
    } catch (_) {}
  }
}

// Définir les tools disponibles
const AVAILABLE_TOOLS = [
  {
    type: "function",
    function: {
      name: "ssh_exec",
      description: "Execute SSH command on homelab machine. Use this to run any bash command remotely.",
      parameters: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description: "IP address of the machine (e.g. 192.168.2.230, 192.168.2.32)"
          },
          command: {
            type: "string",
            description: "Bash command to execute (e.g. 'uptime', 'docker ps', 'ls -la')"
          }
        },
        required: ["host", "command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "docker_list",
      description: "List all Docker containers on a host with their status",
      parameters: {
        type: "object",
        properties: {
          host: {
            type: "string",
            description: "IP address (e.g. 192.168.2.230)"
          }
        },
        required: ["host"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_homelab_db",
      description: "Query the local SQLite homelab database. Only SELECT queries are allowed. Returns JSON rows.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "SQL SELECT query to run against homelab.db" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or modify a text file on homelab machine. Supports create, append, and overwrite modes with automatic backup.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "IP address of target machine" },
          filepath: { type: "string", description: "Absolute path to the file (e.g., /home/furycom/script.sh)" },
          content: { type: "string", description: "File content to write" },
          mode: {
            type: "string",
            enum: ["create", "append", "overwrite"],
            description: "Write mode: create (new file), append (add to end), overwrite (replace)"
          }
        },
        required: ["host", "filepath", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "batch_process",
      description: "Process data files in batch using Python. Useful for CSV/JSON transformation, data cleaning, analysis.",
      parameters: {
        type: "object",
        properties: {
          host: { type: "string", description: "IP address" },
          operation: {
            type: "string",
            enum: ["transform", "analyze", "export"],
            description: "Type of operation"
          },
          input_file: { type: "string", description: "Path to input file" },
          output_file: { type: "string", description: "Path to output file" },
          processing_script: {
            type: "string",
            description: "Python code to execute on the data (use 'df' variable for pandas dataframe)"
          }
        },
        required: ["host", "input_file", "output_file", "processing_script"]
      }
    }
  }
];

// Fonction pour exécuter un tool
async function executeTool(toolName, params) {
  const safeParams = params && typeof params === "object" ? params : {};
  const host = safeParams.host ? String(safeParams.host) : "";
  const timeoutMs = 30000;

  switch (toolName) {
    case "ssh_exec": {
      if (!host) return { success: false, error: "Missing params.host" };
      if (!safeParams.command) return { success: false, error: "Missing params.command" };
      try {
        return await sshExecViaNodeSsh(host, safeParams.command, timeoutMs);
      } catch (e) {
        return { success: false, error: String(e && e.message ? e.message : e) };
      }
    }

    case "docker_list": {
      if (!host) return { success: false, error: "Missing params.host" };
      try {
        return await sshExecViaNodeSsh(
          host,
          "docker ps -a --format '{{.Names}}|{{.Status}}|{{.Ports}}'",
          20000
        );
      } catch (e) {
        return { success: false, error: String(e && e.message ? e.message : e) };
      }
    }

    case "query_homelab_db": {
      if (!params || typeof params.query !== "string") {
        return { error: "Missing required parameter: query" };
      }
      const q = params.query.trim();
      if (!q.toUpperCase().startsWith("SELECT")) {
        return { error: "Only SELECT queries are allowed." };
      }

      const Database = require("better-sqlite3");
      const dbPath = "/home/furycom/homelab.db";
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const stmt = db.prepare(q);
        const rows = stmt.all();
        return { output: JSON.stringify(rows, null, 2) };
      } catch (err) {
        return { error: String(err && err.message ? err.message : err) };
      } finally {
        try { db.close(); } catch (_) {}
      }
    }


    case "write_file": {
      if (!host) return { success: false, error: "Missing params.host" };
      if (!safeParams.filepath) return { success: false, error: "Missing params.filepath" };
      if (!safeParams.content) return { success: false, error: "Missing params.content" };
      
      const filepath = String(safeParams.filepath);
      const content = String(safeParams.content);
      const mode = safeParams.mode || "create";
      
      const allowedDirs = ['/home/furycom/', '/tmp/', '/home/furycom/bruce-data/'];
      const isAllowed = allowedDirs.some(dir => filepath.startsWith(dir));
      
      if (!isAllowed) {
        return { success: false, error: "Directory not allowed. Allowed: " + allowedDirs.join(', ') };
      }
      
      if (filepath.includes('../')) {
        return { success: false, error: "Path traversal not allowed" };
      }
      
      const escapedContent = content.replace(/'/g, "'\\''");
      
      let writeCmd;
      if (mode === "append") {
        writeCmd = "echo '" + escapedContent + "' >> '" + filepath + "'";
      } else if (mode === "overwrite") {
        writeCmd = "cp '" + filepath + "' '" + filepath + ".backup.$(date +%Y%m%d_%H%M%S)' 2>/dev/null || true; echo '" + escapedContent + "' > '" + filepath + "'";
      } else {
        writeCmd = "echo '" + escapedContent + "' > '" + filepath + "'";
      }
      
      try {
        const result = await sshExecViaNodeSsh(host, writeCmd, timeoutMs);
        const verifyCmd = "test -f '" + filepath + "' && echo 'OK' || echo 'FAIL'";
        const verify = await sshExecViaNodeSsh(host, verifyCmd, 5000);
        
        if (verify.stdout && verify.stdout.includes('OK')) {
          return {
            success: true,
            filepath: filepath,
            mode: mode,
            message: "File " + (mode === 'append' ? 'appended' : 'written') + " successfully"
          };
        } else {
          return { success: false, error: "File write failed verification" };
        }
      } catch (error) {
        return { success: false, error: "Write failed: " + (error.message || String(error)) };
      }
    }

    case "batch_process": {
      if (!host) return { success: false, error: "Missing params.host" };
      if (!safeParams.input_file) return { success: false, error: "Missing params.input_file" };
      if (!safeParams.output_file) return { success: false, error: "Missing params.output_file" };
      if (!safeParams.processing_script) return { success: false, error: "Missing params.processing_script" };
      
      const inputFile = String(safeParams.input_file);
      const outputFile = String(safeParams.output_file);
      const userScript = String(safeParams.processing_script);
      
      const timestamp = Date.now();
      const tempScript = "/tmp/batch_process_" + timestamp + ".py";
      
      const pythonCode = "import pandas as pd\\nimport json\\nimport sys\\n\\ntry:\\n    if '" + inputFile + "'.endswith('.csv'):\\n        df = pd.read_csv('" + inputFile + "')\\n    elif '" + inputFile + "'.endswith('.json'):\\n        df = pd.read_json('" + inputFile + "')\\n    else:\\n        df = pd.read_csv('" + inputFile + "')\\n    \\n    print('Loaded ' + str(len(df)) + ' rows')\\n    \\n" + userScript.split("\\n").map(function(line) { return "    " + line; }).join("\\n") + "\\n    \\n    if '" + outputFile + "'.endswith('.json'):\\n        df.to_json('" + outputFile + "', orient='records', indent=2)\\n    else:\\n        df.to_csv('" + outputFile + "', index=False)\\n    \\n    print('Saved ' + str(len(df)) + ' rows to " + outputFile + "')\\n    print('SUCCESS')\\n    \\nexcept Exception as e:\\n    print('ERROR: ' + str(e), file=sys.stderr)\\n    sys.exit(1)\\n";

      try {
        const escapedCode = pythonCode.replace(/'/g, "'\\\\''");
        const writeCmd = "echo '" + escapedCode + "' > '" + tempScript + "'";
        await sshExecViaNodeSsh(host, writeCmd, 10000);
        
        const execCmd = "python3 '" + tempScript + "' 2>&1";
        const result = await sshExecViaNodeSsh(host, execCmd, 120000);
        
        await sshExecViaNodeSsh(host, "rm '" + tempScript + "'", 5000);
        
        const output = result.stdout || result.output || "";
        
        if (output.includes("SUCCESS")) {
          const loadedMatch = output.match(/Loaded (\\d+) rows/);
          const savedMatch = output.match(/Saved (\\d+) rows/);
          
          return {
            success: true,
            input_file: inputFile,
            output_file: outputFile,
            rows_loaded: loadedMatch ? parseInt(loadedMatch[1]) : null,
            rows_saved: savedMatch ? parseInt(savedMatch[1]) : null,
            output: output
          };
        } else {
          return {
            success: false,
            error: "Processing failed",
            output: output
          };
        }
        
      } catch (error) {
        try {
          await sshExecViaNodeSsh(host, "rm '" + tempScript + "' 2>/dev/null || true", 5000);
        } catch (e) {}
        
        return {
          success: false,
          error: error.message || String(error),
          stderr: error.stderr || ""
        };
      }
    }
    
    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

function bruceAgentLlmBase() {
  // BRUCE_LLM_API_BASE est déjà utilisé ailleurs dans server.js (ex: /bruce/config/llm)
  return String(BRUCE_LLM_API_BASE || "").replace(/\/+$/, "");
}

function bruceAgentTimeoutMs() {
  const n = parseInt(String(BRUCE_LLM_TIMEOUT_MS || ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 180000;
}

async function bruceAgentFetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Endpoint principal BRUCE Agent
app.post("/bruce/agent/chat", async (req, res) => {
  // FAST-PATH: count machines via query_homelab_db (2.1.10)
  try {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
    const raw = (body && (body.message || body.prompt || body.query)) || "";
    const msg = String(raw || "").trim();
    if (/combien\s+de\s+machines?/i.test(msg)) {
      const sql = "SELECT COUNT(*) AS count FROM machines;";
      const toolRes = await executeTool("query_homelab_db", { query: sql });
      let n = null;
      try {
        const rows = JSON.parse(toolRes && toolRes.output ? toolRes.output : "[]");
        if (rows && rows[0] && Object.prototype.hasOwnProperty.call(rows[0], "count")) {
          n = rows[0].count;
        }
      } catch (_) {}
      const response = (n === null)
        ? (toolRes && toolRes.output ? toolRes.output : JSON.stringify(toolRes))
        : String(n);
      return res.json({
        success: true,
        response,
        tools_used: [{ name: "query_homelab_db", arguments: { query: sql } }]
      });
    }
  } catch (err) {
    // fall through
  }


  // Auth identique aux autres endpoints /bruce/*
  const auth = validateBruceAuth(req);
  if (!auth.ok) {
    return res.status(auth.status || 401).json({ success: false, error: auth.error || "Unauthorized" });
  }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const message = body.message;
    const conversation_history = Array.isArray(body.conversation_history) ? body.conversation_history : [];

    if (!message) {
      return res.status(400).json({ success: false, error: "Message is required" });
    }

    if (!SYSTEM_PROMPT) {
      return res.status(500).json({
        success: false,
        error: `Impossible de lire ${SYSTEM_PROMPT_PATH}`
      });
    }

    const base = bruceAgentLlmBase();
    if (!base) {
      return res.status(503).json({ success: false, error: "LLM base is not configured (BRUCE_LLM_API_BASE)" });
    }
    if (!BRUCE_LLM_MODEL) {
      return res.status(503).json({ success: false, error: "LLM model is not configured (BRUCE_LLM_MODEL)" });
    }

    // Construire messages pour vLLM
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...conversation_history,
      { role: "user", content: String(message) }
    ];

    const upstream = `${base}/chat/completions`;
    const timeoutMs = bruceAgentTimeoutMs();

    const r1 = await bruceAgentFetchWithTimeout(
      upstream,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(BRUCE_LLM_API_KEY ? { Authorization: `Bearer ${BRUCE_LLM_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model: BRUCE_LLM_MODEL,
          messages,
          tools: AVAILABLE_TOOLS,
          tool_choice: "auto",
          max_tokens: 2000,
          temperature: 0.7
        })
      },
      timeoutMs
    );

    const t1 = await r1.text();
    if (!r1.ok) {
      return res.status(502).json({ success: false, error: `LLM error: ${r1.status} ${r1.statusText}`, details: clampStr(t1, 4000) });
    }

    const vllmData = JSON.parse(t1);
    const assistantMessage = vllmData && vllmData.choices && vllmData.choices[0] && vllmData.choices[0].message;
    if (!assistantMessage) {
      return res.status(502).json({ success: false, error: "LLM response missing choices[0].message" });
    }

    // Fallback legacy tool_call (models may return <tool_call> in content)
    if ((!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) && assistantMessage.content) {
      const legacy = parseLegacyToolCallFromContent(assistantMessage.content);
      if (legacy && legacy.name) {
        const toolResult = await executeTool(legacy.name, legacy.arguments || {});
        const out =
          toolResult && typeof toolResult === "object"
            ? (toolResult.output || toolResult.stdout || toolResult.stderr || JSON.stringify(toolResult))
            : String(toolResult || "");
        return res.json({ success: true, response: out, tools_used: [{ name: legacy.name, arguments: legacy.arguments || {} }] });
      }
    }

    // Si le LLM veut utiliser des tools
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const toolResults = [];

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall && toolCall.function && toolCall.function.name ? toolCall.function.name : null;
        const rawArgs = toolCall && toolCall.function && toolCall.function.arguments ? toolCall.function.arguments : "{}";

        let toolParams = {};
        try {
          toolParams = JSON.parse(rawArgs);
        } catch (_) {
          toolParams = { _raw: String(rawArgs) };
        }

        const result = await executeTool(toolName, toolParams);

        toolResults.push({
          tool_call_id: toolCall.id || `call_${Date.now()}`,
          role: "tool",
          name: toolName || "unknown_tool",
          content: JSON.stringify(result)
        });
      }

      // Re-appeler vLLM avec les résultats des tools
      const followUpMessages = [
        ...messages,
        assistantMessage,
        ...toolResults
      ];

      const r2 = await bruceAgentFetchWithTimeout(
        upstream,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(BRUCE_LLM_API_KEY ? { Authorization: `Bearer ${BRUCE_LLM_API_KEY}` } : {}),
          },
          body: JSON.stringify({
            model: BRUCE_LLM_MODEL,
            messages: followUpMessages,
            max_tokens: 2000,
            temperature: 0.7
          })
        },
        timeoutMs
      );

      const t2 = await r2.text();
      if (!r2.ok) {
        return res.status(502).json({ success: false, error: `LLM follow-up error: ${r2.status} ${r2.statusText}`, details: clampStr(t2, 4000) });
      }

      const followUpData = JSON.parse(t2);
      const finalResponse =
        followUpData &&
        followUpData.choices &&
        followUpData.choices[0] &&
        followUpData.choices[0].message &&
        followUpData.choices[0].message.content
          ? followUpData.choices[0].message.content
          : "";

      return res.json({
        success: true,
        response: finalResponse,
        tools_used: assistantMessage.tool_calls.map((tc) => {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch (_) {
            args = { _raw: String(tc.function.arguments || "") };
          }
          return { name: tc.function.name, arguments: args };
        })
      });
    }

    // Pas de tools utilisés - réponse directe
    return res.json({
      success: true,
      response: assistantMessage.content,
      tools_used: []
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: String(error && error.message ? error.message : error)
    });
  }
});

console.log("[BRUCE Agent] Endpoint /bruce/agent/chat initialized");


// ========== START SERVER ==========

// ============================================================
// RAG Search Tool - v2 (2026-02-20) - vecteur via RPC, jamais inline SQL
// ============================================================
app.post('/tools/rag/search', async (req, res) => {
  const { query, top_k = 5, min_similarity = 0.5 } = req.body || {};
  if (!query) return res.status(400).json({ ok: false, error: 'query required' });
  try {
    // 1. Générer l'embedding via embedder BGE-M3
    const embedResp = await fetch(`${EMBEDDER_URL}/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [query] })
    });
    if (!embedResp.ok) return res.status(502).json({ ok: false, error: 'Embedder error ' + embedResp.status });
    const embedData = await embedResp.json();
    const vec = Array.isArray(embedData[0]) ? embedData[0] : embedData;

    // 2. Appel RPC Supabase - vecteur passé comme paramètre JSON, JAMAIS interpolé dans SQL
    const supaBase = SUPABASE_URL.replace('/rest/v1', '');
    const rpcResp = await fetch(`${supaBase}/rest/v1/rpc/search_bruce_chunks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'apikey': SUPABASE_KEY
      },
      body: JSON.stringify({ query_embedding: vec, match_threshold: min_similarity, match_count: top_k })
    });
    if (!rpcResp.ok) return res.status(502).json({ ok: false, error: 'RPC error ' + rpcResp.status });
    const results = await rpcResp.json();
    res.json({ ok: true, query, count: results.length, results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});


// ──────────────────────────────────────────────────────────────────
// ENDPOINT: POST /bruce/preflight  [688]
// Rôle: Rappel "juste-à-temps" avant une action SSH, transfert, ou docker.
// Claude appelle cet endpoint AVANT toute action pour recevoir les règles
// les plus pertinentes à ce type d'action spécifique.
// Auteur: claude-opus, session 688, 2026-03-01
// ──────────────────────────────────────────────────────────────────
app.post('/bruce/preflight', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const actionType = (req.body && req.body.action_type) ? String(req.body.action_type).toLowerCase().trim() : '';
  const context = (req.body && req.body.context) ? String(req.body.context).slice(0, 300) : '';

  if (!actionType) {
    return res.status(400).json({ ok: false, error: 'action_type requis. Valeurs: ssh, file_transfer, docker, write, supabase, sql, rest_api, general' });
  }

  // Mapping action_type -> mots-clés de recherche pour les interdictions et runbooks
  const ACTION_KEYWORDS = {
    ssh: {
      lesson_keywords: ['interdiction_ssh', 'interdiction_guillemets', 'interdiction_sed_go_heredoc', 'interdiction_faux_diagnostic', 'anti_pattern'],
      kb_keywords: ['runbook ssh', 'SSH Windows'],
      quick_rules: [
        'JAMAIS invoke_expression pour SSH → TOUJOURS Start-Job + Wait-Job -Timeout 25',
        'JAMAIS guillemets doubles imbriqués → TOUJOURS script .sh + SCP + exec',
        'JAMAIS sed/Go templates/heredoc via PowerShell → TOUJOURS script .sh',
        'JAMAIS && en PowerShell → utiliser ;',
        'Terminal qui "attend" = PAS bloqué, c\'est un timeout normal'
      ]
    },
    file_transfer: {
      lesson_keywords: ['interdiction_guillemets', 'file_transfer', 'scp'],
      kb_keywords: ['runbook transfert', 'transfert fichiers', 'SCP'],
      quick_rules: [
        'Petit (<50 lignes): write_file + SCP',
        'Moyen (50-2000 lignes): write_file chunked (30 lignes max par appel) + SCP',
        'Box2: TOUJOURS 2 étapes Windows→.230→box2 (pas de SCP direct)',
        'TOUJOURS backup avant remplacement: cp fichier fichier.bak_TASKID',
        'Gros (>200KB): NFS ou base64 REST, pas SCP'
      ]
    },
    docker: {
      lesson_keywords: ['interdiction_docker', 'docker_restart', 'compose'],
      kb_keywords: ['docker compose', 'docker restart'],
      quick_rules: [
        'Nouveau volume/bind: JAMAIS docker restart → TOUJOURS docker compose up -d',
        'Vérifier volumes: docker inspect container | grep -A5 Mounts',
        'Go templates (--format): JAMAIS via PowerShell → utiliser script .sh ou python3',
        'Logs: docker logs --tail 50 container (pas --since sans format correct)'
      ]
    },
    write: {
      lesson_keywords: ['staging_queue', 'roadmap', 'ecriture', 'write', 'table_cible'],
      kb_keywords: ['staging_queue schema', 'roadmap insertion'],
      quick_rules: [
        'roadmap: INSERT DIRECT via POST /rest/v1/roadmap (JAMAIS staging_queue)',
        'lessons_learned / knowledge_base: TOUJOURS via staging_queue',
        'staging_queue champs EXACTS: table_cible (pas table_target), contenu_json (pas content_json)',
        'author_system="claude" — jamais claude-opus, claude-sonnet',
        'Après push staging: POST /run/validate {staging_id} pour promouvoir'
      ]
    },
    supabase: {
      lesson_keywords: ['supabase', 'staging_queue', 'colonnes', 'schema', 'table'],
      kb_keywords: ['schema staging_queue', 'schema lessons_learned', 'schema roadmap'],
      quick_rules: [
        'staging_queue   : table_cible, contenu_json, author_system, content_hash, status',
        'lessons_learned : lesson_type, lesson_text, importance, confidence_score, validated',
        'knowledge_base  : question, answer, category, tags, confidence_score',
        'roadmap         : step_name, description, status, priority, model_hint',
        'current_state   : key, value, updated_at',
        'Ne JAMAIS utiliser les champs d\'une table dans une autre'
      ]
    },
    sql: {
      lesson_keywords: ['sql', 'supabase', 'psql'],
      kb_keywords: ['runbook sql', 'docker exec psql'],
      quick_rules: [
        'Écrire fichier .sql localement',
        'SCP vers .230 puis .146',
        'Exécuter: docker exec -i supabase-db psql -U postgres -d postgres -f /tmp/query.sql',
        'JAMAIS SQL inline dans SSH PowerShell (guillemets impossibles)'
      ]
    },
    rest_api: {
      lesson_keywords: ['session_close', 'bruce_write', 'staging_queue', 'schema', 'endpoint'],
      kb_keywords: ['cheatsheet schemas endpoints', 'session close', 'bruce write'],
      quick_rules: [
        'POST /bruce/session/close: OBLIGATOIRES = session_id(number) + summary(string) + handoff_next(string)',
        'POST /bruce/session/close OPTIONNELS: decisions[], rules_learned[], tech_discoveries[], patterns[], tasks_status[{id,status}], tasks_done[number], infrastructure_changes[]',
        'POST /bruce/write: table_cible(string) + contenu_json(object) — tables: lessons_learned|knowledge_base|current_state|roadmap|session_history',
        'GET /bruce/session/close/checklist?session_id=N pour verifier etat AVANT cloture',
        'current_state: la table s appelle current_state PAS bruce_state',
        'POST /bruce/preflight {action_type, context?} AVANT toute action pour rappel schemas'
      ]
    },
    general: {
      lesson_keywords: ['interdiction', 'anti_pattern', 'warning'],
      kb_keywords: ['runbook'],
      quick_rules: [
        'Consulter KB sémantique AVANT toute action (homelab-semantic-search-advanced)',
        'Documenter APRÈS chaque action dans Supabase',
        'Ne pas modifier ce qui fonctionne sans raison explicite'
      ]
    }
  };

  const config = ACTION_KEYWORDS[actionType] || ACTION_KEYWORDS['general'];

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  try {

    // [718] Recherche semantique: embed action_type + context -> lecons pertinentes
    // Complete la recherche FTS pour capturer les lecons non indexees par keyword exact
    let semanticLessons = [];
    const ragQuery = context
      ? (actionType + ' ' + context).slice(0, 400)
      : actionType;
    try {
      const ragResult = await bruceRagContext(ragQuery, 15);
      const chunkIds = (ragResult.results || []).map(r => r.chunk_id).filter(Boolean);
      if (chunkIds.length > 0) {
        // Recuperer les anchors des chunks pour identifier source + importance
        const chunkFilter = chunkIds.slice(0, 15).map(id => `chunk_id.eq.${id}`).join(',');
        const chunkRes = await fetchWithTimeout(
          base + `/bruce_chunks?or=(${chunkFilter})&select=chunk_id,anchor,text`,
          { headers: hSupa }, 5000
        );
        const chunkData = await chunkRes.json();
        const chunkMap = {};
        for (const c of (Array.isArray(chunkData) ? chunkData : [])) {
          chunkMap[c.chunk_id] = c;
        }
        const seenLessonIds = new Set();
        for (const r of (ragResult.results || [])) {
          const chunk = chunkMap[r.chunk_id] || {};
          let anchor = {};
          try { anchor = typeof chunk.anchor === 'string' ? JSON.parse(chunk.anchor) : (chunk.anchor || {}); } catch(_) {}
          if (anchor.source !== 'lessons_learned') continue;
          const imp = anchor.importance || '';
          if (imp !== 'critical' && imp !== 'high') continue;
          const sid = anchor.source_id;
          if (sid && seenLessonIds.has(sid)) continue;
          if (sid) seenLessonIds.add(sid);
          semanticLessons.push({
            id: sid,
            text: r.preview || chunk.text || '',
            score: r.hybrid_score || r.cos_sim || 0,
            importance: imp
          });
          if (semanticLessons.length >= 3) break;
        }
      }
    } catch(ragErr) {
      // Degrade gracieux: si embedder down, continue avec FTS seul
      semanticLessons = [];
    }

    // Chercher les leçons INTERDICTION pertinentes
    const intentFilter = config.lesson_keywords.map(k => `intent.ilike.*${k}*`).join(',');
    const lessonsRes = await fetchWithTimeout(
      base + `/lessons_learned?importance=eq.critical&validated=eq.true&or=(${intentFilter})&order=id.desc&limit=5`,
      { headers: hSupa }, 6000
    );
    const lessons = await lessonsRes.json();

    // Chercher les runbooks pertinents
    let runbooks = [];
    for (const kw of config.kb_keywords) {
      try {
        const kbRes = await fetchWithTimeout(
          base + `/knowledge_base?category=eq.runbook&answer=ilike.*${encodeURIComponent(kw)}*&limit=2`,
          { headers: hSupa }, 4000
        );
        const kbArr = await kbRes.json();
        if (Array.isArray(kbArr)) runbooks.push(...kbArr);
      } catch(e) { /* optionnel */ }
    }
    // Dédupliquer runbooks par id
    const seenIds = new Set();
    runbooks = runbooks.filter(r => {
      if (seenIds.has(r.id)) return false;
      seenIds.add(r.id);
      return true;
    });

    return res.json({
      ok: true,
      action_type: actionType,
      context: context,
      quick_rules: config.quick_rules,
      semantic_lessons: semanticLessons,
      interdictions: Array.isArray(lessons) ? lessons.map(l => ({
        id: l.id,
        text: l.lesson_text,
        intent: l.intent
      })) : [],
      runbooks: runbooks.map(r => ({
        id: r.id,
        title: r.question,
        preview: (r.answer || '').slice(0, 500)
      })),
      reminder: '⚠️ RAPPEL: Appliquer ces règles AVANT d\'agir. En cas de doute, écrire un script .sh.'
    });

  } catch (e) {
    // Fallback: retourner au moins les quick_rules
    return res.json({
      ok: true,
      action_type: actionType,
      quick_rules: config.quick_rules,
      interdictions: [],
      runbooks: [],
      reminder: '⚠️ Erreur DB mais voici les règles minimales. Appliquer avant d\'agir.',
      error_detail: String(e.message || e)
    });
  }
});


// ── INJECTÉ SESSION 14: /bruce/session/init + /bruce/integrity ──

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: POST /bruce/session/init
// Rôle: Injecter le contexte intelligent complet au démarrage d'une session.
// Orchestration: /bruce/state + RAG sémantique + résumé vLLM local
// Dégradé gracieux: si vLLM down → retourne contexte brut sans résumé
// Auteur: claude-sonnet-4-6, session 14, 2026-02-20
// ─────────────────────────────────────────────────────────────────────────────
app.post('/bruce/session/init', async (req, res) => {
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
    const rpcProfile = 'standard'; // standard|light|minimal
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
          routedLessons = [...canonicalLock, ...fusedFiltered, ...recentFiltered].slice(0, 10);
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
            max_tokens: 200,
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
    const contextPrompt = PROTOCOLE_690
      + (llmSummary ? '**Briefing:** ' + llmSummary + '\n\n' : '')
      + intentionBlock
      + scopeBlock
      + buildContextForProfile(llmProfile, dashboard, roadmap, effectiveLessons, ragResults, currentState)
      + toolsBlock;

    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      session_id: newSessionId,
      topic: ragQuery,
      project_scope: projectScope,
      llm_identity: llmIdentity,
      profile_used: llmProfile.profile_name || llmIdentity,
      context_prompt: contextPrompt,
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
app.get('/bruce/session/close/checklist', async (req, res) => {
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
app.post('/bruce/session/close', async (req, res) => {
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
    const tasksDone = Array.isArray(body.tasks_done) ? body.tasks_done.filter(id => typeof id === 'number' && id > 0) : [];
    const alreadyHandled = new Set(tasksStatus.map(t => t.id));
    for (const taskId of tasksDone) {
      if (alreadyHandled.has(taskId)) continue;
      try {
        const r = await fetchWithTimeout(
          base + '/roadmap?id=eq.' + taskId,
          { method: 'PATCH', headers: hSupa, body: JSON.stringify({ status: 'done' }) },
          5000
        );
        taskResults.push({ id: taskId, status: 'done', ok: r.ok, via: 'tasks_done_shortcut' });
      } catch (e) {
        taskResults.push({ id: taskId, status: 'done', ok: false, error: e.message, via: 'tasks_done_shortcut' });
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
// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: GET /bruce/integrity
// Rôle: Vérifier l'intégrité du système au démarrage.
// Vérifie: Supabase, embedder, vLLM, validate_service, staging_queue propre
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: POST /bruce/write  [124 Supabase mémoire structurée]
// Rôle: Proxy d'écriture unique vers Supabase — encapsule staging_queue + validate
//       Remplace les appels REST directs à staging_queue depuis les LLM.
// Input JSON:
//   table_cible: string  (lessons_learned | knowledge_base | current_state | roadmap)
//   contenu_json: object (colonnes de la table cible)
//   author_system?: string  (ex: "claude-sonnet-session")
//   content_hash?: string   (déduplication)
//   auto_validate?: boolean (défaut: true — lance validate.py après push)
// Output: { ok, staging_id, validated, validate_result? }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/bruce/write', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { table_cible, contenu_json, author_system, content_hash, auto_validate } = req.body || {};

  // Validation
  const ALLOWED_TABLES = ['lessons_learned', 'knowledge_base', 'current_state', 'roadmap', 'session_history'];
  if (!table_cible || !ALLOWED_TABLES.includes(table_cible)) {
    return res.status(400).json({ ok: false, error: 'table_cible invalide ou manquante. Tables autorisées: ' + ALLOWED_TABLES.join(', ') });
  }
  if (!contenu_json || typeof contenu_json !== 'object') {
    return res.status(400).json({ ok: false, error: 'contenu_json manquant ou invalide' });
  }

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };

  try {
    // [779] Fallback lesson_type pour lessons_learned: evite rejet Gate-1
    if (table_cible === 'lessons_learned' && contenu_json && !contenu_json.lesson_type) {
      contenu_json.lesson_type = 'solution';
      console.log('[779] lesson_type absent -> fallback solution injecte');
    }

    // 1. Push vers staging_queue
    const stagingPayload = {
      table_cible,
      contenu_json,
      author_system: author_system || 'mcp-gateway',
      content_hash: content_hash || null
    };

    const stagingRes = await fetchWithTimeout(
      base + '/staging_queue',
      { method: 'POST', headers: hSupa, body: JSON.stringify(stagingPayload) },
      8000
    );

    if (!stagingRes.ok) {
      const errText = await stagingRes.text();
      return res.status(stagingRes.status).json({ ok: false, error: 'staging_queue push failed: ' + errText });
    }

    const stagingData = await stagingRes.json();
    const stagingId = Array.isArray(stagingData) ? stagingData[0]?.id : stagingData?.id;

    // 2. Auto-validate (défaut: true)
    const shouldValidate = auto_validate !== false;
    let validateResult = null;

    if (shouldValidate) {
      try {
        const valRes = await fetchWithTimeout(
          'http://192.168.2.230:4001/run/validate',
          { method: 'POST', headers: { 'X-BRUCE-TOKEN': String(process.env.BRUCE_AUTH_TOKEN || 'bruce-secret-token-01') } },
          20000
        );
        const valData = await valRes.json();
        validateResult = {
          exit: valData?.validate?.exit,
          valides: (valData?.validate?.stdout || '').match(/Valides:\s+(\d+)/)?.[1] || '?',
          erreurs: (valData?.validate?.stdout || '').match(/Erreurs:\s+(\d+)/)?.[1] || '?'
        };
      } catch(ve) {
        validateResult = { error: 'validate non disponible: ' + ve.message };
      }
    }

    // [P7-FIX triage Opus 2026-03-02] Determine validated from actual valides count, not exit code
    const validesCount = parseInt(validateResult?.valides) || 0;
    const wasValidated = shouldValidate && validateResult?.exit === 0 && validesCount > 0;

    // [P7-FIX] If rejected (valides=0, exit=0), fetch rejection_reason from staging
    let rejectionReason = null;
    if (shouldValidate && validateResult?.exit === 0 && validesCount === 0 && stagingId) {
      try {
        const stgCheck = await fetchWithTimeout(
          base + '/staging_queue?id=eq.' + stagingId + '&select=status,rejection_reason',
          { headers: hSupa }, 5000
        );
        const stgData = await stgCheck.json();
        const stgEntry = Array.isArray(stgData) ? stgData[0] : stgData;
        if (stgEntry?.rejection_reason) rejectionReason = stgEntry.rejection_reason;
        if (stgEntry?.status === 'rejected' && !rejectionReason) rejectionReason = 'Rejected by validate.py (no reason captured)';
      } catch(re) { /* ignore fetch error */ }
    }

    const response = {
      ok: true,
      staging_id: stagingId,
      table_cible,
      validated: wasValidated,
      validate_result: validateResult
    };
    if (rejectionReason) response.rejection_reason = rejectionReason;
    return res.json(response);

  } catch(e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/bruce/integrity', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key  = String(SUPABASE_KEY || '');
  const hSupa = { 'apikey': key, 'Authorization': 'Bearer ' + key };

  // === PARALLEL CHECKS with individual + global timeout (max 8s) ===
  const GLOBAL_TIMEOUT_MS = 8000;
  const globalStart = Date.now();

  async function safeCheck(name, fn) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('check_timeout')), GLOBAL_TIMEOUT_MS - 500))
      ]);
      return { name, ...result };
    } catch (e) {
      return { name, ok: false, error: String(e.message || e) };
    }
  }

  const checkFns = [
    safeCheck('supabase', async () => {
      const r = await fetchWithTimeout(base + '/v_bruce_dashboard?limit=1', { headers: hSupa }, 5000);
      const d = await r.json();
      return { ok: Array.isArray(d) && d.length > 0, detail: d[0] || null };
    }),
    safeCheck('staging_pending', async () => {
      const r = await fetchWithTimeout(base + '/staging_queue?status=eq.pending&select=id', { headers: hSupa }, 5000);
      const d = await r.json();
      return { ok: true, count: Array.isArray(d) ? d.length : -1 };
    }),
    safeCheck('embedder', async () => {
      const r = await fetchWithTimeout('http://192.168.2.85:8081/health', {}, 4000);
      return { ok: r.status === 200 };
    }),
    safeCheck('vllm', async () => {
      const r = await fetchWithTimeout('http://192.168.2.32:8000/v1/models',
        { headers: { 'Authorization': 'Bearer ' + (BRUCE_LLM_API_KEY || 'token-abc123') } }, 5000);
      return { ok: r.status === 200 };
    }),
    safeCheck('validate_service', async () => {
      const r = await fetchWithTimeout('http://172.18.0.1:4001/health', {}, 4000);
      const d = await r.json();
      return { ok: d.ok === true };
    }),
    safeCheck('n8n', async () => {
      const r = await fetchWithTimeout('http://192.168.2.174:5678/healthz', {}, 4000);
      return { ok: r.status === 200 };
    }),
    safeCheck('litellm', async () => {
      const r = await fetchWithTimeout('http://172.18.0.1:4100/health',
        { headers: { 'Authorization': 'Bearer ' + (BRUCE_LITELLM_KEY || 'bruce-litellm-key-01') } }, 4000);
      return { ok: r.status === 200 };
    }),
    safeCheck('sequences', async () => {
      const r = await fetchWithTimeout(base + '/rpc/check_sequences', {
        method: 'POST',
        headers: { ...hSupa, 'Content-Type': 'application/json' },
        body: '{}'
      }, 5000);
      const d = await r.json();
      if (!Array.isArray(d)) return { ok: false, error: 'rpc_failed' };
      const bad = d.filter(x => x.status !== 'OK');
      return { ok: bad.length === 0, total: d.length, desaligned: bad };
    })
  ];

  // Run ALL checks in parallel, never block more than GLOBAL_TIMEOUT_MS
  let results;
  try {
    results = await Promise.race([
      Promise.allSettled(checkFns),
      new Promise((_, reject) => setTimeout(() => reject(new Error('global_integrity_timeout')), GLOBAL_TIMEOUT_MS))
    ]);
  } catch (e) {
    // Global timeout hit - return partial results
    return res.json({
      ok: false,
      generated_at: new Date().toISOString(),
      checks: { _timeout: { ok: false, error: 'Global timeout after ' + GLOBAL_TIMEOUT_MS + 'ms' } },
      elapsed_ms: Date.now() - globalStart,
      verdict: 'Integrity check timeout — certains services ne répondent pas.'
    });
  }

  const checks = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { name, ...rest } = r.value;
      checks[name] = rest;
    }
  }

  const allOk = Object.values(checks).every(c => c.ok);
  const elapsed = Date.now() - globalStart;

  return res.json({
    ok: allOk,
    generated_at: new Date().toISOString(),
    checks,
    elapsed_ms: elapsed,
    verdict: allOk ? 'Système nominal — prêt pour la session.' : 'Attention: certains services sont dégradés.'
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: POST /bruce/ask
// Rôle: Dialogue RAG+vLLM — Claude pose une question, reçoit une réponse
//        enrichie par le contexte sémantique de la base BRUCE.
// Usage: { question: "...", context?: "..." }
// Économie de tokens: vLLM local répond avec contexte RAG, pas Claude
// ─────────────────────────────────────────────────────────────────────────────
app.post('/bruce/ask', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const question = (req.body && req.body.question) ? String(req.body.question).slice(0, 500) : '';
  const extraContext = (req.body && req.body.context) ? String(req.body.context).slice(0, 1000) : '';
  const sessionId = (req.body && req.body.session_id) ? String(req.body.session_id).slice(0, 100) : null;

  // Détection profil LLM pour adapter la réponse
  const askLLMIdentity = detectLLMIdentity(req);
  const askLLMProfile = await loadLLMProfile(askLLMIdentity);

  if (!question) return res.status(400).json({ ok: false, error: 'Champ "question" requis.' });

  // ── 0. MULTI-TOURS: charger historique conversation si session_id fourni ──
  let conversationHistory = [];
  if (sessionId) {
    try {
      const base = String(SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
      const key  = String(SUPABASE_KEY || '');
      const histRes = await fetchWithTimeout(
        base + '/rest/v1/bruce_conversations?session_id=eq.' + encodeURIComponent(sessionId) +
        '&order=created_at.desc&limit=10',
        { method: 'GET', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
        5000
      );
      if (histRes.ok) {
        const histData = await histRes.json();
        // Inverser pour ordre chronologique et construire messages
        conversationHistory = histData.reverse().map(m => ({ role: m.role, content: m.content }));
      }
    } catch(e) { /* historique non critique */ }
  }

  // ── 1. RAG: chercher contexte pertinent ──────────────────────────────────
  let ragContext = '';
  let ragError = null;
  try {
    const embedRes = await fetchWithTimeout(
      'http://192.168.2.85:8081/embed',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: question, max_length: 512 }) },
      8000
    );
    const embedData = await embedRes.json();
    const embedding = Array.isArray(embedData) ? (Array.isArray(embedData[0]) ? embedData[0] : embedData) : (embedData.embedding || embedData.embeddings?.[0]);
    if (embedding && embedding.length > 0) {
      const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
      const key  = String(SUPABASE_KEY || '');
      const ragRes = await fetchWithTimeout(
        base + '/rpc/bruce_rag_hybrid_search_text',
        { method: 'POST', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ qtext: question, qvec: '[' + embedding.join(',') + ']', k: 8 }) },
        10000
      );
      const ragData = await ragRes.json();
      if (Array.isArray(ragData) && ragData.length > 0) {
        ragContext = ragData.slice(0, 8).map((r, i) =>
          `[Source ${i+1} | score:${Math.round((r.hybrid_score||r.cos_sim||r.similarity||0)*100)/100}]\n${(r.preview||r.text||'').slice(0,500)}`
        ).join('\n\n');
      }
    }
  } catch (e) {
    ragError = String(e.message);
  }

  // ── 2. vLLM: répondre avec contexte ──────────────────────────────────────
  // System prompt adapté au profil de l'appelant
  const profileRules = Array.isArray(askLLMProfile.rules) ? askLLMProfile.rules.map(r => '- ' + r).join('\n') : '';
  const systemPrompt = `Tu es BRUCE, l assistant IA expert du homelab de Yann Lafleur.
Tu reponds a: ${askLLMProfile.display_name || askLLMIdentity}

${BRUCE_OPERATING_PRINCIPLES}

REGLE ABSOLUE: Tu dois TOUJOURS baser ta reponse sur les SOURCES RAG fournies. Ne dis JAMAIS que tu ne trouves pas d information si des sources sont presentes.
${profileRules ? '\nREGLES SPECIFIQUES:\n' + profileRules : ''}

Format: ${askLLMProfile.context_format === 'concise_factual' ? 'reponses courtes et factuelles, pas de markdown' : askLLMProfile.context_format === 'narrative_concise' ? 'prose narrative concise, commandes a copier' : 'markdown structure, actionnable'}
Ne hallucine jamais de details techniques non presents dans les sources.`;

  const userPrompt = `QUESTION: ${question}
${extraContext ? `\nCONTEXTE ADDITIONNEL:\n${extraContext}` : ''}
${ragContext ? `\nCONTEXTE RAG (base de connaissance BRUCE):\n${ragContext}` : '\n(Aucun contexte RAG disponible pour cette question.)'}

Reponds de facon concise et actionnable.`;

  try {
    // [730] Route via LiteLLM proxy (was direct vLLM .32:8000)
    const llmRes = await fetchWithTimeout(
      'http://192.168.2.230:4100/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (BRUCE_LITELLM_KEY || 'bruce-litellm-key-01'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5-7b',
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user',   content: userPrompt }
          ],
          max_tokens: 800,
          temperature: 0.2,
          metadata: { trace_name: 'bruce-ask', generation_name: 'ask-answer', session_id: sessionId || 'unknown' }
        })
      },
      20000
    );
    const llmData = await llmRes.json();
    const answer = llmData?.choices?.[0]?.message?.content || null;

    // Sauvegarder dans l'historique si session_id présent
    if (sessionId && answer) {
      try {
        const base = String(SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
        const key  = String(SUPABASE_KEY || '');
        const msgs = [
          { session_id: sessionId, role: 'user',      content: question,     rag_sources: 0 },
          { session_id: sessionId, role: 'assistant', content: answer,        rag_sources: ragContext ? ragContext.split('\n\n').length : 0 }
        ];
        await fetchWithTimeout(
          base + '/rest/v1/bruce_conversations',
          { method: 'POST', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify(msgs) },
          5000
        );
      } catch(e) { /* non critique */ }
    }

    return res.json({
      ok: true,
      question,
      answer,
      llm_identity: askLLMIdentity,
      profile_used: askLLMProfile.profile_name || askLLMIdentity,
      session_id: sessionId || null,
      history_turns: conversationHistory.length / 2,
      rag_sources: ragContext ? ragContext.split('\n\n').length : 0,
      rag_error: ragError,
      model: 'Qwen/Qwen2.5-7B-Instruct-AWQ',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message), rag_error: ragError });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: GET /bruce/inbox/check  [435b - déblocage workflow n8n 25]
// Rôle: Vérifie les fichiers en attente dans /home/furycom/inbox/
// Retourne: { ok, count, files: [...] }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/bruce/inbox/check', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const fs = require('fs');
  const path = require('path');
  const INBOX_DIR = '/home/furycom/inbox';

  try {
    if (!fs.existsSync(INBOX_DIR)) {
      fs.mkdirSync(INBOX_DIR, { recursive: true });
    }
    const files = fs.readdirSync(INBOX_DIR)
      .filter(f => !f.startsWith('.') && f !== 'done')
      .map(f => {
        const fp = path.join(INBOX_DIR, f);
        const stat = fs.statSync(fp);
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      });
    return res.json({ ok: true, count: files.length, files, inbox_dir: INBOX_DIR });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: POST /bruce/inbox/ingest  [435b - déblocage workflow n8n 25]
// Rôle: Lance push_to_staging.py sur les fichiers de l'inbox
// Body: { auto_validate?: boolean }
// Retourne: { ok, ingested, result }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/bruce/inbox/ingest', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  // [FIX session 1002] Proxy to host inbox_http_runner.py on port 4002
  // python3 not available in Alpine Node container - Option C: run on host
  const RUNNER_URL = 'http://172.18.0.1:4002/inbox/ingest';
  try {
    const resp = await fetch(RUNNER_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + (BRUCE_AUTH_TOKEN || 'bruce-secret-token-01'), 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(180000)
    });
    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'inbox runner unreachable: ' + String(e.message), hint: 'Verify tmux inboxrun on .230 port 4002' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: GET /bruce/archive/check  [session109 - surveillance dossier archive]
// Rôle: Vérifie les fichiers en attente dans /home/furycom/archive_inbox/
// Retourne: { ok, count, files, archive_dir }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/bruce/archive/check', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const fs = require('fs');
  const ARCHIVE_DIR = '/home/furycom/archive_inbox';

  try {
    if (!fs.existsSync(ARCHIVE_DIR)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      return res.json({ ok: true, count: 0, files: [], archive_dir: ARCHIVE_DIR });
    }
    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => !f.startsWith('.') && (f.endsWith('.txt') || f.endsWith('.md') || f.endsWith('.log')));
    return res.json({ ok: true, count: files.length, files, archive_dir: ARCHIVE_DIR });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: POST /bruce/archive/ingest  [session109 - ingestion mode archive]
// Rôle: Lance bruce_ingest.py --archive sur les fichiers de /home/furycom/archive_inbox/
// Body: { auto_validate?: true }
// Retourne: { ok, ingested, files, result }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/bruce/archive/ingest', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { spawn } = require('child_process');
  const fs = require('fs');
  const ARCHIVE_DIR = '/home/furycom/archive_inbox';
  const SCRIPT = '/home/furycom/bruce_ingest.py';
  const VENV_PYTHON = '/home/furycom/venv-ingestion/bin/python3';
  const SENT_DIR = '/home/furycom/archive_inbox_sent';

  try {
    if (!fs.existsSync(ARCHIVE_DIR)) {
      return res.json({ ok: true, ingested: 0, result: 'Archive inbox vide', files: [] });
    }
    const files = fs.readdirSync(ARCHIVE_DIR)
      .filter(f => !f.startsWith('.') && (f.endsWith('.txt') || f.endsWith('.md') || f.endsWith('.log')));
    if (files.length === 0) {
      return res.json({ ok: true, ingested: 0, result: 'Archive inbox vide', files: [] });
    }

    if (!fs.existsSync(SENT_DIR)) fs.mkdirSync(SENT_DIR, { recursive: true });

    const results = [];
    for (const file of files) {
      const filePath = `${ARCHIVE_DIR}/${file}`;
      const sourceLabel = `archive-n8n/${file}`;
      await new Promise((resolve) => {
        const proc = spawn(VENV_PYTHON, [SCRIPT, filePath, '--source', sourceLabel, '--archive'], {
          timeout: 300000
        });
        proc.on('error', (err) => { console.error('[P1-SPAWN-ERR] VENV_PYTHON:', err.message); resolve(); });
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', (code) => {
          const ok = code === 0 || stdout.includes('TERMIN') || stdout.includes('staging');
          if (ok) {
            const dest = `${SENT_DIR}/${file}`;
            try { fs.renameSync(filePath, dest); } catch(e) {}
          }
          results.push({ file, ok, code, output: stdout.slice(0, 500) });
          resolve();
        });
      });
    }

    const success = results.filter(r => r.ok).length;
    return res.json({ ok: true, ingested: success, total: files.length, files, results });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});

// ENDPOINT: POST /bruce/maintenance/run  [435b - déblocage workflow n8n 80]
// Rôle: Lance kb_maintenance.py en arrière-plan
// Body: { script: "kb_maintenance", args?: "--dry-run false" }
// Retourne: { ok, started, pid, script }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/bruce/maintenance/run', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { spawn } = require('child_process');
  const fs = require('fs');
  const scriptName = (req.body && req.body.script) ? String(req.body.script) : 'kb_maintenance';
  const argsStr   = (req.body && req.body.args)   ? String(req.body.args)   : '';

  const ALLOWED_SCRIPTS = { 'kb_maintenance': '/home/furycom/kb_maintenance.py', 'pulse_sync': '/home/furycom/pulse_sync.py' };
  const scriptPath = ALLOWED_SCRIPTS[scriptName];
  if (!scriptPath) {
    return res.status(400).json({ ok: false, error: `Script inconnu: ${scriptName}. Autorisés: ${Object.keys(ALLOWED_SCRIPTS).join(', ')}` });
  }

  const logFile = '/tmp/kb_maintenance_last.log';
  const logArgs = argsStr.split(' ').filter(a => a);
  try {
    const out = fs.openSync(logFile, 'w');
    const VENV_PYTHON = '/home/furycom/venv-ingestion/bin/python3';
    const pythonBin = require('fs').existsSync(VENV_PYTHON) ? VENV_PYTHON : null;
    if (!pythonBin) { fs.closeSync(out); return res.status(503).json({ ok: false, error: 'venv python3 not found' }); }
    const child = spawn(pythonBin, [scriptPath, ...logArgs], { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.closeSync(out);
    return res.json({ ok: true, started: true, pid: child.pid, script: scriptPath, args: argsStr, log: logFile, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});


// ENDPOINT: POST /bruce/sync/homelab-hub  [444 - sync Supabase homelab_services -> Homelab Hub]
// Rôle: Lance sync_homelab_hub.py en arrière-plan
// Retourne: { ok, started, pid, log }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/bruce/sync/homelab-hub', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { spawn } = require('child_process');
  const fs = require('fs');
  const logFile = '/tmp/sync_homelab_hub.log';
  try {
    const out = fs.openSync(logFile, 'w');
    const child = safePythonSpawn('/home/furycom/sync_homelab_hub.py', [], { detached: true, stdio: ['ignore', out, out] });
    if (!child) { fs.closeSync(out); return res.status(503).json({ ok: false, error: 'python3 not available in container.' }); }
    child.unref();
    fs.closeSync(out);
    return res.json({ ok: true, started: true, pid: child.pid, log: logFile, timestamp: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message) });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: GET /bruce/topology  [669 - ISK Phase 8]
// Rôle: Reconstruit l'arbre hiérarchique machines > VMs > containers > services
// depuis la table bruce_tools. Retourne JSON structuré.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/bruce/topology', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  try {
    const SUPA_URL = SUPABASE_URL;
    const SUPA_KEY = SUPABASE_KEY;
    const headers = { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` };

    // Récupérer tous les outils avec champs pertinents pour topologie
    const resp = await fetch(
      `${SUPA_URL.replace(/\/+$/, '')}/bruce_tools?select=id,name,category,tool_type,status,host,ip,port,url,role,vm_parent,notes&order=category.asc,host.asc,name.asc`,
      { headers }
    );
    console.log('[TOPO-DEBUG] URL:', `${SUPA_URL.replace(/\/+$/, '')}/bruce_tools`); console.log('[TOPO-DEBUG] Status:', resp.status); if (!resp.ok) throw new Error(`Supabase error: ${resp.status}`);
    const tools = await resp.json();

    // Construire l'arbre hiérarchique
    // Niveau 1: machines (hosts uniques avec IP)
    // Niveau 2: services sur cette machine (groupés par tool_type)
    // vm_parent permet de lier un service à une VM parente plutôt qu'à la machine physique

    const machines = {}; // keyed by host

    for (const tool of tools) {
      if (!tool.host && !tool.ip) continue; // outils sans localisation (scripts locaux, etc.)

      const machineKey = tool.host || tool.ip;

      if (!machines[machineKey]) {
        machines[machineKey] = {
          host: tool.host,
          ip: tool.ip,
          services: [],
          vms: {}
        };
      }

      const entry = {
        id: tool.id,
        name: tool.name,
        category: tool.category,
        tool_type: tool.tool_type,
        status: tool.status,
        port: tool.port,
        url: tool.url,
        role: tool.role
      };

      // Si vm_parent défini, rattacher à la VM parente
      if (tool.vm_parent) {
        if (!machines[machineKey].vms[tool.vm_parent]) {
          machines[machineKey].vms[tool.vm_parent] = { name: tool.vm_parent, services: [] };
        }
        machines[machineKey].vms[tool.vm_parent].services.push(entry);
      } else {
        machines[machineKey].services.push(entry);
      }
    }

    // Convertir en tableau structuré
    const topology = Object.entries(machines).map(([hostKey, data]) => ({
      host: data.host || hostKey,
      ip: data.ip,
      services_count: data.services.length + Object.values(data.vms).reduce((acc, vm) => acc + vm.services.length, 0),
      services: data.services,
      vms: Object.values(data.vms)
    })).sort((a, b) => (b.services_count - a.services_count));

    // Stats globales
    const stats = {
      total_tools: tools.length,
      tools_with_host: tools.filter(t => t.host || t.ip).length,
      tools_without_host: tools.filter(t => !t.host && !t.ip).length,
      unique_machines: topology.length,
      active_services: tools.filter(t => t.status === 'active').length
    };

    return res.json({
      ok: true,
      generated_at: new Date().toISOString(),
      stats,
      topology,
      unlocated_tools: tools.filter(t => !t.host && !t.ip).map(t => ({
        id: t.id, name: t.name, category: t.category, tool_type: t.tool_type, status: t.status
      }))
    });

  } catch (e) {
    console.error('[/bruce/topology] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});



// ============================================================
// /bruce/bootstrap — Combined integrity + session/init (v1.0)
// Added session Opus 2026-03-01. Reduces bootstrap from 10 tool calls to 1.
// ============================================================
app.post('/bruce/bootstrap', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const topic = (req.body && req.body.topic) ? String(req.body.topic).slice(0, 200) : '';
  const model = (req.body && req.body.model) ? String(req.body.model).slice(0, 20) : '';
  const startMs = Date.now();

  const hGw = { 'Authorization': req.headers['authorization'] || ('Bearer ' + (req.headers['x-bruce-token'] || '')), 'Content-Type': 'application/json' };

  try {
    // Run integrity + session/init in PARALLEL via internal loopback
    const [integrityRes, sessionRes] = await Promise.all([
      fetchWithTimeout('http://127.0.0.1:' + PORT + '/bruce/integrity', { headers: hGw }, 10000),
      fetchWithTimeout('http://127.0.0.1:' + PORT + '/bruce/session/init', {
        method: 'POST',
        headers: hGw,
        body: JSON.stringify({ topic, scope: 'homelab,general' })
      }, 18000)
    ]);

    const integrity = await integrityRes.json();
    const session = await sessionRes.json();

    // Trim current_state: keep REGLE_YANN_*, key state keys, + 10 most recent others
    let trimmedState = [];
    if (Array.isArray(session.current_state)) {
      const priorityKeys = new Set();
      const priority = session.current_state.filter(s => {
        const dominated = s.key.startsWith('REGLE_YANN_') ||
          s.key === 'CURRENT_STATE' ||
          s.key === 'handoff_vivant' ||
          s.key === 'SERVICES_CONFIG' ||
          s.key === 'supabase_rest' ||
          s.key === 'furysupa_146_state' ||
          s.key === 'staging_queue_schema' ||
          s.key === 'validate_version' ||
          s.key === 'workspace_root' ||
          s.key === 'REFONTE_V2';
        if (dominated) priorityKeys.add(s.key);
        return dominated;
      });
      const rest = session.current_state
        .filter(s => !priorityKeys.has(s.key))
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .slice(0, 10);
      trimmedState = [...priority, ...rest];
    }

    // No filter: return all tasks (all model_hints) ordered by priority
    let tasks = session.next_tasks || [];

    return res.json({
      ok: integrity.ok && session.ok,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startMs,
      session_id: session.session_id || null,
      model_filter: model || 'none',
      integrity: {
        ok: integrity.ok,
        verdict: integrity.verdict,
        checks_summary: Object.fromEntries(
          Object.entries(integrity.checks || {}).map(([k, v]) => [k, v.ok])
        )
      },
      briefing: session.briefing || null,
      dashboard: session.dashboard || null,
      next_tasks: tasks,
      critical_lessons: (session.critical_lessons || []).map(l => ({
        id: l.id, lesson_type: l.lesson_type, lesson_text: l.lesson_text,
        importance: l.importance, confidence_score: l.confidence_score
      })),
      last_session: session.last_session || null,
      current_state: trimmedState,
      clarifications_pending: session.clarifications_pending || [],
      rag_context: session.rag_context || []
    });
  } catch (e) {
    console.error('[/bruce/bootstrap] Error:', e.message);
    return res.status(500).json({
      ok: false,
      error: e.message,
      elapsed_ms: Date.now() - startMs,
      hint: 'Fallback: call /bruce/integrity and /bruce/session/init separately'
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// [708] POST /bruce/exec — alternative REST à SSH depuis Windows
// Body: { cmd: string, host?: "local", timeout_sec?: number (1-120) }
// host="local" → validation 6 patterns BRUCE + /bin/sh -c exec dans le container
// Returns: { ok, exit_code, stdout, stderr, refused?, refused_pattern?, elapsed_ms }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/bruce/exec', (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const { cmd, host = 'local', timeout_sec = 30 } = req.body || {};

  if (!cmd || typeof cmd !== 'string' || cmd.trim() === '') {
    return res.status(400).json({ ok: false, error: 'cmd requis (string non vide)' });
  }
  if (host !== 'local') {
    return res.status(400).json({
      ok: false,
      error: 'Seul host="local" est supporté (container sans SSH). Pour SSH distant, utiliser Invoke-BruceSSH ou ssh bash natif.'
    });
  }
  const tSec = Math.max(1, Math.min(120, Number(timeout_sec) || 30));

  // ── Validation 6 patterns BRUCE (miroir de bruce_exec.sh et bruce_ssh.ps1) ──
  const BRUCE_PATTERNS = [
    {
      name: 'GUILLEMETS_IMBRIQUES',
      test: (c) => /\\"/.test(c) || /"[^"]*'[^"]*"/.test(c) || /'[^']*"[^']*'/.test(c),
      alt:  'Ecrire un script .sh local, SCP vers .230, puis executer.'
    },
    {
      name: 'OPERATEUR_ET',
      test: (c) => /&&/.test(c),
      alt:  'Separer en deux appels /bruce/exec distincts ou utiliser ";" dans le cmd.'
    },
    {
      name: 'SED_NEWLINES',
      test: (c) => /sed\s+.*\\n/.test(c),
      alt:  'Script .sh avec sed natif ou python3 -c pour multi-lignes.'
    },
    {
      name: 'GO_TEMPLATES_INSPECT',
      test: (c) => /docker\s+inspect\b/.test(c) && /\{\{/.test(c),
      alt:  "docker inspect X | sh -c \"cat\" puis parser avec Node.js JSON.parse."
    },
    {
      name: 'HEREDOC',
      test: (c) => /<<\s*(EOF|EOL|END|HEREDOC)\b/.test(c),
      alt:  'Ecrire le contenu via /bruce/write ou SCP un fichier .sh.'
    },
    {
      name: 'ECHO_MULTILINE_PIPE',
      test: (c) => /echo\s+-e\s+.*\\n.*\|\s*(tee|cat)/.test(c),
      alt:  'Script .sh avec printf ou cat > fichier.'
    }
  ];

  for (const p of BRUCE_PATTERNS) {
    if (p.test(cmd)) {
      console.log(`[/bruce/exec] REFUSE pattern=${p.name} cmd=${cmd.substring(0,100)}`);
      return res.status(422).json({
        ok: false,
        refused: true,
        refused_pattern: p.name,
        alternative: p.alt,
        cmd: cmd.substring(0, 200)
      });
    }
  }

  // ── Exécution via /bin/sh (seul shell disponible dans le container) ──
  const { spawn } = require('child_process');
  const startMs = Date.now();

  const proc = spawn('/bin/sh', ['-c', cmd], { env: process.env });
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill('SIGTERM'); } catch (_) {}
  }, tSec * 1000);

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    clearTimeout(timer);
    const elapsed_ms = Date.now() - startMs;
    if (timedOut) {
      return res.status(504).json({ ok: false, error: `timeout apres ${tSec}s`, elapsed_ms });
    }
    const ok = (code === 0);
    console.log(`[/bruce/exec] exit=${code} elapsed=${elapsed_ms}ms cmd=${cmd.substring(0,60)}`);
    return res.status(ok ? 200 : 422).json({
      ok,
      exit_code: code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      host: 'local',
      cmd: cmd.substring(0, 200),
      elapsed_ms
    });
  });

  proc.on('error', (err) => {
    clearTimeout(timer);
    console.error('[/bruce/exec] spawn error:', err.message);
    return res.status(500).json({ ok: false, error: err.message, elapsed_ms: Date.now() - startMs });
  });
});



// ============================================================
// GET /bruce/roadmap/list — [721] Tableau roadmap ordonné pour session
// Retourne tâches todo/doing ordonnées priority.asc, id.asc
// Format: id, priority, model_hint, step_name
// ============================================================
app.get('/bruce/roadmap/list', async (req, res) => {
  const startMs = Date.now();
  try {
    const url = `${SUPABASE_URL}/roadmap?status=in.(todo,doing)&order=priority.asc,id.asc&select=id,priority,model_hint,step_name`;
    const resp = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } });
    if (!resp.ok) throw new Error(`Supabase ${resp.status}`);
    const tasks = await resp.json();
    return res.json({
      ok: true,
      count: tasks.length,
      elapsed_ms: Date.now() - startMs,
      tasks
    });
  } catch (err) {
    console.error('[/bruce/roadmap/list]', err.message);
    return res.status(500).json({ ok: false, error: err.message, elapsed_ms: Date.now() - startMs });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`MCP Gateway listening on port ${PORT}`);
});
