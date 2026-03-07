'use strict';
const crypto = require('crypto');
const { BRUCE_AUTH_TOKEN, SUPABASE_URL, SUPABASE_KEY } = require('./config');

// ── In-memory token cache (refreshed every 5 min) ──
let _tokenCache = [];
let _tokenCacheAt = 0;
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
let _loadingPromise = null;

function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** Background token loader — never blocks callers */
function refreshTokenCache() {
  const now = Date.now();
  if ((now - _tokenCacheAt) < TOKEN_CACHE_TTL_MS) return;
  if (_loadingPromise) return; // already loading
  if (!SUPABASE_URL || !SUPABASE_KEY) return;

  _loadingPromise = (async () => {
    try {
      const url = `${SUPABASE_URL}/bruce_api_tokens?active=eq.true&select=token_hash,client_type,scopes,rate_limit_rpm`;
      const res = await fetch(url, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        _tokenCache = await res.json();
        _tokenCacheAt = Date.now();
      }
    } catch { /* keep stale cache */ }
    _loadingPromise = null;
  })();
}

// Load tokens on startup
refreshTokenCache();
// Periodic refresh
setInterval(refreshTokenCache, TOKEN_CACHE_TTL_MS);

// ── Rate limiter (sliding window per token_hash) ──
const _rateBuckets = new Map();

function checkRateLimit(tokenHash, rpm) {
  const now = Date.now();
  const windowMs = 60000;
  if (!_rateBuckets.has(tokenHash)) _rateBuckets.set(tokenHash, []);
  const bucket = _rateBuckets.get(tokenHash).filter(t => t > now - windowMs);
  _rateBuckets.set(tokenHash, bucket);
  if (bucket.length >= rpm) return false;
  bucket.push(now);
  return true;
}

/**
 * Validate auth + resolve scopes. SYNCHRONOUS — safe for all handlers.
 * Returns { ok, client_type?, scopes?, status?, error? }
 *
 * Usage:
 *   const auth = validateBruceAuth(req);           // basic auth check (backward compat)
 *   const auth = validateBruceAuth(req, 'docker');  // auth + scope check
 */
function validateBruceAuth(req, requiredScope) {
  // ── Extract token from headers ──
  const authHeader = String(req.headers.authorization || '');
  const tokenFromBearer = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim() : '';
  const tokenFromLegacy = String(req.headers['x-bruce-token'] || '').trim();
  const raw = tokenFromBearer || tokenFromLegacy;

  if (!raw) {
    return { ok: false, status: 401, error: 'Missing auth token (Authorization: Bearer ... or X-BRUCE-TOKEN)' };
  }

  // ── Try multi-token lookup (cache is loaded in background) ──
  if (_tokenCache.length > 0) {
    const h = hashToken(raw);
    const match = _tokenCache.find(t => t.token_hash === h);
    if (match) {
      // Rate limit check
      if (!checkRateLimit(h, match.rate_limit_rpm || 60)) {
        return { ok: false, status: 429, error: `Rate limit exceeded (${match.rate_limit_rpm} rpm)` };
      }
      // Scope check
      if (requiredScope && !match.scopes.includes(requiredScope) && !match.scopes.includes('admin')) {
        return { ok: false, status: 403, error: `Scope '${requiredScope}' not allowed for client '${match.client_type}'` };
      }
      // Fire-and-forget: update last_used
      if (SUPABASE_URL && SUPABASE_KEY) {
        fetch(`${SUPABASE_URL}/bruce_api_tokens?token_hash=eq.${h}`, {
          method: 'PATCH',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ last_used: new Date().toISOString() }),
        }).catch(() => {});
      }
      return { ok: true, client_type: match.client_type, scopes: match.scopes };
    }
  }

  // ── Fallback: legacy single-token comparison (always works, even if cache empty) ──
  if (BRUCE_AUTH_TOKEN && raw === BRUCE_AUTH_TOKEN) {
    return { ok: true, client_type: 'legacy', scopes: ['read','write','docker','exec','admin'] };
  }

  // ── Trigger cache refresh in case it hasn't loaded yet ──
  refreshTokenCache();

  return { ok: false, status: 401, error: 'Invalid auth token' };
}

/**
 * Express middleware factory: require scope on a route.
 * Usage: app.use('/bruce/docker', requireScope('docker'));
 */
function requireScope(scope) {
  return (req, res, next) => {
    const auth = validateBruceAuth(req, scope);
    if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });
    req.bruceAuth = auth;
    next();
  };
}

module.exports = { validateBruceAuth, requireScope, hashToken };