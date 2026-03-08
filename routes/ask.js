// routes/ask.js — [773] C7 REFONTE
// Route: POST /bruce/ask
const express = require('express');
const router = express.Router();
const { validateBruceAuth } = require('../shared/auth');
const { SUPABASE_URL, SUPABASE_KEY, BRUCE_LITELLM_KEY } = require('../shared/config');
const { fetchWithTimeout } = require('../shared/fetch-utils');
const { detectLLMIdentity, loadLLMProfile, BRUCE_OPERATING_PRINCIPLES } = require('../shared/llm-profiles');

router.post('/bruce/ask', async (req, res) => {
  const auth = validateBruceAuth(req);
  if (!auth.ok) return res.status(auth.status || 401).json({ ok: false, error: auth.error });

  const question = (req.body && req.body.question) ? String(req.body.question).slice(0, 500) : '';
  const extraContext = (req.body && req.body.context) ? String(req.body.context).slice(0, 1000) : '';
  const sessionId = (req.body && req.body.session_id) ? String(req.body.session_id).slice(0, 100) : null;

  const askLLMIdentity = detectLLMIdentity(req);
  const askLLMProfile = await loadLLMProfile(askLLMIdentity);

  if (!question) return res.status(400).json({ ok: false, error: 'Champ "question" requis.' });

  // 0. MULTI-TOURS: charger historique conversation si session_id fourni
  let conversationHistory = [];
  if (sessionId) {
    try {
      const base = String(SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
      const key  = String(SUPABASE_KEY || '');
      const histRes = await fetchWithTimeout(
        base + '/rest/v1/bruce_conversations?session_id=eq.' + encodeURIComponent(sessionId) +
        '&order=created_at.desc&limit=10',
        { method: 'GET', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
        5000
      );
      if (histRes.ok) {
        const histData = await histRes.json();
        conversationHistory = histData.reverse().map(m => ({ role: m.role, content: m.content }));
      }
    } catch(e) { /* historique non critique */ }
  }

  // 1. RAG: chercher contexte pertinent
  let ragContext = '';
  let ragError = null;
  try {
    const embedRes = await fetchWithTimeout(
      'http://192.168.2.85:8081/embed',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: question, max_length: 512 }) },
      8000
    );
    const embedData = await embedRes.json();
    const embedding = Array.isArray(embedData) ? (Array.isArray(embedData[0]) ? embedData[0] : embedData) : (embedData.embedding || embedData.embeddings?.[0]);
    if (embedding && embedding.length > 0) {
      const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
      const key  = String(SUPABASE_KEY || '');
      const ragRes = await fetchWithTimeout(
        base + '/rpc/bruce_rag_hybrid_search_text',
        { method: 'POST', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ qtext: question, qvec: '[' + embedding.join(',') + ']', k: 8 }) },
        10000
      );
      const ragData = await ragRes.json();
      if (Array.isArray(ragData) && ragData.length > 0) {
        ragContext = ragData.slice(0, 8).map((r, i) =>
          `[Source ${i+1} | score:${Math.round((r.hybrid_score||r.cos_sim||r.similarity||0)*100)/100}]\n${(r.preview||r.text||'').slice(0,500)}`
        ).join('\n\n');
      }
    }
  } catch (e) {
    ragError = String(e.message);
  }

  // 2. vLLM: répondre avec contexte
  const profileRules = Array.isArray(askLLMProfile.rules) ? askLLMProfile.rules.map(r => '- ' + r).join('\n') : '';
  const systemPrompt = `Tu es BRUCE, l assistant IA expert du homelab de Yann Lafleur.
Tu reponds a: ${askLLMProfile.display_name || askLLMIdentity}

${BRUCE_OPERATING_PRINCIPLES}

REGLE ABSOLUE: Tu dois TOUJOURS baser ta reponse sur les SOURCES RAG fournies. Ne dis JAMAIS que tu ne trouves pas d information si des sources sont presentes.
${profileRules ? '\nREGLES SPECIFIQUES:\n' + profileRules : ''}

Format: ${askLLMProfile.context_format === 'concise_factual' ? 'reponses courtes et factuelles, pas de markdown' : askLLMProfile.context_format === 'narrative_concise' ? 'prose narrative concise, commandes a copier' : 'markdown structure, actionnable'}
Ne hallucine jamais de details techniques non presents dans les sources.`;

  const userPrompt = `QUESTION: ${question}
${extraContext ? `\nCONTEXTE ADDITIONNEL:\n${extraContext}` : ''}
${ragContext ? `\nCONTEXTE RAG (base de connaissance BRUCE):\n${ragContext}` : '\n(Aucun contexte RAG disponible pour cette question.)'}

Reponds de facon concise et actionnable.`;

  try {
    const llmRes = await fetchWithTimeout(
      'http://192.168.2.230:4100/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (BRUCE_LITELLM_KEY || 'bruce-litellm-key-01'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5-7b',
          messages: [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user',   content: userPrompt }
          ],
          max_tokens: 800,
          temperature: 0.2,
          metadata: { trace_name: 'bruce-ask', generation_name: 'ask-answer', session_id: sessionId || 'unknown' }
        })
      },
      20000
    );
    const llmData = await llmRes.json();
    const answer = llmData?.choices?.[0]?.message?.content || null;

    if (sessionId && answer) {
      try {
        const base = String(SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
        const key  = String(SUPABASE_KEY || '');
        const msgs = [
          { session_id: sessionId, role: 'user',      content: question,     rag_sources: 0 },
          { session_id: sessionId, role: 'assistant', content: answer,        rag_sources: ragContext ? ragContext.split('\n\n').length : 0 }
        ];
        await fetchWithTimeout(
          base + '/rest/v1/bruce_conversations',
          { method: 'POST', headers: { 'apikey': key, 'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify(msgs) },
          5000
        );
      } catch(e) { /* non critique */ }
    }

    return res.json({
      ok: true, question, answer,
      llm_identity: askLLMIdentity,
      profile_used: askLLMProfile.profile_name || askLLMIdentity,
      session_id: sessionId || null,
      history_turns: conversationHistory.length / 2,
      rag_sources: ragContext ? ragContext.split('\n\n').length : 0,
      rag_error: ragError,
      model: 'Qwen/Qwen2.5-7B-Instruct-AWQ',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message), rag_error: ragError });
  }
});

module.exports = router;
