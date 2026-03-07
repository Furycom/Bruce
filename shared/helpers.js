'use strict';
const fs = require('fs');
const path = require('path');
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  MANUAL_ROOT,
  BRUCE_FALLBACK_LOG_PATH,
} = require('./config');

function utcNowIso() {
  return new Date().toISOString();
}

function stripThinkBlock(text) {
  const t = String(text || '');
  return t.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

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

async function logFallback(record) {
  const line = JSON.stringify(record, null, 0);
  appendLineToFile(BRUCE_FALLBACK_LOG_PATH, line);
}

function bruceClampInt(v, defVal, minVal, maxVal) {
  const n = parseInt(String(v || ''), 10);
  if (!isFinite(n)) return defVal;
  return Math.max(minVal, Math.min(maxVal, n));
}

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
