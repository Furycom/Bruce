// shared/fetch-utils.js — [773] C7 REFONTE
// fetchWithTimeout used by multiple route files

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
