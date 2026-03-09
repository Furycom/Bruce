// shared/context-engine.js — [878] Context Engine v1
// Replaces Naive RAG with intelligent, scored context injection for Claude sessions
// Architecture: 3 layers (Anchor / Session / Reference) with token budgeting
// Inspired by: LangChain context strategies, Google ADK, ACE, Dash/Agno patterns

const { SUPABASE_URL, SUPABASE_KEY } = require('./config');
const { fetchWithTimeout } = require('./fetch-utils');

// Token budget per layer (approximate, 1 token ≈ 4 chars)
const TOKEN_BUDGET = {
  anchor: 800,    // Always injected: profile, sentiment, handoff
  session: 1200,  // Adaptive: RAG, relevant tasks, recent lessons
  total: 2000     // Max for Claude context_prompt
};

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
// Sources: user_profile, handoff_vivant, SENTIMENT_PROJET (via current_state)
// ============================================================

async function buildAnchorLayer(currentState, dashboard) {
  const parts = [];
  let usedTokens = 0;

  // 1a. Handoff vivant — most critical for session continuity
  const handoff = (currentState || []).find(s => s.key === 'handoff_vivant');
  if (handoff && handoff.value) {
    const hText = truncateToTokens(handoff.value, 300);
    parts.push('**HANDOFF:** ' + hText);
    usedTokens += estimateTokens(hText) + 5;
  }

  // 1b. User profile condensed — fetch from Supabase user_profile table
  try {
    const base = String(SUPABASE_URL || '').replace(/\/+$/, '');
    const key = String(SUPABASE_KEY || '');
    const res = await fetchWithTimeout(
      base + '/user_profile?select=category,observation&order=category.asc',
      { headers: { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' } },
      3000
    );
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0) {
      // Group by category, take first observation per category for density
      const byCategory = {};
      for (const r of rows) {
        const cat = r.category || 'other';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(r.observation);
      }
      // Priority order for categories
      const catOrder = ['ce_qui_l_irrite', 'ce_qu_il_valorise', 'comment_il_travaille', 'ses_buts', 'qui_il_est', 'patterns_comportementaux'];
      const profileLines = [];
      for (const cat of catOrder) {
        if (byCategory[cat]) {
          const obs = byCategory[cat].slice(0, 2).map(o => truncateToTokens(o, 60)).join(' | ');
          profileLines.push(cat.replace(/_/g, ' ') + ': ' + obs);
        }
      }
      if (profileLines.length > 0) {
        const profileText = profileLines.join('\n');
        const remaining = TOKEN_BUDGET.anchor - usedTokens - 10;
        parts.push('**PROFIL YANN:**\n' + truncateToTokens(profileText, remaining > 50 ? remaining : 50));
        usedTokens += estimateTokens(profileText) + 5;
      }
    }
  } catch (e) { /* non-bloquant */ }

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

function scoreAndSelectItems(items, maxTokens) {
  // Score each item, sort by score, fit within budget
  let remaining = maxTokens;
  const selected = [];
  for (const item of items) {
    const tokens = estimateTokens(item.text);
    if (tokens <= remaining) {
      selected.push(item);
      remaining -= tokens;
    }
  }
  return selected;
}

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

  // 2b. RAG results — already scored by similarity, just format
  if (Array.isArray(ragResults) && ragResults.length > 0) {
    const ragBudget = Math.min(400, budget - usedTokens);
    const ragItems = ragResults
      .filter(r => r.score >= 0.04) // Only meaningful matches
      .slice(0, 4)
      .map(r => `(${r.score}) ${truncateToTokens(r.preview, 80)}`);
    if (ragItems.length > 0) {
      const ragText = '**RAG ("' + (topic || '').slice(0, 30) + '"):**\n' + ragItems.join('\n');
      parts.push(truncateToTokens(ragText, ragBudget));
      usedTokens += estimateTokens(ragText);
    }
  }

  // 2c. Critical lessons — only truly critical, non-archived
  if (Array.isArray(lessons) && lessons.length > 0) {
    const lessonBudget = Math.min(300, budget - usedTokens);
    if (lessonBudget > 50) {
      const lessonLines = lessons
        .filter(l => !l.archived)
        .slice(0, 3)
        .map(l => truncateToTokens(l.lesson_text || '', 80));
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
// Called from session/init when isClaude=true
// ============================================================

async function buildContextForClaude({ dashboard, tasks, lessons, ragResults, currentState, topic }) {
  // Layer 1: Anchor (always)
  const anchor = await buildAnchorLayer(currentState, dashboard);

  // Layer 2: Session (adaptive)
  const session = buildSessionLayer(tasks, lessons, ragResults, topic);

  // Assemble with clear separation
  const contextParts = [];
  if (anchor.text) contextParts.push(anchor.text);
  if (session.text) contextParts.push(session.text);

  const fullContext = contextParts.join('\n\n---\n\n');
  const totalTokens = estimateTokens(fullContext);

  // Log token usage for monitoring
  const meta = {
    anchor_tokens: anchor.tokens,
    session_tokens: session.tokens,
    total_tokens: totalTokens,
    budget_used_pct: Math.round((totalTokens / TOKEN_BUDGET.total) * 100)
  };

  return {
    context_prompt: fullContext,
    context_meta: meta
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
