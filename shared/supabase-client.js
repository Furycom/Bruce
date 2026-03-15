'use strict';
const { SUPABASE_URL, SUPABASE_KEY } = require('./config');
const { utcNowIso, logFallback, isSupabaseConfigured } = require('./helpers');

/**
 * Writes a memory event row to Supabase (currently short-circuited while table is disabled).
 * @param {string} source - Origin system that emitted the event.
 * @param {string} eventType - Event classification label.
 * @param {Record<string, any>} payload - Structured event payload.
 * @returns {Promise<string|null>} Inserted event ID when available, otherwise `null`.
 */
async function insertMemoryEvent(source, eventType, payload) {

  // DISABLED: table memory_events inexistante/vidée, voir [840].
  return null;
  if (!isSupabaseConfigured()) {
    await logFallback({
      kind: 'supabase_memory_events_skipped',
      timestamp: utcNowIso(),
      reason: 'supabase_not_configured',
      source,
      event_type: eventType,
      payload,
    });
    return null;
  }

  const url = `${SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')}/rest/v1/memory_events`;
  const body = {
    source,
    event_type: eventType,
    payload,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      await logFallback({
        kind: 'supabase_memory_events_error',
        timestamp: utcNowIso(),
        status_code: response.status,
        response_text: text,
        source,
        event_type: eventType,
        payload,
      });
      return null;
    }

    const json = await response.json();
    if (Array.isArray(json) && json.length > 0 && json[0].id) {
      return String(json[0].id);
    }

    await logFallback({
      kind: 'supabase_memory_events_parse_error',
      timestamp: utcNowIso(),
      response_json: json,
    });
  } catch (err) {
    await logFallback({
      kind: 'supabase_memory_events_exception',
      timestamp: utcNowIso(),
      error: err.message || String(err),
      source,
      event_type: eventType,
      payload,
    });
  }

  return null;
}

/**
 * Writes a conversation message linked to a memory event (currently short-circuited).
 * @param {string|null} eventId - Parent memory event ID for the message row.
 * @param {string} conversationId - Conversation identifier associated with the message.
 * @param {string} role - Message author role (`user`, `assistant`, etc.).
 * @param {string} content - Message text content to persist.
 * @returns {Promise<void>} Resolves when logging attempts complete.
 */
async function insertConversationMessage(eventId, conversationId, role, content) {

  // DISABLED: table conversation_messages inexistante/vidée, voir [840].
  return;
  if (!isSupabaseConfigured() || !eventId) {
    await logFallback({
      kind: 'supabase_conversation_messages_skipped',
      timestamp: utcNowIso(),
      reason: 'supabase_not_configured_or_missing_event',
      event_id: eventId,
      conversation_id: conversationId,
      role,
      content,
    });
    return;
  }

  const url = `${SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')}/rest/v1/conversation_messages`;
  const body = {
    event_id: eventId,
    conversation_id: conversationId,
    role,
    content,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      await logFallback({
        kind: 'supabase_conversation_messages_error',
        timestamp: utcNowIso(),
        status_code: response.status,
        response_text: text,
        event_id: eventId,
        conversation_id: conversationId,
        role,
        content,
      });
    }
  } catch (err) {
    await logFallback({
      kind: 'supabase_conversation_messages_exception',
      timestamp: utcNowIso(),
      error: err.message || String(err),
      event_id: eventId,
      conversation_id: conversationId,
      role,
      content,
    });
  }
}

module.exports = {
  insertMemoryEvent,
  insertConversationMessage,
};
