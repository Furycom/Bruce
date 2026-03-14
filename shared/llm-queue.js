'use strict';
const {
  BRUCE_LLM_API_BASE,
  BRUCE_LLM_MODEL,
  BRUCE_LLM_API_KEY,
  BRUCE_LLM_TIMEOUT_MS,
  BRUCE_MAX_CONCURRENT,
} = require('./config');
const { stripThinkBlock } = require('./helpers');

// Concurrency control for LLM calls (simple queue)
let llmInFlight = 0;
const llmQueue = [];

/**
 * Acquires a concurrency slot for an LLM call, queueing when capacity is reached.
 * @returns {Promise<void>} Resolves when execution is allowed to proceed.
 */
function acquireLlmSlot() {
  if (llmInFlight < BRUCE_MAX_CONCURRENT) {
    llmInFlight += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    llmQueue.push(resolve);
  });
}

/**
 * Releases a previously acquired LLM concurrency slot and wakes the next waiter.
 * @returns {void} No return value.
 */
function releaseLlmSlot() {
  llmInFlight = Math.max(0, llmInFlight - 1);
  if (llmQueue.length > 0 && llmInFlight < BRUCE_MAX_CONCURRENT) {
    llmInFlight += 1;
    const next = llmQueue.shift();
    if (next) {
      next();
    }
  }
}

/**
 * Sends a chat completion request to the configured LLM backend with queue-based throttling.
 * @param {{role: string, content: string}[]} messages - Conversation messages for the completion request.
 * @returns {Promise<{role: string, content: string}>} Assistant message normalized from backend response.
 * @throws {Error} Throws when LLM settings are missing or the backend response is invalid.
 */
async function callLlm(messages) {
  if (!BRUCE_LLM_API_BASE || !BRUCE_LLM_MODEL) {
    throw new Error('BRUCE_LLM_API_BASE or BRUCE_LLM_MODEL not configured');
  }

  const url = `${BRUCE_LLM_API_BASE.replace(/\/+$/, '')}/chat/completions`;
  const payload = {
    model: BRUCE_LLM_MODEL,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    stream: false,
    temperature: 0.7,
    max_tokens: 1024,
  };

  await acquireLlmSlot();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BRUCE_LLM_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BRUCE_LLM_API_KEY ? { Authorization: `Bearer ${BRUCE_LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `LLM backend error HTTP ${response.status}: ${text.slice(0, 500)}`
      );
    }

    const data = await response.json();
    const choices = data.choices || [];
    if (!choices.length || !choices[0].message) {
      throw new Error('Invalid LLM response: no choices[0].message');
    }

    const msg = choices[0].message;
    if (!msg.content) {
      throw new Error('Invalid LLM response: empty content');
    }

    return {
      role: msg.role || 'assistant',
      content: stripThinkBlock(msg.content),
    };
  } finally {
    releaseLlmSlot();
  }
}

module.exports = {
  acquireLlmSlot,
  releaseLlmSlot,
  callLlm,
};
