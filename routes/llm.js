/**
 * routes/llm.js — Swap de modèle LLM sur furycomai (.32)
 * Endpoints:
 *   POST /bruce/llm/swap      { model: "bruce-qwen3-30b-moe" }
 *   GET  /bruce/llm/current   → modèle actuel (évite conflit avec /status dans infra.js)
 */

const express = require('express');
const router = express.Router();
const { execSync } = require('child_process');

const MODEL_ALIAS = {
  'bruce-qwen3-32b':              'alpha',
  'bruce-qwen3-14b':              'qwen3-14b-q4km',
  'bruce-qwen3-30b-moe':          'qwen3-30b-a3b-q4km',
  'bruce-qwen35-9b':              'qwen35-9b-q4km',
  'bruce-qwen35-27b':             'qwen35-27b-q4km',
  'bruce-qwen35-35b-moe':         'qwen35-35b-a3b-q4km',
  'bruce-qwen25-72b':             'qwen2.5-72b-instruct-q4km',
  'bruce-deepseek-r1-32b':        'deepseek-r1-qwen-32b-q4',
  'bruce-llama3-70b-abliterated': 'llama33-70b-abliterated-q3',
  'bruce-valkyrie-49b':           'valkyrie-49b-q3km',
  // Clés directes
  'alpha':                        'alpha',
  'qwen3-30b-a3b-q4km':          'qwen3-30b-a3b-q4km',
  'qwen3-14b-q4km':              'qwen3-14b-q4km',
};

const SWAPPER = 'python3 /home/furycom/bruce_llm_swapper.py';
const SSH_TARGET = 'furycom@192.168.2.32';

function sshExec(cmd, timeout = 10000) {
  try {
    return execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${SSH_TARGET} "${cmd}"`,
      { timeout, encoding: 'utf8' }
    ).trim();
  } catch (e) {
    return `ERROR: ${e.message.substring(0, 200)}`;
  }
}

// GET /bruce/llm/current — modèle actuellement chargé
router.get('/current', (req, res) => {
  const result = sshExec(`${SWAPPER} status`);
  res.json({ ok: true, current: result });
});

// POST /bruce/llm/swap — changer le modèle
router.post('/swap', (req, res) => {
  const { model } = req.body || {};
  if (!model) {
    return res.status(400).json({ ok: false, error: 'model required. Ex: {"model":"bruce-qwen3-30b-moe"}' });
  }

  const modelKey = MODEL_ALIAS[model];
  if (!modelKey) {
    return res.status(400).json({
      ok: false,
      error: `Modèle inconnu: ${model}`,
      available: Object.keys(MODEL_ALIAS).filter(k => k.startsWith('bruce-'))
    });
  }

  // Vérifier modèle actuel
  const current = sshExec(`${SWAPPER} status`);

  // Si déjà le bon modèle
  if (current.includes(modelKey)) {
    return res.json({ ok: true, message: `Déjà sur ${modelKey}`, current: modelKey, swapped: false });
  }

  // Lancer le swap en background
  sshExec(`nohup ${SWAPPER} swap ${modelKey} > /home/furycom/logs/llm_swap.log 2>&1 &`);

  res.json({
    ok: true,
    message: `Swap vers ${modelKey} démarré (~30-60s). Attends avant d'envoyer des requêtes.`,
    current: current,
    target: modelKey,
    swapped: true,
    check_log: 'call_gateway("/bruce/llm/current") pour vérifier quand prêt'
  });
});

module.exports = router;
