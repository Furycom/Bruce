'use strict';

const { validateExecCommand } = require('../../shared/exec-security');

describe('shared/exec-security validateExecCommand', () => {
  test('allows commands matching whitelist', () => {
    expect(validateExecCommand('docker ps')).toEqual({ allowed: true });
    expect(validateExecCommand('curl -s https://example.com')).toEqual({ allowed: true });
    expect(validateExecCommand('hostname')).toEqual({ allowed: true });
  });

  test('rejects commands matching blacklist', () => {
    const result = validateExecCommand('docker ps && rm -rf /');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Blocked by blacklist/);
  });

  test('blacklist takes priority over whitelist', () => {
    const result = validateExecCommand('curl -s https://example.com && reboot');

    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Blocked by blacklist/);
  });
});
