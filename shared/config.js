'use strict';
const path = require('path');

// Configuration
const PORT = process.env.PORT || 4000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const EMBEDDER_URL = process.env.EMBEDDER_URL || 'http://192.168.2.85:8081';
const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL || 'http://192.168.2.32:8000';
const LITELLM_URL = process.env.LITELLM_URL || 'http://192.168.2.230:4100';
const VALIDATE_SERVICE_URL = process.env.VALIDATE_SERVICE_URL || 'http://172.18.0.1:4001';
const VALIDATE_SERVICE_PUBLIC_URL = process.env.VALIDATE_SERVICE_PUBLIC_URL || 'http://192.168.2.230:4001';
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || 'http://192.168.2.174:3000';
const N8N_URL = process.env.N8N_URL || 'http://192.168.2.174:5678';
const BRUCE_RUNNER_URL = process.env.BRUCE_RUNNER_URL || 'http://172.18.0.1:4002';
const SUPABASE_FALLBACK_URL = process.env.SUPABASE_FALLBACK_URL || 'http://192.168.2.146:8000/rest/v1';
const GATEWAY_LOOPBACK_URL = process.env.GATEWAY_LOOPBACK_URL || `http://127.0.0.1:${PORT}`;
const MCP_GATEWAY_PUBLIC_URL = process.env.MCP_GATEWAY_PUBLIC_URL || 'http://192.168.2.230:4000';
const MANUAL_ROOT = process.env.MANUAL_ROOT || '/manual-docs';

/*
 * Infrastructure URLs
 * - EMBEDDER_URL: embedding service (default: http://192.168.2.85:8081)
 * - LLAMA_SERVER_URL: local llama.cpp/vLLM-compatible server (default: http://192.168.2.32:8000)
 * - LITELLM_URL: LiteLLM proxy service (default: http://192.168.2.230:4100)
 * - VALIDATE_SERVICE_URL: validation worker service (default: http://172.18.0.1:4001)
 * - VALIDATE_SERVICE_PUBLIC_URL: public-facing validation service URL (default: http://192.168.2.230:4001)
 * - BROWSERLESS_URL: browser automation service (default: http://192.168.2.174:3000)
 * - N8N_URL: n8n automation service (default: http://192.168.2.174:5678)
 * - BRUCE_RUNNER_URL: inbox ingestion runner service (default: http://172.18.0.1:4002)
 * - SUPABASE_FALLBACK_URL: fallback Supabase REST URL (default: http://192.168.2.146:8000/rest/v1)
 * - GATEWAY_LOOPBACK_URL: internal gateway loopback URL (default: http://127.0.0.1:${PORT})
 * - MCP_GATEWAY_PUBLIC_URL: public gateway URL used in docs/examples (default: http://192.168.2.230:4000)
 */

// Bruce configuration
const BRUCE_AUTH_TOKEN = process.env.BRUCE_AUTH_TOKEN || '';
const BRUCE_LLM_API_BASE = process.env.BRUCE_LLM_API_BASE || '';
const BRUCE_LLM_MODEL = process.env.BRUCE_LLM_MODEL || '';
const BRUCE_LLM_API_KEY = process.env.BRUCE_LLM_API_KEY || '';
const BRUCE_LITELLM_KEY = process.env.BRUCE_LITELLM_KEY || '';
const BRUCE_MAX_MESSAGE_CHARS = parseInt(
  process.env.BRUCE_MAX_MESSAGE_CHARS || '8000',
  10
);
const BRUCE_LLM_TIMEOUT_MS = parseInt(
  process.env.BRUCE_LLM_TIMEOUT_MS || '15000',
  10
);
const BRUCE_MAX_CONCURRENT = parseInt(
  process.env.BRUCE_MAX_CONCURRENT || '3',
  10
);
const BRUCE_FALLBACK_LOG_PATH =
  process.env.BRUCE_FALLBACK_LOG_PATH ||
  path.join(__dirname, '..', 'bruce-fallback.log');
const BRUCE_SOURCE_DEFAULT =
  process.env.BRUCE_SOURCE_DEFAULT || 'openwebui';

// Paths
const CONNECTORS_PATH = path.join(__dirname, '..', 'connectors.json');

module.exports = {
  PORT,
  SUPABASE_URL,
  SUPABASE_KEY,
  EMBEDDER_URL,
  LLAMA_SERVER_URL,
  LITELLM_URL,
  VALIDATE_SERVICE_URL,
  VALIDATE_SERVICE_PUBLIC_URL,
  BROWSERLESS_URL,
  N8N_URL,
  BRUCE_RUNNER_URL,
  SUPABASE_FALLBACK_URL,
  GATEWAY_LOOPBACK_URL,
  MCP_GATEWAY_PUBLIC_URL,
  MANUAL_ROOT,
  BRUCE_AUTH_TOKEN,
  BRUCE_LLM_API_BASE,
  BRUCE_LLM_MODEL,
  BRUCE_LLM_API_KEY,
  BRUCE_LITELLM_KEY,
  BRUCE_MAX_MESSAGE_CHARS,
  BRUCE_LLM_TIMEOUT_MS,
  BRUCE_MAX_CONCURRENT,
  BRUCE_FALLBACK_LOG_PATH,
  BRUCE_SOURCE_DEFAULT,
  CONNECTORS_PATH,
};
