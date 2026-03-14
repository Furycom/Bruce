'use strict';

const request = require('supertest');
const express = require('express');

function buildInfraApp(fetchImpl) {
  jest.resetModules();
  jest.doMock('../../shared/fetch-utils', () => ({
    fetchWithTimeout: jest.fn(fetchImpl),
  }));

  const router = require('../../routes/infra');
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('Integration - auth on /bruce/integrity', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BRUCE_AUTH_TOKEN: 'good-token',
      SUPABASE_URL: 'http://supabase.local',
      SUPABASE_KEY: 'service-key',
      BRUCE_LLM_API_KEY: 'llm-key',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.dontMock('../../shared/fetch-utils');
    jest.clearAllMocks();
  });

  test('GET /bruce/integrity sans token → 401', async () => {
    const app = buildInfraApp(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));

    const res = await request(app).get('/bruce/integrity');

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  test('GET /bruce/integrity avec mauvais token → 401', async () => {
    const app = buildInfraApp(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));

    const res = await request(app)
      .get('/bruce/integrity')
      .set('Authorization', 'Bearer wrong-token');

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  test('GET /bruce/integrity avec bon token → 200 (logique interne mockée)', async () => {
    const app = buildInfraApp(async (url) => {
      const u = String(url);
      if (u.includes('/v_bruce_dashboard')) {
        return { ok: true, status: 200, json: async () => [{ id: 1 }] };
      }
      if (u.includes('/staging_queue?status=eq.pending')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (u.includes('/rpc/check_sequences')) {
        return { ok: true, status: 200, json: async () => [{ status: 'OK' }] };
      }
      if (u.includes('/health')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const res = await request(app)
      .get('/bruce/integrity')
      .set('Authorization', 'Bearer good-token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true }));
    expect(res.body.checks).toBeDefined();
  });
});
