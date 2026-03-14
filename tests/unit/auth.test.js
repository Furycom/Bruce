'use strict';

const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

describe('shared/auth validateBruceAuth', () => {
  const originalEnv = process.env;
  let setIntervalSpy;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
    process.env = originalEnv;
    delete global.fetch;
  });

  test('extracts token from Authorization Bearer header (legacy token)', () => {
    process.env.BRUCE_AUTH_TOKEN = 'legacy-token';
    global.fetch = jest.fn();

    const { validateBruceAuth } = require('../../shared/auth');
    const result = validateBruceAuth({
      headers: { authorization: 'Bearer legacy-token' },
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        client_type: 'legacy',
      })
    );
  });

  test('extracts token from x-bruce-token header (legacy token)', () => {
    process.env.BRUCE_AUTH_TOKEN = 'legacy-token';
    global.fetch = jest.fn();

    const { validateBruceAuth } = require('../../shared/auth');
    const result = validateBruceAuth({
      headers: { 'x-bruce-token': 'legacy-token' },
    });

    expect(result.ok).toBe(true);
    expect(result.client_type).toBe('legacy');
  });

  test('rejects when token is missing', () => {
    process.env.BRUCE_AUTH_TOKEN = 'legacy-token';
    global.fetch = jest.fn();

    const { validateBruceAuth } = require('../../shared/auth');
    const result = validateBruceAuth({ headers: {} });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, status: 401 })
    );
    expect(result.error).toMatch(/Missing auth token/);
  });

  test('rejects when token is invalid', () => {
    process.env.BRUCE_AUTH_TOKEN = 'legacy-token';
    global.fetch = jest.fn();

    const { validateBruceAuth } = require('../../shared/auth');
    const result = validateBruceAuth({
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect(result).toEqual(
      expect.objectContaining({ ok: false, status: 401, error: 'Invalid auth token' })
    );
  });

  test('enforces per-token rate limiting from cached token metadata', async () => {
    process.env.BRUCE_AUTH_TOKEN = '';
    process.env.SUPABASE_URL = 'https://supabase.local';
    process.env.SUPABASE_KEY = 'service-key';

    const rawToken = 'cache-token';
    const tokenHash = sha256(rawToken);

    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).includes('/bruce_api_tokens?active=eq.true')) {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              token_hash: tokenHash,
              client_type: 'service',
              scopes: ['read'],
              rate_limit_rpm: 2,
            },
          ],
        });
      }

      if (options.method === 'PATCH') {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }

      return Promise.resolve({ ok: false, json: async () => [] });
    });

    const { validateBruceAuth } = require('../../shared/auth');

    // Let the startup background token refresh resolve.
    await Promise.resolve();
    await Promise.resolve();

    const req = { headers: { authorization: `Bearer ${rawToken}` } };
    const first = validateBruceAuth(req);
    const second = validateBruceAuth(req);
    const third = validateBruceAuth(req);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual(
      expect.objectContaining({ ok: false, status: 429 })
    );
    expect(third.error).toMatch(/Rate limit exceeded/);
  });
});
