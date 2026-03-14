'use strict';
const fs = require('fs');
const path = require('path');
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  MANUAL_ROOT,
  BRUCE_FALLBACK_LOG_PATH,
} = require('./config');

/**
 * Returns the current UTC timestamp formatted as an ISO 8601 string.
 * @returns {string} Current date-time in ISO format.
 */
function utcNowIso() {
  return new Date().toISOString();
}

/**
 * Removes <think>...</think> blocks from a model output string.
 * @param {string} text - Raw text that may include think blocks.
 * @returns {string} Sanitized text without think blocks.
 */
function stripThinkBlock(text) {
  const t = String(text || '');
  return t.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

/**
 * Indicates whether Supabase URL and service key are configured.
 * @returns {boolean} True when both SUPABASE_URL and SUPABASE_KEY are present.
 */
function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/**
 * Appends a single line to a target file, logging write errors to stderr.
 * @param {string} pathToFile - Absolute or relative file path to append to.
 * @param {string} text - Content line to append without newline suffix.
 * @returns {void} No return value.
 */
function appendLineToFile(pathToFile, text) {
  try {
    fs.appendFile(pathToFile, text + '\n', (err) => {
      if (err) {
        console.error('Failed to append to fallback log:', err.message || err);
      }
    });
  } catch (err) {
    console.error('Fallback log write error:', err.message || err);
  }
}

/**
 * Serializes and appends a fallback log record to the configured fallback log file.
 * @param {Record<string, any>} record - Structured record to persist in the fallback log.
 * @returns {Promise<void>} Resolves when the append operation is scheduled.
 */
async function logFallback(record) {
  const line = JSON.stringify(record, null, 0);
  appendLineToFile(BRUCE_FALLBACK_LOG_PATH, line);
}

/**
 * Parses and clamps an integer value between provided minimum and maximum bounds.
 * @param {unknown} v - Raw value to parse as integer.
 * @param {number} defVal - Default value used when parsing fails.
 * @param {number} minVal - Inclusive lower bound.
 * @param {number} maxVal - Inclusive upper bound.
 * @returns {number} Parsed and clamped integer result.
 */
function bruceClampInt(v, defVal, minVal, maxVal) {
  const n = parseInt(String(v || ''), 10);
  if (!isFinite(n)) return defVal;
  return Math.max(minVal, Math.min(maxVal, n));
}

/**
 * Resolves a manual-relative path safely under MANUAL_ROOT and blocks path traversal.
 * @param {string} relativePath - Relative manual path requested by the caller.
 * @returns {string} Joined absolute path rooted under MANUAL_ROOT.
 * @throws {Error} Throws when the provided path is invalid or escapes MANUAL_ROOT.
 */
function safeJoinManual(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Invalid manual path');
  }
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(MANUAL_ROOT, normalized);

  const resolvedRoot = path.resolve(MANUAL_ROOT);
  const resolvedFull = path.resolve(fullPath);

  if (!resolvedFull.startsWith(resolvedRoot)) {
    throw new Error('Manual path escapes root directory');
  }

  return fullPath;
}

/**
 * Recursively lists Markdown files under a base directory as relative POSIX-style paths.
 * @param {string} baseDir - Root directory to crawl for markdown files.
 * @returns {string[]} Relative .md file paths discovered in the directory tree.
 */
function listMarkdownFiles(baseDir) {
  const results = [];

  function walk(currentDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        results.push(relPath);
      }
    }
  }

  walk(baseDir);
  return results;
}

/**
 * Performs a lightweight health check against a URL with timeout handling.
 * @param {string} url - Endpoint URL to ping.
 * @returns {Promise<{status: 'planned'|'ok'|'offline', httpStatus: number|null, error: string|null}>} Connectivity status payload.
 */
async function pingUrl(url) {
  if (!url) {
    return { status: 'planned', httpStatus: null, error: 'no url configured' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    // [775-P2] Ping URL as-is — do NOT append /rest/v1/
    const pingTarget = url.replace(/\/+$/, '');
    // Only send Supabase auth headers if URL matches SUPABASE_URL
    const isSupabase = SUPABASE_URL && pingTarget.startsWith(SUPABASE_URL.replace(/\/+$/, ''));
    const headers = isSupabase && SUPABASE_KEY
      ? { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
      : {};

    const response = await fetch(pingTarget, {
      method: 'GET',
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeout);

    return {
      status: response.status < 500 ? 'ok' : 'offline',
      httpStatus: response.status,
      error: null,
    };
  } catch (err) {
    return {
      status: 'offline',
      httpStatus: null,
      error: err.message || String(err),
    };
  }
}

module.exports = {
  utcNowIso,
  stripThinkBlock,
  isSupabaseConfigured,
  appendLineToFile,
  logFallback,
  bruceClampInt,
  safeJoinManual,
  listMarkdownFiles,
  pingUrl,
};
