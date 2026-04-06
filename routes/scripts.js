// routes/scripts.js — [1232] Versioning gouvernance scripts critiques v2
// GET /bruce/scripts/active : retourne le registre canonique depuis Supabase
// POST /bruce/scripts/refresh : erreur explicite — utiliser init_registry_1232.py sur host
// NOTE: le container ne peut PAS lire /home/furycom/ directement.
//       Le registre doit être mis à jour via: python3 /home/furycom/uploads/init_registry_1232.py
// Session S1342 Sonnet

const express = require('express');
const router  = express.Router();

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_KEY;

// GET /bruce/scripts/active
router.get('/active', async (req, res) => {
  try {
    const url = `${SUPA_URL}/current_state?key=eq.script_registry&select=value,updated_at`;
    const r = await fetch(url, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
    const rows = await r.json();
    if (!rows || !rows.length) return res.status(404).json({ ok: false, error: 'script_registry not found in current_state' });

    const registry   = JSON.parse(rows[0].value);
    const updated_at = rows[0].updated_at;

    res.json({
      ok: true,
      registry_updated_at: updated_at,
      scripts: registry,
      _note: 'Pour mettre à jour après un patch: python3 /home/furycom/uploads/init_registry_1232.py',
      _refresh_cmd: 'ssh furymcp python3 /home/furycom/uploads/init_registry_1232.py',
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST /bruce/scripts/refresh — instruction canonique
router.post('/refresh', async (req, res) => {
  res.status(400).json({
    ok: false,
    error: 'Le container ne peut pas lire /home/furycom/ directement.',
    solution: 'Mettre à jour le registre depuis le host: ssh furymcp python3 /home/furycom/uploads/init_registry_1232.py',
  });
});

module.exports = router;
