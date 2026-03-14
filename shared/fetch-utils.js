// shared/fetch-utils.js — [773] C7 REFONTE
// fetchWithTimeout used by multiple route files

/**
 * Executes fetch with an AbortController timeout to prevent hanging requests.
 * @param {string} url - Request URL to call.
 * @param {RequestInit} [options] - Optional fetch configuration object.
 * @param {number} timeoutMs - Timeout in milliseconds before aborting the request.
 * @returns {Promise<Response>} Fetch response when the request succeeds before timeout.
 * @throws {Error} Throws when fetch fails or the request is aborted on timeout.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...(options || {}), signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchWithTimeout };
