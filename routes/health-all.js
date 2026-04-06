'use strict';
const { Router } = require('express');
const { validateBruceAuth } = require('../shared/auth');
const { BRUCE_SSH_KEY_PATH, BRUCE_SSH_HOSTS, SUPABASE_URL, SUPABASE_KEY, PORT } = require('../shared/config');
const { execFile } = require('child_process');
const { fetchWithTimeout } = require('../shared/fetch-utils');
const https = require('https');
const insecureAgent = new https.Agent({ rejectUnauthorized: false });
const router = Router();

// [S1444] Set TLS globally ONCE — fixes Portainer/Cloudflare race condition
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DESC = {
  'furycom (.230)': 'Serveur principal qui orchestre tout BRUCE — gateway, screensaver, LightRAG',
  'Dell 7910 (.32)': 'Machine avec GPU pour les modèles d\'intelligence artificielle locale',
  'Proxmox Box1 (.58)': 'Hyperviseur qui héberge les VMs Supabase, Embedder et Rotki',
  'Proxmox Box2 (.103)': 'Hyperviseur qui héberge 8 VMs de services (automation, media, etc.)',
  'TrueNAS (.60)': 'Serveur de stockage — 22TB RAIDZ2, backups, médias',
  'Home Assistant (.248)': 'Domotique — contrôle les appareils connectés, sonnettes, caméras',
  'Furycom PC (.190)': 'Ordinateur personnel de Yann',
  'Embedder (.85)': 'Transforme le texte en vecteurs pour la recherche sémantique',
  'Supabase (.146)': 'Base de données PostgreSQL — la mémoire permanente de BRUCE',
  'box2-daily (.12)': 'VM qui héberge le dashboard BRUCE + services quotidiens',
  'box2-automation (.174)': 'VM n8n — automatisation des workflows et tâches planifiées',
  'box2-observability (.154)': 'VM surveillance — Pulse, Langfuse, métriques',
  'box2-media (.123)': 'VM médias — qBittorrent, téléchargements, catégories',
  'box2-edge (.87)': 'VM services edge',
  'box2-docs (.113)': 'VM documentation',
  'box2-tube (.173)': 'VM médias vidéo',
  'box2-secrets (.249)': 'VM Vaultwarden — gestionnaire de mots de passe',
  'Rotki (.231)': 'VM suivi finances et crypto',
  'MCP Gateway': 'Point d\'entrée unique de BRUCE — route toutes les requêtes',
  'Supabase API': 'API REST pour lire/écrire dans la base de données',
  'LLM Router': 'Routeur de modèles IA — charge/décharge automatiquement selon la demande',
  'LiteLLM': 'Proxy LLM utilisé par LightRAG comme backend',
  'Embedder API': 'API d\'embeddings BGE-m3 pour la recherche sémantique',
  'n8n': 'Moteur d\'automatisation — backup quotidien, watchdog screensaver',
  'Validate Service': 'Gates de qualité — vérifie les données avant insertion',
  'LightRAG': 'Graphe de connaissances — relie les concepts entre eux',
  'OpenWebUI': 'Interface web pour discuter avec les LLM locaux',
  'Forgejo': 'Forge Git locale — versionnement du code',
  'Pulse': 'Monitoring infrastructure — alertes et métriques',
  'Langfuse': 'Observabilité LLM — trace les appels aux modèles',
  'Portainer': 'Gestion visuelle des containers Docker',
  'Uptime Kuma': 'Surveillance uptime de tous les services',
  'TrueNAS WebUI': 'Interface web du NAS — pools, disques, partages',
  'Home Assistant': 'Interface domotique — scènes, automatisations maison',
  'Termix': 'Terminal web distant',
  'qBittorrent': 'Client torrent avec catégories automatiques',
  'Rotki': 'Suivi de portefeuille crypto et finances',
  'Dashboard BRUCE': 'Ce dashboard — vue d\'ensemble du homelab',
  'Cloudflare AI': 'Accès public à OpenWebUI via tunnel Cloudflare',
  'Koffan': 'Site web Koffan',
  'FreshRSS': 'Agrégateur de flux RSS',
  'Readeck': 'Sauvegarde d\'articles web pour lecture ultérieure',
  'Maloja': 'Statistiques d\'écoute musicale (scrobbling)',
  'SnappyMail': 'Client email web léger',
  'Multi-Scrobbler': 'Pont entre sources musicales et Maloja',
  'Tandoor': 'Gestionnaire de recettes de cuisine',
  'Tracktor': 'Suivi de séries TV et films',
};

// [1451] Fix: Embedder .85 is PHYSICAL (bare metal), not a VM
const PHYSICAL = [
  { name: 'furycom (.230)', ip: '192.168.2.230', role: 'MCP Gateway + Screensaver', check: 'ping' },
  { name: 'Dell 7910 (.32)', ip: '192.168.2.32', role: 'LLM Inference GPU', check: 'ping' },
  { name: 'Proxmox Box1 (.58)', ip: '192.168.2.58', role: 'Hyperviseur Proxmox', check: 'ping' },
  { name: 'Proxmox Box2 (.103)', ip: '192.168.2.103', role: 'Hyperviseur Proxmox', check: 'ping' },
  { name: 'TrueNAS (.60)', ip: '192.168.2.60', role: 'NAS RAIDZ2', check: 'ping' },
  { name: 'Home Assistant (.248)', ip: '192.168.2.248', role: 'Domotique', check: 'http', url: 'http://192.168.2.248:8123/' },
  { name: 'Furycom PC (.190)', ip: '192.168.2.190', role: 'PC Yann', check: 'ping' },
  { name: 'Embedder (.85)', ip: '192.168.2.85', role: 'BGE-m3 Embeddings', check: 'ping' },
];

// [1448] host = which physical machine hosts this VM
const VMS = [
  { name: 'Supabase (.146)', ip: '192.168.2.146', role: 'PostgreSQL/REST', check: 'ping', host: '192.168.2.58', vmid: '101' },
  { name: 'box2-daily (.12)', ip: '192.168.2.12', role: 'Dashboard BRUCE', check: 'ping', host: '192.168.2.103', vmid: '208' },
  { name: 'box2-automation (.174)', ip: '192.168.2.174', role: 'n8n Workflows', check: 'ping', host: '192.168.2.103', vmid: '203' },
  { name: 'box2-observability (.154)', ip: '192.168.2.154', role: 'Pulse + Langfuse', check: 'ping', host: '192.168.2.103', vmid: '204' },
  { name: 'box2-media (.123)', ip: '192.168.2.123', role: 'qBittorrent + Medias', check: 'ping', host: '192.168.2.103', vmid: '206' },
  { name: 'box2-edge (.87)', ip: '192.168.2.87', role: 'Edge Services', check: 'ping', host: '192.168.2.103', vmid: '201' },
  { name: 'box2-docs (.113)', ip: '192.168.2.113', role: 'Documentation', check: 'ping', host: '192.168.2.103', vmid: '205' },
  { name: 'box2-tube (.173)', ip: '192.168.2.173', role: 'Media Tube', check: 'ping', host: '192.168.2.103', vmid: '207' },
  { name: 'box2-secrets (.249)', ip: '192.168.2.249', role: 'Vaultwarden', check: 'ping', host: '192.168.2.103', vmid: '202' },
  { name: 'Rotki (.231)', ip: '192.168.2.231', role: 'Finance Rotki', check: 'ping', host: '192.168.2.58', vmid: '111' },
];

// [1448] host = IP of the machine running this service
const SERVICES = [
  { name: 'MCP Gateway', url: 'http://127.0.0.1:4000/health', host: '192.168.2.230' },
  { name: 'Supabase API', url: 'http://192.168.2.146:8000/rest/v1/?limit=0', host: '192.168.2.146' },
  { name: 'LLM Router', url: 'http://192.168.2.32:8000/health', host: '192.168.2.32' },
  { name: 'LiteLLM', url: 'http://192.168.2.230:4100/health', host: '192.168.2.230' },
  { name: 'Embedder API', url: 'http://192.168.2.85:8081/health', host: '192.168.2.85' },
  { name: 'n8n', url: 'http://192.168.2.174:5678/healthz', host: '192.168.2.174' },
  { name: 'Validate Service', url: 'http://192.168.2.230:4001/health', host: '192.168.2.230' },
  { name: 'LightRAG', url: 'http://192.168.2.230:9621/health', host: '192.168.2.230' },
  { name: 'OpenWebUI', url: 'http://192.168.2.32:3000/', host: '192.168.2.32' },
  { name: 'Forgejo', url: 'http://192.168.2.230:3300/', host: '192.168.2.230' },
  { name: 'Pulse', url: 'http://192.168.2.154:7655/api/health', host: '192.168.2.154' },
  { name: 'Langfuse', url: 'http://192.168.2.154:3200/api/public/health', host: '192.168.2.154' },
  { name: 'Portainer', url: 'https://192.168.2.230:9443/', host: '192.168.2.230', timeout: 8000 },
  { name: 'Uptime Kuma', url: 'http://192.168.2.230:3001/', host: '192.168.2.230' },
  { name: 'TrueNAS WebUI', url: 'http://192.168.2.60/', host: '192.168.2.60' },
  { name: 'Home Assistant', url: 'http://192.168.2.248:8123/', host: '192.168.2.248' },
  { name: 'Termix', url: 'http://192.168.2.230:18080/', host: '192.168.2.230' },
  { name: 'qBittorrent', url: 'http://192.168.2.123:30024/', host: '192.168.2.123' },
  { name: 'Rotki', url: 'http://192.168.2.231:8085/', host: '192.168.2.231' },
  { name: 'Dashboard BRUCE', url: 'http://192.168.2.12:8029/', host: '192.168.2.12' },
  { name: 'Cloudflare AI', url: 'https://ai.furycom.com/', host: '192.168.2.32', timeout: 10000 },
  { name: 'Koffan', url: 'http://192.168.2.12:8028/', host: '192.168.2.12' },
  { name: 'FreshRSS', url: 'http://192.168.2.12:8021/', host: '192.168.2.12' },
  { name: 'Readeck', url: 'http://192.168.2.12:8022/', host: '192.168.2.12' },
  { name: 'Maloja', url: 'http://192.168.2.12:8023/', host: '192.168.2.12' },
  { name: 'SnappyMail', url: 'http://192.168.2.12:8024/', host: '192.168.2.12' },
  { name: 'Multi-Scrobbler', url: 'http://192.168.2.12:8025/', host: '192.168.2.12' },
  { name: 'Tandoor', url: 'http://192.168.2.12:8026/', host: '192.168.2.12' },
  { name: 'Tracktor', url: 'http://192.168.2.12:8027/', host: '192.168.2.12' },
];

// [1449] Proxmox Box2 API
const PVE_BOX2 = {
  url: 'https://192.168.2.103:8006',
  token: 'PVEAPIToken=root@pam!claude-mcp=b3b90a84-9e6e-43f4-a4d8-02ba8dfae657',
};

async function pingCheck(ip, timeout = 3000) {
  const net = require('net');
  return new Promise(resolve => {
    const s = new net.Socket();
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeout);
    s.connect(22, ip, () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); s.destroy(); resolve(false); });
  });
}

async function httpCheck(url, timeout = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const opts = { signal: ctrl.signal, headers: { 'User-Agent': 'bruce-health' } };
    if (url.startsWith('https')) opts.dispatcher = undefined;  // node fetch handles agent differently
    const r = await fetch(url, opts);
    clearTimeout(t);
    return { ok: r.status < 500, status: r.status };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 0, error: e.code || e.message };
  }
}

