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

// ========== ROUTE MODULES (C7 refonte) ==========
const dataReadRoutes = require('./routes/data-read');
const dataWriteRoutes = require('./routes/data-write');
const inboxRoutes = require('./routes/inbox');
const infraRoutes = require('./routes/infra');
const ragRoutes = require('./routes/rag');
const askRoutes = require('./routes/ask');
const chatRoutes = require('./routes/chat');
const sessionRoutes = require('./routes/session');
const roadmapRoutes = require('./routes/roadmap');
const toolsUnlockRoutes = require('./routes/tools-unlock');
const fileRoutes = require('./routes/file');

// ========== SHARED MODULES (C7 refonte) ==========
const { fetchWithTimeout } = require('./shared/fetch-utils');
const { bruceRagContext, BRUCE_RAG_METRICS } = require('./routes/rag');
const { detectLLMIdentity, loadLLMProfile, buildContextForProfile, bruceClientIp, BRUCE_OPERATING_PRINCIPLES } = require('./shared/llm-profiles');

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

// Mount C7 route modules
app.use(dataReadRoutes);
app.use(dataWriteRoutes);
app.use(inboxRoutes);
app.use(infraRoutes);
app.use(ragRoutes);
app.use(askRoutes);
app.use(chatRoutes);

// Wire dependency injection
infraRoutes.setSafePythonSpawn(safePythonSpawn);
app.use(sessionRoutes);
app.use(roadmapRoutes);
app.use(toolsUnlockRoutes);
app.use(fileRoutes);
sessionRoutes.setSafePythonSpawn(safePythonSpawn);

// ========== HEALTH ==========

const jsonObjectSchema = { type: "object", additionalProperties: true };

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
                schema: jsonObjectSchema
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
                schema: jsonObjectSchema
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
                schema: jsonObjectSchema
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
                  schema: jsonObjectSchema
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
                    schema: jsonObjectSchema
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
                  schema: jsonObjectSchema
                }
              }
            },
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: jsonObjectSchema
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
                  schema: jsonObjectSchema
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
                  schema: jsonObjectSchema
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
                  schema: jsonObjectSchema
                }
              }
            }
          }
        }
      }
    }
};


const makeStandardResponses = () => ({
  "200": {
    description: "OK",
    content: {
      "application/json": {
        schema: jsonObjectSchema
      }
    }
  },
  "400": {
    description: "Bad request",
    content: {
      "application/json": {
        schema: jsonObjectSchema
      }
    }
  },
  "401": {
    description: "Unauthorized",
    content: {
      "application/json": {
        schema: jsonObjectSchema
      }
    }
  },
  "500": {
    description: "Internal server error",
    content: {
      "application/json": {
        schema: jsonObjectSchema
      }
    }
  }
});

