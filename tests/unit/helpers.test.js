'use strict';

const path = require('path');

describe('shared/helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.MANUAL_ROOT = '/manual-root';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('safeJoinManual blocks path traversal attempts', () => {
    const { safeJoinManual } = require('../../shared/helpers');

    expect(() => safeJoinManual('../../etc/passwd')).toThrow('Manual path escapes root directory');
    expect(() => safeJoinManual('..\\..\\windows\\system32')).toThrow('Manual path escapes root directory');
  });

  test('safeJoinManual returns a path inside MANUAL_ROOT for safe relative paths', () => {
    const { safeJoinManual } = require('../../shared/helpers');

    const result = safeJoinManual('guides/getting-started.md');
    expect(path.resolve(result).startsWith(path.resolve('/manual-root'))).toBe(true);
    expect(result).toContain(path.join('guides', 'getting-started.md'));
  });

  test('bruceClampInt enforces min, max and default values', () => {
    const { bruceClampInt } = require('../../shared/helpers');

    expect(bruceClampInt('42', 10, 1, 100)).toBe(42);
    expect(bruceClampInt('-5', 10, 1, 100)).toBe(1);
    expect(bruceClampInt('1000', 10, 1, 100)).toBe(100);
    expect(bruceClampInt('not-a-number', 10, 1, 100)).toBe(10);
    expect(bruceClampInt(undefined, 10, 1, 100)).toBe(10);
  });
});