// [S1444] Fetch REAL memory via SSH free -m on whitelisted VMs
async function fetchRealMemorySSH(ip, timeout = 4000) {
  const hostConf = BRUCE_SSH_HOSTS[ip];
  if (!hostConf) return null;
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeout);
    const args = [
      '-i', BRUCE_SSH_KEY_PATH,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=3',
      `${hostConf.user}@${ip}`,
      'free -m'
    ];
    execFile('ssh', args, { timeout }, (err, stdout) => {
      clearTimeout(t);
      if (err || !stdout) return resolve(null);
      const lines = stdout.trim().split('\n');
      const memLine = lines.find(l => l.startsWith('Mem:'));
      if (!memLine) return resolve(null);
      const parts = memLine.trim().split(/\s+/);
      if (parts.length < 7) return resolve(null);
      const total_mb = parseInt(parts[1]);
      const used_mb = parseInt(parts[2]);
      const available_mb = parseInt(parts[6]);
      resolve({
        total_gb: Math.round(total_mb / 1024 * 10) / 10,
        used_gb: Math.round(used_mb / 1024 * 10) / 10,
        available_gb: Math.round(available_mb / 1024 * 10) / 10,
        used_pct: total_mb > 0 ? Math.round((total_mb - available_mb) / total_mb * 100) : 0,
      });
    });
  });
}

// [S1444] Fetch real memory for all VMs in parallel
async function fetchAllRealMemory(vmList) {
  const results = {};
  await Promise.all(vmList.map(async vm => {
    const mem = await fetchRealMemorySSH(vm.ip);
    if (mem) results[vm.ip] = mem;
  }));
  return results;
}

// [1449] Fetch Proxmox Box2 VM resources via API
async function fetchProxmoxBox2() {
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const hdrs = { Authorization: PVE_BOX2.token };
    const [nodeResp, vmResp] = await Promise.all([
      fetch(`${PVE_BOX2.url}/api2/json/nodes/pve/status`, { headers: hdrs, signal: ctrl.signal }),
      fetch(`${PVE_BOX2.url}/api2/json/nodes/pve/qemu`, { headers: hdrs, signal: ctrl.signal }),
    ]);
    const nodeData = nodeResp.ok ? (await nodeResp.json()).data : null;
    const vmList = vmResp.ok ? (await vmResp.json()).data : [];
    clearTimeout(t);
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';

    const node = nodeData ? {
      cpu_pct: Math.round((nodeData.cpu || 0) * 100),
      mem_used_gb: Math.round((nodeData.memory?.used || 0) / 1073741824 * 10) / 10,
      mem_total_gb: Math.round((nodeData.memory?.total || 0) / 1073741824 * 10) / 10,
      mem_pct: nodeData.memory?.total ? Math.round((nodeData.memory.used / nodeData.memory.total) * 100) : 0,
      uptime_s: nodeData.uptime || 0,
    } : null;

    const vms = {};
    for (const vm of vmList) {
      vms[String(vm.vmid)] = {
        cpu_pct: Math.round((vm.cpu || 0) * 100),
        mem_used_gb: Math.round((vm.mem || 0) / 1073741824 * 10) / 10,
        mem_total_gb: Math.round((vm.maxmem || 0) / 1073741824 * 10) / 10,
        mem_pct: vm.maxmem ? Math.round((vm.mem / vm.maxmem) * 100) : 0,
        status: vm.status,
        uptime_s: vm.uptime || 0,
      };
    }
    return { node, vms };
  } catch (e) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
    return { node: null, vms: {}, error: e.message };
  }
}