Object.assign(BRUCE_OPENAPI_SPEC.paths, {
  "/admin": {
    get: { operationId: "admin_ui", summary: "Serve admin dashboard placeholder page", responses: makeStandardResponses() }
  },
  "/connectors": {
    get: { operationId: "connectors_list", summary: "List configured connectors and statuses", responses: makeStandardResponses() }
  },
  "/manual/pages": {
    get: { operationId: "manual_pages", summary: "List available manual markdown pages", responses: makeStandardResponses() }
  },
  "/manual/page": {
    get: { operationId: "manual_page", summary: "Read one manual markdown page by path", responses: makeStandardResponses() }
  },
  "/manual/search": {
    get: { operationId: "manual_search", summary: "Search text across manual pages", responses: makeStandardResponses() }
  },
  "/tools": {
    get: { operationId: "tools_list", summary: "List available tools metadata", responses: makeStandardResponses() }
  },
  "/tools/echo": {
    post: {
      operationId: "tools_echo",
      summary: "Echo provided payload for diagnostics",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/tools/supabase/exec-sql": {
    post: {
      operationId: "tools_supabase_exec_sql",
      summary: "Execute a SQL statement against Supabase",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "object", required: ["sql"], properties: { sql: { type: "string" } } }
          }
        }
      },
      responses: makeStandardResponses()
    }
  },
  "/bruce/browser/fetch": {
    post: {
      operationId: "bruce_browser_fetch",
      summary: "Fetch remote page HTML via browser helper",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/browser/screenshot": {
    post: {
      operationId: "bruce_browser_screenshot",
      summary: "Capture a screenshot of a remote page",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/browser/scrape": {
    post: {
      operationId: "bruce_browser_scrape",
      summary: "Scrape structured content from a remote page",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/chatgpt": {
    post: {
      operationId: "bruce_chatgpt",
      summary: "Proxy a ChatGPT-style completion request",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/read": {
    post: {
      operationId: "bruce_read",
      summary: "Read data from configured backend resources",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/roadmap/list": {
    get: { operationId: "bruce_roadmap_list", summary: "List roadmap tasks and their statuses", responses: makeStandardResponses() }
  },
  "/bruce/write": {
    post: {
      operationId: "bruce_write",
      summary: "Write data to configured backend resources",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/docker/ps": {
    get: { operationId: "bruce_docker_ps", summary: "List running Docker containers", responses: makeStandardResponses() }
  },
  "/bruce/docker/inspect/{container}": {
    get: { operationId: "bruce_docker_inspect", summary: "Inspect one Docker container", responses: makeStandardResponses() }
  },
  "/bruce/docker/logs/{container}": {
    get: { operationId: "bruce_docker_logs", summary: "Read recent logs from one Docker container", responses: makeStandardResponses() }
  },
  "/bruce/docker/stats/{container}": {
    get: { operationId: "bruce_docker_stats", summary: "Read runtime stats from one Docker container", responses: makeStandardResponses() }
  },
  "/bruce/docker/restart/{container}": {
    post: { operationId: "bruce_docker_restart", summary: "Restart one Docker container", responses: makeStandardResponses() }
  },
  "/bruce/docker/stop/{container}": {
    post: { operationId: "bruce_docker_stop", summary: "Stop one Docker container", responses: makeStandardResponses() }
  },
  "/bruce/docker/start/{container}": {
    post: { operationId: "bruce_docker_start", summary: "Start one Docker container", responses: makeStandardResponses() }
  },
  "/bruce/docker/health": {
    get: { operationId: "bruce_docker_health", summary: "Get aggregated Docker health status", responses: makeStandardResponses() }
  },
  "/bruce/exec": {
    post: {
      operationId: "bruce_exec",
      summary: "Execute a command with gateway execution guardrails",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["cmd"], properties: { cmd: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/file/write": {
    post: {
      operationId: "bruce_file_write",
      summary: "Write text content to an allowed file path",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/file/read": {
    get: { operationId: "bruce_file_read", summary: "Read text content from an allowed file path", responses: makeStandardResponses() }
  },
  "/bruce/inbox/check": {
    get: { operationId: "bruce_inbox_check", summary: "Check inbox source for new items", responses: makeStandardResponses() }
  },
  "/bruce/inbox/ingest": {
    post: {
      operationId: "bruce_inbox_ingest",
      summary: "Ingest new inbox items into the system",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/archive/check": {
    get: { operationId: "bruce_archive_check", summary: "Check archive source for new items", responses: makeStandardResponses() }
  },
  "/bruce/archive/ingest": {
    post: {
      operationId: "bruce_archive_ingest",
      summary: "Ingest archived items into the system",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/health": {
    get: { operationId: "bruce_health_verbose", summary: "Get detailed BRUCE health status", responses: makeStandardResponses() }
  },
  "/bruce/state": {
    get: { operationId: "bruce_state", summary: "Get gateway runtime state snapshot", responses: makeStandardResponses() }
  },
  "/bruce/topology": {
    get: { operationId: "bruce_topology", summary: "Get current service topology overview", responses: makeStandardResponses() }
  },
  "/bruce/maintenance/run": {
    post: {
      operationId: "bruce_maintenance_run",
      summary: "Run configured maintenance workflow",
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/sync/homelab-hub": {
    post: {
      operationId: "bruce_sync_homelab_hub",
      summary: "Trigger synchronization with homelab hub",
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/integrity": {
    get: { operationId: "bruce_integrity", summary: "Run integrity checks across gateway resources", responses: makeStandardResponses() }
  },
  "/bruce/bootstrap": {
    post: {
      operationId: "bruce_bootstrap",
      summary: "Bootstrap BRUCE runtime prerequisites",
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/llm/status": {
    get: { operationId: "bruce_llm_status", summary: "Get LLM provider connectivity and status", responses: makeStandardResponses() }
  },
  "/bruce/tool-check": {
    post: {
      operationId: "bruce_tool_check",
      summary: "Validate tool availability for a given request",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/tools/rag/search": {
    post: {
      operationId: "tools_rag_search",
      summary: "Run RAG search through tools compatibility endpoint",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["q"], properties: { q: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/preflight": {
    post: {
      operationId: "bruce_preflight",
      summary: "Run preflight checks before tool or chat execution",
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/roadmap/done": {
    post: {
      operationId: "bruce_roadmap_done",
      summary: "Mark a roadmap task as completed",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/search": {
    post: {
      operationId: "bruce_search",
      summary: "Search data with scoped access control",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/session/init": {
    post: {
      operationId: "bruce_session_init",
      summary: "Initialize a new BRUCE session",
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/session/close/checklist": {
    get: { operationId: "bruce_session_close_checklist", summary: "Get checklist required before closing session", responses: makeStandardResponses() }
  },
  "/bruce/session/close": {
    post: {
      operationId: "bruce_session_close",
      summary: "Close an active BRUCE session",
      requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/staging/validate": {
    post: {
      operationId: "bruce_staging_validate",
      summary: "Validate staged changes before apply",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/staging/status": {
    get: { operationId: "bruce_staging_status", summary: "Get staging workspace status", responses: makeStandardResponses() }
  },
  "/chat": {
    post: {
      operationId: "chat",
      summary: "Run legacy BRUCE chat endpoint",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/api/openai/v1/models": {
    get: { operationId: "openai_models_api", summary: "OpenAI-compatible models endpoint alias", responses: makeStandardResponses() }
  },
  "/v1/models": {
    get: { operationId: "openai_models", summary: "OpenAI-compatible models endpoint", responses: makeStandardResponses() }
  },
  "/api/openai/v1/chat/completions": {
    post: {
      operationId: "openai_chat_completions_api",
      summary: "OpenAI-compatible chat completions endpoint alias",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/v1/chat/completions": {
    post: {
      operationId: "openai_chat_completions",
      summary: "OpenAI-compatible chat completions endpoint",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/llm/generate": {
    post: {
      operationId: "bruce_llm_generate",
      summary: "Generate completion from configured LLM",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/agent/chat": {
    post: {
      operationId: "bruce_agent_chat",
      summary: "Run BRUCE agent chat orchestration",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      responses: makeStandardResponses()
    }
  },
  "/bruce/ask": {
    post: {
      operationId: "bruce_ask",
      summary: "Ask BRUCE a direct question and get an answer",
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["question"], properties: { question: { type: "string" } } } } } },
      responses: makeStandardResponses()
    }
  }
});


app.get("/openapi.json", (req, res) => {
  // Safe to expose spec without auth; actual tool calls remain protected by gateway auth.
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(JSON.stringify(BRUCE_OPENAPI_SPEC, null, 2));
});

// [866] Healthz endpoint sans auth (pour Docker healthcheck)
app.get("/bruce/healthz", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log("MCP Gateway listening on port " + PORT);
});
