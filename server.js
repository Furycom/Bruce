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

const { BRUCE_OPENAPI_SPEC } = require('./shared/openapi');


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