// [1450] Generate alerts from data
function generateAlerts(physResults, vmResults, svcResults, pveData, realMemMap) {
  const alerts = [];
  for (const item of physResults) {
    if (!item.up) alerts.push({ level: 'critical', msg: `${item.name} est hors ligne`, cat: 'machine' });
  }
  for (const item of vmResults) {
    if (!item.up) alerts.push({ level: 'critical', msg: `${item.name} est hors ligne`, cat: 'VM' });
  }
  for (const item of svcResults) {
    if (!item.up) alerts.push({ level: 'warning', msg: `${item.name} ne repond pas`, cat: 'service' });
  }
  if (pveData && pveData.node && pveData.node.mem_pct >= 85) {
    alerts.push({ level: pveData.node.mem_pct >= 95 ? 'critical' : 'warning', msg: `Proxmox Box2 RAM: ${pveData.node.mem_pct}% (${pveData.node.mem_used_gb}/${pveData.node.mem_total_gb} GB)` });
  }
  // [S1444] Use REAL memory (SSH free) when available, Proxmox API as fallback
  for (const vm of vmResults) {
    const realMem = realMemMap && realMemMap[vm.ip];
    if (realMem) {
      if (realMem.used_pct >= 90) {
        alerts.push({ level: realMem.used_pct >= 98 ? 'critical' : 'warning', msg: `${vm.name} RAM reelle: ${realMem.used_pct}% (${realMem.available_gb} GB dispo sur ${realMem.total_gb} GB)`, cat: 'VM', source: 'ssh_free' });
      }
    } else {
      const pveVm = pveData && pveData.vms && pveData.vms[vm.vmid];
      if (pveVm && pveVm.mem_pct >= 90) {
        alerts.push({ level: 'info', msg: `${vm.name} RAM Proxmox: ${pveVm.mem_pct}% (inclut cache Linux, probablement OK)`, cat: 'VM', source: 'proxmox_api' });
      }
    }
  }
  return alerts;
}

router.get('/bruce/health-all', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const [physResults, vmResults, svcResults, pveData, realMemMap] = await Promise.all([
    Promise.all(PHYSICAL.map(async m => {
      const up = m.check === 'http' ? (await httpCheck(m.url)).ok : await pingCheck(m.ip);
      return { ...m, up, desc: DESC[m.name] || '' };
    })),
    Promise.all(VMS.map(async m => {
      const up = m.check === 'http' ? (await httpCheck(m.url)).ok : await pingCheck(m.ip);
      return { ...m, up, desc: DESC[m.name] || '' };
    })),
    Promise.all(SERVICES.map(async s => {
      const r = await httpCheck(s.url, s.timeout || 4000);
      return { ...s, up: r.ok, status: r.status, error: r.error, desc: DESC[s.name] || '' };
    })),
    fetchProxmoxBox2(),
    fetchAllRealMemory(VMS),
  ]);

  // [1449] Enrich VMs with Proxmox resource data + [S1444] real memory
  for (const vm of vmResults) {
    if (vm.vmid && pveData && pveData.vms && pveData.vms[vm.vmid]) {
      vm.resources = pveData.vms[vm.vmid];
    }
    if (realMemMap[vm.ip]) {
      vm.real_mem = realMemMap[vm.ip];
    }
  }

  const alerts = generateAlerts(physResults, vmResults, svcResults, pveData, realMemMap);

  const all = [...physResults, ...vmResults, ...svcResults];
  const up = all.filter(x => x.up).length;

  // [1448] Build tree: physical -> vms -> services
  const tree = physResults.map(p => {
    const childVms = vmResults.filter(v => v.host === p.ip).map(v => {
      const childSvcs = svcResults.filter(s => s.host === v.ip);
      return { ...v, services: childSvcs };
    });
    const directSvcs = svcResults.filter(s => s.host === p.ip);
    return { ...p, vms: childVms, services: directSvcs };
  });
  const knownHosts = new Set([...physResults.map(p => p.ip), ...vmResults.map(v => v.ip)]);
  const orphanSvcs = svcResults.filter(s => !knownHosts.has(s.host));

  res.json({
    ok: true, up, total: all.length,
    physical: physResults, vms: vmResults, services: svcResults,
    tree, orphan_services: orphanSvcs,
    pve_box2: pveData ? pveData.node : null,
    alerts,
  });
});


// ============================================================
// [1456] GET /bruce/context-summary — Ultra-compact context for bootstrap
// Aggregates: integrity, dashboard, handoff, top tasks, alerts, screensaver, disks
// Target: ~400-500 tokens instead of ~1100 from full bootstrap
// ============================================================

// Cache context-summary for 30 seconds
let _ctxSummaryCache = { data: null, ts: 0 };
const CTX_SUMMARY_TTL = 30 * 1000;

