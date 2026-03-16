'use strict';
const path = require('path');

// Configuration
const PORT = process.env.PORT || 4000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const EMBEDDER_URL = process.env.EMBEDDER_URL || 'http://192.168.2.85:8081';
const LITELLM_URL = process.env.LITELLM_URL || 'http://192.168.2.230:4100';
const VALIDATE_SERVICE_URL =
  process.env.VALIDATE_SERVICE_URL || 'http://172.18.0.1:4001';
const VALIDATE_PUBLIC_URL =
  process.env.VALIDATE_PUBLIC_URL || 'http://192.168.2.230:4001';
const INBOX_RUNNER_URL =
  process.env.INBOX_RUNNER_URL || 'http://172.18.0.1:4002/inbox/ingest';
const BROWSERLESS_URL =
  process.env.BROWSERLESS_URL || 'http://192.168.2.174:3000';
const MCP_PLAYWRIGHT_URL =
  process.env.MCP_PLAYWRIGHT_URL || 'http://192.168.2.174:5678';
const LOCAL_LLM_URL = process.env.LOCAL_LLM_URL || 'http://192.168.2.32:8000';
const VLLM_INTERNAL_URL = process.env.VLLM_INTERNAL_URL || 'http://172.18.0.1:4100';
const PULSE_URL = process.env.PULSE_URL || 'http://192.168.2.154:7655';
const LOOPBACK_BASE_URL = process.env.LOOPBACK_BASE_URL || 'http://127.0.0.1';
const GATEWAY_PUBLIC_URL =
  process.env.GATEWAY_PUBLIC_URL || 'http://192.168.2.230:4000';
const SUPABASE_REST_FALLBACK_URL =
  process.env.SUPABASE_REST_FALLBACK_URL || 'http://192.168.2.146:8000/rest/v1';
const MANUAL_ROOT = process.env.MANUAL_ROOT || '/manual-docs';

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
  LITELLM_URL,
  VALIDATE_SERVICE_URL,
  VALIDATE_PUBLIC_URL,
  INBOX_RUNNER_URL,
  BROWSERLESS_URL,
  MCP_PLAYWRIGHT_URL,
  LOCAL_LLM_URL,
  VLLM_INTERNAL_URL,
  PULSE_URL,
  LOOPBACK_BASE_URL,
  GATEWAY_PUBLIC_URL,
  SUPABASE_REST_FALLBACK_URL,
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
