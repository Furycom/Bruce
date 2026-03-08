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
sessionRoutes.setSafePythonSpawn(safePythonSpawn);

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

app.listen(PORT, () => {
  console.log("MCP Gateway listening on port " + PORT);
});
