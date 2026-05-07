// js/api-client.js — HTTP layer for the /token page.
//
// Tiny module on purpose: just the API base URLs and a `fetchWithRetry`
// helper with exponential backoff. Decoupled from DOM and from any
// callback-into-the-page so it can be unit-tested in isolation. Retry
// status is surfaced to the caller via an optional `onRetry` callback —
// the page wires that to its own loading-status text.
//
// Note: scan endpoints take ~5-15s on uncached scans (six layers + AI
// summary in parallel), which is why the default backoff stays modest
// (1s / 2s) — a single transient blip is far more common than a long
// outage, and we want the page to feel responsive on the second attempt
// rather than wait through 8s of escalating sleeps.

export const API = "https://antares-extension.vercel.app/api/scan";
export const API_BASE = "https://antares-extension.vercel.app/api";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAYS = [1000, 2000];

/**
 * Fetch a JSON URL with bounded retry on network error / non-2xx.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=3]    Total attempts (including the first).
 * @param {number[]} [opts.retryDelays]   Backoff in ms; index = attempt-1.
 * @param {(attempt: number, max: number) => void} [opts.onRetry]
 *                                        Called BEFORE each backoff sleep,
 *                                        so callers can update UI status.
 * @param {number} [opts.attempt=1]       Internal — recursion bookkeeping.
 * @returns {Promise<any>} Parsed JSON body.
 * @throws  After `maxRetries` failed attempts, the last error is rethrown.
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelays = DEFAULT_RETRY_DELAYS,
    onRetry,
    attempt = 1,
  } = opts;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    if (attempt >= maxRetries) throw e;
    const delay = retryDelays[attempt - 1] || 2000;
    if (onRetry) onRetry(attempt, maxRetries);
    await new Promise((res) => setTimeout(res, delay));
    return fetchWithRetry(url, { ...opts, attempt: attempt + 1 });
  }
}
