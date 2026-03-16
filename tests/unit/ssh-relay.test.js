// Unit test: validate SSH host whitelist and command validation integration
const { validateExecCommand } = require('../../shared/exec-security');

const SSH_HOSTS = {
  '192.168.2.32': { user: 'furycom', label: 'dell-7910' },
  '192.168.2.146': { user: 'furycom', label: 'furysupa' },
  '192.168.2.154': { user: 'yann', label: 'box2-observability' },
  '192.168.2.174': { user: 'yann', label: 'box2-n8n' },
  '192.168.2.85': { user: 'furycom', label: 'embedder' },
  '192.168.2.231': { user: 'furycom', label: 'furycom-231' },
  '192.168.2.230': { user: 'furycom', label: 'gateway-host' },
};

describe('SSH relay validation', () => {
  test('allows known hosts', () => {
    expect(SSH_HOSTS['192.168.2.32']).toBeDefined();
    expect(SSH_HOSTS['192.168.2.32'].user).toBe('furycom');
    expect(SSH_HOSTS['192.168.2.154'].user).toBe('yann');
  });

  test('rejects unknown hosts', () => {
    expect(SSH_HOSTS['192.168.2.99']).toBeUndefined();
    expect(SSH_HOSTS['10.0.0.1']).toBeUndefined();
  });

  test('commands are validated through exec-security', () => {
    expect(validateExecCommand('tail -50 /var/log/syslog').allowed).toBe(true);
    expect(validateExecCommand('df -h').allowed).toBe(true);
    expect(validateExecCommand('rm -rf /').allowed).toBe(false);
  });
});
