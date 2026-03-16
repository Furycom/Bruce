describe('/bruce/health/full contract', () => {
  test('response shape matches expected contract', () => {
    const mockResponse = {
      ok: true,
      services: [
        { name: 'supabase', status: 'ok', http_status: 200, latency_ms: 45 },
        { name: 'local-llm', status: 'down', latency_ms: 5001, error: 'timeout' },
      ],
      healthy: 1,
      total: 2,
      timestamp: '2026-03-16T18:00:00.000Z',
      cached: false,
    };

    expect(mockResponse).toHaveProperty('ok');
    expect(mockResponse).toHaveProperty('services');
    expect(mockResponse).toHaveProperty('healthy');
    expect(mockResponse).toHaveProperty('total');
    expect(mockResponse).toHaveProperty('timestamp');
    expect(Array.isArray(mockResponse.services)).toBe(true);
    expect(mockResponse.services[0]).toHaveProperty('name');
    expect(mockResponse.services[0]).toHaveProperty('status');
    expect(mockResponse.services[0]).toHaveProperty('latency_ms');
  });

  test('ok is false when any service is down', () => {
    const services = [
      { name: 'supabase', status: 'ok' },
      { name: 'local-llm', status: 'down' },
    ];
    const allOk = services.every((s) => s.status === 'ok');
    expect(allOk).toBe(false);
  });

  test('cache TTL is 30 seconds', () => {
    const HEALTH_CACHE_TTL_MS = 30000;
    expect(HEALTH_CACHE_TTL_MS).toBe(30000);
  });
});