router.get('/bruce/context-summary', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const now = Date.now();
  if (_ctxSummaryCache.data && (now - _ctxSummaryCache.ts) < CTX_SUMMARY_TTL) {
    return res.json(_ctxSummaryCache.data);
  }

  const startMs = Date.now();
  const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
  const key = String(SUPABASE_KEY || '');
  const hSupa = { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' };

  try {
    const [dashRes, handoffRes, tasksRes, clarRes, intRes] = await Promise.all([
      fetchWithTimeout(base + '/v_bruce_dashboard?limit=1', { headers: hSupa }, 4000),
      fetchWithTimeout(base + '/current_state?key=eq.handoff_vivant&limit=1', { headers: hSupa }, 4000),
      fetchWithTimeout(base + '/roadmap?status=in.(todo,doing)&priority=lte.2&order=priority.asc,id.asc&limit=8&select=id,step_name,status,priority,model_hint', { headers: hSupa }, 4000),
      fetchWithTimeout(base + '/clarifications_pending?status=eq.pending&select=id', { headers: hSupa }, 4000),
      fetchWithTimeout('http://127.0.0.1:' + PORT + '/bruce/integrity', {
        headers: { Authorization: 'Bearer ' + (process.env.BRUCE_AUTH_TOKEN || ''), 'Content-Type': 'application/json' }
      }, 6000),
    ]);

    const [dashArr, handoffArr, tasks, clarArr, intData] = await Promise.all([
      dashRes.json(), handoffRes.json(), tasksRes.json(), clarRes.json(), intRes.json()
    ]);

    const dashboard = Array.isArray(dashArr) && dashArr.length > 0 ? dashArr[0] : {};
    const handoffRaw = Array.isArray(handoffArr) && handoffArr.length > 0 ? handoffArr[0].value : '';
    const handoff = handoffRaw.length > 200 ? handoffRaw.slice(0, 200) + '...' : handoffRaw;
    const vrcPending = Array.isArray(clarArr) ? clarArr.length : 0;

    const intOk = intData.ok || false;
    const failedChecks = [];
    if (intData.checks) {
      for (const [k, v] of Object.entries(intData.checks)) {
        if (!v.ok) failedChecks.push(k);
      }
    }

    // [S1447] Disks removed — redundant with dashboard alerts

    // Screensaver status
    let screensaverStatus = 'unknown';
    try {
      screensaverStatus = await _fetchScreensaverSSH(3000);
    } catch (e) { /* non-blocking */ }

    const result = {
      ok: true,
      generated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startMs,
      integrity: { ok: intOk, failed: failedChecks },
      dashboard: {
        kb: dashboard.kb_total || 0,
        lessons: dashboard.lessons_total || 0,
        done: dashboard.roadmap_done || 0,
        doing: dashboard.roadmap_doing || 0,
        staging: dashboard.staging_pending || 0,
      },
      handoff,
      tasks: (tasks || []).map(t => ({ id: t.id, name: t.step_name, s: t.status, p: t.priority, m: t.model_hint })),
      vrc_pending: vrcPending,
      screensaver: screensaverStatus,
    };

    _ctxSummaryCache = { data: result, ts: Date.now() };
    return res.json(result);
  } catch (e) {
    console.error('[context-summary] Error:', e.message);
    return res.status(500).json({ ok: false, error: e.message, elapsed_ms: Date.now() - startMs });
  }
});


// [1456] Helper: check screensaver process
async function _fetchScreensaverSSH(timeout) {
  const hostConf = BRUCE_SSH_HOSTS['192.168.2.230'];
  if (!hostConf) return 'unknown';
  return new Promise(resolve => {
    const t = setTimeout(() => resolve('unknown'), timeout);
    const args = [
      '-i', BRUCE_SSH_KEY_PATH,
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=2',
      hostConf.user + '@192.168.2.230',
      'pgrep -f bruce_screensaver.py'
    ];
    execFile('ssh', args, { timeout }, (err, stdout) => {
      clearTimeout(t);
      if (err) return resolve('stopped');
      const pid = (stdout || '').trim();
      resolve(pid ? 'running (PID ' + pid.split('\n')[0] + ')' : 'stopped');
    });
  });
}

module.exports = router;
