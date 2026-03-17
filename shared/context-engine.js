// shared/context-engine.js — [878] Context Engine v1.1
// Replaces Naive RAG with intelligent, scored context injection for Claude sessions
// Architecture: 3 layers (Anchor / Session / Reference) with token budgeting
// Inspired by: LangChain context strategies, Google ADK, ACE, Dash/Agno patterns

const { SUPABASE_URL, SUPABASE_KEY } = require('./config');
const { fetchWithTimeout } = require('./fetch-utils');

// Token budget per layer (approximate, 1 token ≈ 4 chars)
const TOKEN_BUDGET = {
  anchor: 900,    // Always injected: exigences, profile, handoff, wishes
  session: 1100,  // Adaptive: RAG, relevant tasks, recent lessons
  total: 2000     // Max for Claude context_prompt
};

// [CE-0b] Cache user_profile — TTL 5 minutes (mêmes données changent rarement)
let _userProfileCache = { data: null, ts: 0 };
const USER_PROFILE_CACHE_TTL = 5 * 60 * 1000;

const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

function truncateToTokens(text, maxTokens) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if ((text || '').length <= maxChars) return text || '';
  return text.slice(0, maxChars) + '…';
}


// ============================================================
// LAYER 1: ANCHOR — Always injected, independent of topic
// Sources: user_profile (exigences, profile, wishes), handoff_vivant
// ============================================================

async function buildAnchorLayer(currentState, dashboard) {
  const parts = [];
  let usedTokens = 0;

  // 1a. Handoff vivant — most critical for session continuity
  const handoff = (currentState || []).find(s => s.key === 'handoff_vivant');
  if (handoff && handoff.value) {
    const hText = truncateToTokens(handoff.value, 250);
    parts.push('**HANDOFF:** ' + hText);
    usedTokens += estimateTokens(hText) + 5;
  }

  // 1b. User profile + exigences + wishes (cached, TTL 5min) [CE-0b]
  try {
    let rows;
    const now = Date.now();
    if (_userProfileCache.data && (now - _userProfileCache.ts) < USER_PROFILE_CACHE_TTL) {
      rows = _userProfileCache.data;
    } else {
      const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
      const key = String(SUPABASE_KEY || '');
      const res = await fetchWithTimeout(
        base + '/user_profile?status=eq.active&select=category,subcategory,observation,priority&order=priority.asc,category.asc',
        { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
        3000
      );
      rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) {
        _userProfileCache = { data: rows, ts: now };
      }
    }
    if (Array.isArray(rows) && rows.length > 0) {
      const byCategory = {};
      for (const r of rows) {
        const cat = r.category || 'other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push({ text: r.observation, priority: r.priority, sub: r.subcategory });
      }

      // 1b-i. EXIGENCES CRITIQUES — always first, most important
      if (byCategory['exigence']) {
        const exLines = byCategory['exigence']
          .filter(e => e.priority === 'critical')
          .map(e => '- ' + truncateToTokens(e.text, 50));
        if (exLines.length > 0) {
          const exText = '**EXIGENCES YANN:**\n' + exLines.join('\n');
          parts.push(exText);
          usedTokens += estimateTokens(exText) + 5;
        }
      }

      // 1b-ii. PROFILE condensed — key behavioral patterns
      const profileCats = ['ce_qui_l_irrite', 'ce_qu_il_valorise', 'comment_il_travaille', 'ses_buts', 'qui_il_est'];
      const profileLines = [];
      for (const cat of profileCats) {
        if (byCategory[cat]) {
          const obs = byCategory[cat].slice(0, 1).map(o => truncateToTokens(o.text, 75)).join('');
          profileLines.push(cat.replace(/_/g, ' ') + ': ' + obs);
        }
      }
      if (profileLines.length > 0) {
        const remaining = TOKEN_BUDGET.anchor - usedTokens - 50;
        if (remaining > 100) {
          const profileText = '**PROFIL YANN:**\n' + profileLines.join('\n');
          parts.push(truncateToTokens(profileText, remaining));
          usedTokens += estimateTokens(profileText) + 5;
        }
      }

      // 1b-iii. ACTIVE WISHES — what Yann wants (high priority only)
      if (byCategory['user_wish']) {
        const wishes = byCategory['user_wish']
          .filter(w => w.priority === 'high' || w.priority === 'critical')
          .slice(0, 3)
          .map(w => '- ' + (w.sub || '') + ': ' + truncateToTokens(w.text, 40));
        if (wishes.length > 0) {
          const remaining = TOKEN_BUDGET.anchor - usedTokens - 20;
          if (remaining > 50) {
            const wishText = '**SOUHAITS ACTIFS:**\n' + wishes.join('\n');
            parts.push(truncateToTokens(wishText, remaining));
            usedTokens += estimateTokens(wishText) + 5;
          }
        }
      }
    }
  } catch (e) { console.error(`[context-engine.js] operation failed:`, e.message); /* non-bloquant */ }

  // 1c. Dashboard compact
  if (dashboard) {
    parts.push(`**ÉTAT:** lessons=${dashboard.lessons_total||0} kb=${dashboard.kb_total||0} done=${dashboard.roadmap_done||0} staging=${dashboard.staging_pending||0}`);
    usedTokens += 20;
  }

  return { text: parts.join('\n\n'), tokens: usedTokens };
}


