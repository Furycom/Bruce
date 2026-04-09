/**
 * routes/crossseed.js — S1459 v6 FINAL: progression live
 * Config: /mnt/qbits/config/cross-seed/config.js on .123
 */
const express = require('express');
const router = express.Router();
const { execFile } = require('child_process');

const CS_HOST = '192.168.2.123';
const SSH_KEY = process.env.BRUCE_SSH_KEY_PATH || '/home/node/.ssh/id_ed25519';
const CONFIG_PATH = '/mnt/qbits/config/cross-seed/config.js';

function sshExec(cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=6',
      '-i', SSH_KEY, `yann@${CS_HOST}`, cmd];
    execFile('ssh', args, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}
function shEsc(s) { return s.replace(/'/g, "'\\''"); }

router.get('/bruce/crossseed/status', async (req, res) => {
  try {
    const raw = await sshExec(`docker exec cross-seed cross-seed search --help 2>/dev/null | grep -A1 'data-dirs'`);
    const dirMatch = raw.match(/\[([^\]]+)\]/);
    let dataDirs = [];
    if (dirMatch) dataDirs = dirMatch[1].split(',').map(d => d.trim().replace(/"/g, ''));

    // Check if search process is running
    const psOut = await sshExec(`docker exec cross-seed pgrep -f 'cross-seed search' 2>/dev/null | wc -l`);
    const scanning = parseInt(psOut) > 0;

    // Get scan progress from logs
    let scanProgress = null;
    if (scanning) {
      const logData = await sshExec(`docker logs cross-seed --tail 200 2>&1 | grep -E '\\[search\\]|Validated|Found.*on.*by' | tail -50`);
      const lines = logData.split('\n').filter(l => l.trim());
      // Count search results and extract total from Validated line
      const validatedMatch = logData.match(/Validated (\d+) entries/);
      const totalEntries = validatedMatch ? parseInt(validatedMatch[1]) : 0;
      // Count unique searches done (Found lines = matches found during search)
      const searchLines = lines.filter(l => l.includes('[search]'));
      const foundLines = lines.filter(l => l.includes('Found'));
      // Get last activity timestamp
      const lastLine = lines[lines.length - 1] || '';
      const tsMatch = lastLine.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      scanProgress = {
        totalEntries,
        searchActions: searchLines.length,
        matchesFound: foundLines.length,
        lastActivity: tsMatch ? tsMatch[1] : null,
        lastLog: lastLine.replace(/\x1b\[[0-9;]*m/g, '').substring(0, 120),
      };
    }

    // Recent activity (last 5 log lines, cleaned)
    const recentRaw = await sshExec(`docker logs cross-seed --tail 5 2>&1`);
    const recentLogs = recentRaw.split('\n').map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(l => l);

    res.json({ ok: true, dataDirs, scanning, scanProgress, recentLogs });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/bruce/crossseed/scan', async (req, res) => {
  try {
    await sshExec(`docker exec -d cross-seed cross-seed search`, 10000);
    res.json({ ok: true, message: 'Scan lancé en arrière-plan' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/bruce/crossseed/browse', async (req, res) => {
  try {
    const dir = req.query.dir || '/mnt/qbits/downloads';
    if (!dir.startsWith('/mnt/qbits')) return res.status(400).json({ ok: false, error: 'Chemin non autorisé' });
    const raw = await sshExec(`find '${shEsc(dir)}' -maxdepth 1 -type d 2>/dev/null | sort`);
    const dirs = raw.split('\n').filter(d => d && d !== dir).map(d => ({ path: d, name: d.split('/').pop() }));
    res.json({ ok: true, current: dir, dirs });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/bruce/crossseed/add-dir', async (req, res) => {
  try {
    const { dir } = req.body;
    if (!dir || !dir.startsWith('/mnt/qbits')) return res.status(400).json({ ok: false, error: 'Chemin invalide' });
    const exists = await sshExec(`test -d '${shEsc(dir)}' && echo YES || echo NO`);
    if (exists !== 'YES') return res.status(400).json({ ok: false, error: 'Dossier inexistant sur .123' });
    const configContent = await sshExec(`cat '${CONFIG_PATH}'`);
    if (configContent.includes(dir)) return res.json({ ok: true, message: 'Dossier déjà configuré' });
    await sshExec(`cp '${CONFIG_PATH}' '${CONFIG_PATH}.bak'`);
    const insertScript = `import re\nwith open('${CONFIG_PATH}','r') as f: c=f.read()\nnd='${dir.replace(/'/g,"\\'")}'\np=r'(dataDirs:\\\\s*\\\\[.*?)(\\\\])'\ndef r(m):\n e=m.group(1).rstrip()\n if not e.endswith(','): e+=','\n return e+'\\n        \"'+nd+'\"\\n    ]'\nnc=re.sub(p,r,c,flags=re.DOTALL)\nif nd in nc:\n with open('${CONFIG_PATH}','w') as f: f.write(nc)\n print('ADDED')\nelse: print('FAILED')`;
    const result = await sshExec(`python3 -c '${shEsc(insertScript)}'`, 10000);
    if (result.includes('ADDED')) {
      await sshExec(`docker restart cross-seed`, 20000);
      return res.json({ ok: true, message: '"' + dir.split('/').pop() + '" ajouté, cross-seed redémarré' });
    }
    res.status(500).json({ ok: false, error: 'Échec insertion: ' + result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
