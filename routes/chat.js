// routes/chat.js — [773] C7 REFONTE
// Routes: /bruce/config/llm, /bruce/llm/models, /bruce/llm/chat,
//         /bruce/llm/generate, /chat, OpenAI compat, /bruce/agent/chat
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const { validateBruceAuth } = require('../shared/auth');
const {
  SUPABASE_URL, SUPABASE_KEY, BRUCE_LLM_API_BASE, BRUCE_LLM_API_KEY,
  BRUCE_LLM_MODEL, BRUCE_LLM_TIMEOUT_MS, BRUCE_MAX_MESSAGE_CHARS,
  BRUCE_SOURCE_DEFAULT, EMBEDDER_URL
} = require('../shared/config');
const { utcNowIso, logFallback, stripThinkBlock } = require('../shared/helpers');
const { insertMemoryEvent, insertConversationMessage } = require('../shared/supabase-client');
const { callLlm } = require('../shared/llm-queue');
const { fetchWithTimeout } = require('../shared/fetch-utils');
const { bruceRagContext } = require('./rag');

// --- LLM PROXY HELPERS ---

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


// --- ROUTE HANDLERS ---

// GET /bruce/config/llm
router.get("/bruce/config/llm", (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error || "Unauthorized" });

  return res.json({
    ok: true,
    base: BRUCE_LLM_API_BASE || null,
    model: BRUCE_LLM_MODEL || null
  });
});

// /bruce/llm/models
  router.get("/bruce/llm/models", async (req, res) => {
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

// /bruce/llm/chat
  router.post("/bruce/llm/chat", async (req, res) => {
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

// --- OPENAI COMPAT ---
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

  router.get('/api/openai/v1/models', openaiModelsHandler);
  router.get('/v1/models', openaiModelsHandler);

  router.post('/api/openai/v1/chat/completions', openaiChatCompletionsHandler);
  router.post('/v1/chat/completions', openaiChatCompletionsHandler);

// --- /bruce/llm/generate ---
router.post('/bruce/llm/generate', async (req, res) => {
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

// --- /chat ---
router.post('/chat', async (req, res) => {
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

// --- AGENT SYSTEM ---
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
router.post("/bruce/agent/chat", async (req, res) => {
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

module.exports = router;