// ============================================================
// LAYER 2: SESSION — Adaptive, scored by relevance to topic
// Sources: RAG results, relevant tasks, recent critical lessons
// ============================================================

function buildSessionLayer(tasks, lessons, ragResults, topic) {
  const parts = [];
  let usedTokens = 0;
  const budget = TOKEN_BUDGET.session;

  // 2a. Top tasks (P1-P2 always, P3+ only if relevant to topic)
  if (Array.isArray(tasks) && tasks.length > 0) {
    const topTasks = tasks.filter(t => t.priority <= 2).slice(0, 5);
    if (topTasks.length > 0) {
      const taskLines = topTasks.map(t =>
        `[${t.id}] P${t.priority} ${t.model_hint||''} ${t.step_name}`
      );
      const taskText = '**TÂCHES PRIORITAIRES:**\n' + taskLines.join('\n');
      parts.push(truncateToTokens(taskText, Math.min(400, budget - usedTokens)));
      usedTokens += estimateTokens(taskText);
    }
  }

  // 2b. RAG results — already scored by similarity
  if (Array.isArray(ragResults) && ragResults.length > 0) {
    const ragBudget = Math.min(350, budget - usedTokens);
    if (ragBudget > 50) {
      const ragItems = ragResults
        .filter(r => r.score >= 0.04)
        .slice(0, 4)
        .map(r => `(${r.score}) ${truncateToTokens(r.preview, 70)}`);
      if (ragItems.length > 0) {
        const ragText = '**RAG ("' + (topic || '').slice(0, 30) + '"):**\n' + ragItems.join('\n');
        parts.push(truncateToTokens(ragText, ragBudget));
        usedTokens += estimateTokens(ragText);
      }
    }
  }

  // 2c. Critical lessons — only truly critical, non-archived
  if (Array.isArray(lessons) && lessons.length > 0) {
    const lessonBudget = Math.min(250, budget - usedTokens);
    if (lessonBudget > 50) {
      const lessonLines = lessons
        .filter(l => !l.archived)
        .slice(0, 3)
        .map(l => truncateToTokens(l.lesson_text || '', 70));
      if (lessonLines.length > 0) {
        const lessonText = '**LEÇONS CRITIQUES:**\n' + lessonLines.join('\n');
        parts.push(truncateToTokens(lessonText, lessonBudget));
        usedTokens += estimateTokens(lessonText);
      }
    }
  }

  return { text: parts.join('\n\n'), tokens: usedTokens };
}

// ============================================================
// MAIN: buildContextForClaude — replaces buildContextForProfile for Claude
// ============================================================

async function buildContextForClaude({ dashboard, tasks, lessons, ragResults, currentState, topic }) {
  const anchor = await buildAnchorLayer(currentState, dashboard);
  const session = buildSessionLayer(tasks, lessons, ragResults, topic);

  const contextParts = [];
  if (anchor.text) contextParts.push(anchor.text);
  if (session.text) contextParts.push(session.text);

  const fullContext = contextParts.join('\n\n---\n\n');
  const totalTokens = estimateTokens(fullContext);

  return {
    context_prompt: fullContext,
    context_meta: {
      anchor_tokens: anchor.tokens,
      session_tokens: session.tokens,
      total_tokens: totalTokens,
      budget_used_pct: Math.round((totalTokens / TOKEN_BUDGET.total) * 100)
    }
  };
}

module.exports = {
  buildContextForClaude,
  buildAnchorLayer,
  buildSessionLayer,
  estimateTokens,
  truncateToTokens,
  TOKEN_BUDGET
};
