'use strict';

function clampStr(s, maxLen) {
  const x = String(s ?? '');
  if (x.length <= maxLen) return x;
  return x.slice(0, maxLen) + `\n...[truncated to ${maxLen} chars]`;
}

function parseLegacyToolCallFromContent(content) {
  const s = String(content || '');
  const m = s.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (!m || !m[1]) return null;

  try {
    const obj = JSON.parse(m[1]);
    const name = obj && obj.name ? String(obj.name) : null;
    const args = obj && obj.arguments && typeof obj.arguments === 'object' ? obj.arguments : {};
    return name ? { name, arguments: args } : null;
  } catch (e) {
    console.error('[chat.js][/bruce/agent/chat] erreur silencieuse:', e.message || e);
    return null;
  }
}

// Extraire user/password depuis system_prompt.txt (évite de hardcoder un secret ici)
function extractSshCredsFromPrompt(promptText) {
  const out = { user: null, password: null };

  const userMatch = String(promptText).match(/^\s*-\s*User:\s*(.+)\s*$/mi);
  if (userMatch && userMatch[1]) out.user = userMatch[1].trim();

  const passMatch = String(promptText).match(/^\s*-\s*Password:\s*(.+)\s*$/mi);
  if (passMatch && passMatch[1]) out.password = passMatch[1].trim();

  return out;
}

function safeJsonParse(value, fallbackValue) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallbackValue;
  }
}

function buildSystemPrompt(systemPrompt, conversationHistory, message) {
  return [
    { role: 'system', content: systemPrompt },
    ...(Array.isArray(conversationHistory) ? conversationHistory : []),
    { role: 'user', content: String(message) },
  ];
}

module.exports = {
  clampStr,
  parseLegacyToolCallFromContent,
  extractSshCredsFromPrompt,
  safeJsonParse,
  buildSystemPrompt,
};
