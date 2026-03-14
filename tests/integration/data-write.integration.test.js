'use strict';

const request = require('supertest');
const express = require('express');

function buildDataWriteApp() {
  jest.resetModules();
  jest.doMock('../../shared/fetch-utils', () => ({
    fetchWithTimeout: jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [{ id: 123 }],
      text: async () => '',
    })),
  }));

  const router = require('../../routes/data-write');
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('Integration - /bruce/write', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BRUCE_AUTH_TOKEN: 'good-token',
      SUPABASE_URL: 'http://supabase.local',
      SUPABASE_KEY: 'service-key',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.dontMock('../../shared/fetch-utils');
    jest.clearAllMocks();
  });

  test('POST /bruce/write sans token → 401', async () => {
    const app = buildDataWriteApp();

    const res = await request(app).post('/bruce/write').send({});

    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  test('POST /bruce/write avec body incomplet → 400', async () => {
    const app = buildDataWriteApp();

    const res = await request(app)
      .post('/bruce/write')
      .set('Authorization', 'Bearer good-token')
      .send({ table_cible: 'lessons_learned' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
