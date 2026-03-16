// Unit test: validate SSH host whitelist and command validation integration
const { validateExecCommand } = require('../../shared/exec-security');
const { BRUCE_SSH_HOSTS } = require('../../shared/config');

describe('SSH relay validation', () => {
  test('allows known hosts', () => {
    expect(BRUCE_SSH_HOSTS['192.168.2.32']).toBeDefined();
    expect(BRUCE_SSH_HOSTS['192.168.2.32'].user).toBe('furycom');
    expect(BRUCE_SSH_HOSTS['192.168.2.154'].user).toBe('yann');
  });

  test('rejects unknown hosts', () => {
    expect(BRUCE_SSH_HOSTS['192.168.2.99']).toBeUndefined();
    expect(BRUCE_SSH_HOSTS['10.0.0.1']).toBeUndefined();
  });

  test('commands are validated through exec-security', () => {
    expect(validateExecCommand('tail -50 /var/log/syslog').allowed).toBe(true);
    expect(validateExecCommand('df -h').allowed).toBe(true);
    expect(validateExecCommand('rm -rf /').allowed).toBe(false);
  });
});
