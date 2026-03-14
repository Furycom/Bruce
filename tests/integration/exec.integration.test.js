'use strict';

const request = require('supertest');
const express = require('express');

function buildExecApp() {
  jest.resetModules();
  const router = require('../../routes/exec');
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

describe('Integration - /bruce/exec', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      BRUCE_AUTH_TOKEN: 'good-token',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test('POST /bruce/exec sans token → 401', async () => {
    const app = buildExecApp();

    const res = await request(app).post('/bruce/exec').send({ command: 'hostname' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
  });

  test('POST /bruce/exec avec commande non whitelistée → 400/403', async () => {
    const app = buildExecApp();

    const res = await request(app)
      .post('/bruce/exec')
      .set('Authorization', 'Bearer good-token')
      .send({ command: 'rm -rf /tmp/test' });

    expect([400, 403]).toContain(res.status);
    expect(res.body.ok).toBe(false);
  });

  test('POST /bruce/exec sans champ command → 400', async () => {
    const app = buildExecApp();

    const res = await request(app)
      .post('/bruce/exec')
      .set('Authorization', 'Bearer good-token')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
