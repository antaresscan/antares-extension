// api/http.ts — HTTP utility functions extracted from helpers.ts
import { logger } from "./logger";

export function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}

// ─── Per-host circuit breaker ────────────────────────────────────────────
//
// When Helius / Solscan / GoPlus / DexScreener has a partial outage, each
// scan that touches the failing host pays the full timeout (5–8s) before
// moving on, and the upstream gets pummelled with N retries. Multiplied
// across concurrent scans this both burns the Vercel function budget and
// makes the outage worse for everyone behind us.
//
// The breaker counts consecutive failures per host (parsed from the URL's
// hostname). After 5 failures inside a 30s window it opens — subsequent
// fetchJson calls to that host return null immediately for the next 30s,
// without touching the network. Then a single probe is allowed; if it
// succeeds, the breaker closes; if it fails, the open window resets.
//
// State is module-scope, so it lives for the lifetime of a warm serverless
// instance (Vercel keeps lambdas warm for ~5–15min). Cold-start resets are
// acceptable — the first scan after a cold start may pay one round-trip,
// but subsequent ones bypass cleanly.
type BreakerState = {
  failures: number;        // consecutive failure count
  firstFailureAt: number;  // ms timestamp of the failure that started the window
  openUntil: number;       // ms timestamp; 0 = closed; > now = open
};
const BREAKER_THRESHOLD = 5;
const BREAKER_WINDOW_MS = 30_000;
const BREAKER_COOLDOWN_MS = 30_000;
const breakers = new Map<string, BreakerState>();

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Returns true if the host is currently open (no requests should fly).
 * Exported for tests; production callers go through `fetchJson` /
 * `fetchJsonPost` which gate internally.
 */
export function isCircuitOpen(host: string, now: number = Date.now()): boolean {
  const s = breakers.get(host);
  return !!s && s.openUntil > now;
}

function recordFailure(host: string, now: number = Date.now()): void {
  const s = breakers.get(host);
  if (!s || now - s.firstFailureAt > BREAKER_WINDOW_MS) {
    breakers.set(host, { failures: 1, firstFailureAt: now, openUntil: 0 });
    return;
  }
  s.failures += 1;
  if (s.failures >= BREAKER_THRESHOLD && s.openUntil === 0) {
    s.openUntil = now + BREAKER_COOLDOWN_MS;
    logger.warn("http", "circuit breaker opened", {
      host,
      failures: s.failures,
      cooldownMs: BREAKER_COOLDOWN_MS,
    });
  }
}

function recordSuccess(host: string): void {
  // Any success resets the breaker. This covers both "closed and healthy"
  // and "half-open probe succeeded" cases without needing a separate
  // half-open state machine.
  const s = breakers.get(host);
  if (s) breakers.delete(host);
}

/** Test-only helper to reset all breaker state between tests. */
export function _resetCircuitBreakersForTests(): void {
  breakers.clear();
}

// Scrub sensitive query params (api-key, key, token, secret, password, auth)
// from any string before it lands in a log line. Native Node fetch failures
// occasionally surface the request URL inside the Error message
// (`TypeError: fetch failed: https://...?api-key=...`), which would leak the
// upstream key into Vercel runtime logs. Helius's /v0/* REST surface does not
// accept Authorization: Bearer (returns 401) and forces query-param auth, so
// the leak vector exists by API design — we mitigate at the log boundary.
const SENSITIVE_QS_KEYS = ["api-key", "api_key", "apikey", "key", "token", "secret", "password", "auth"];
export function scrubSensitive(input: string): string {
  let out = input;
  for (const k of SENSITIVE_QS_KEYS) {
    // Match `&api-key=anything` or `?api-key=anything` up to the next & or end
    const re = new RegExp(`([?&]${k}=)[^&\\s"']+`, "gi");
    out = out.replace(re, "$1[REDACTED]");
  }
  return out;
}

// 401/403 from an upstream mean OUR credentials were refused (expired key, plan
// out of credits, wrong auth form, domain/IP restriction). Callers swallow 4xx
// as a silent null, which hid a month-long Helius outage. Log the host and the
// status, never the URL (it can carry the key), at most once a minute per host
// and status so a dead key does not flood the runtime logs.
const authLogAt = new Map<string, number>();
const AUTH_LOG_INTERVAL_MS = 60_000;
function logAuthRejected(host: string | null, status: number, now: number = Date.now()): void {
  if (!host || (status !== 401 && status !== 403)) return;
  const k = `${host}:${status}`;
  if (now - (authLogAt.get(k) ?? 0) < AUTH_LOG_INTERVAL_MS) return;
  authLogAt.set(k, now);
  logger.warn("http", "upstream rejected our credentials", { host, status });
}

/** Test-only helper to reset the 401/403 log throttle between tests. */
export function _resetAuthLogThrottleForTests(): void {
  authLogAt.clear();
}

// Default maxRetries is 1 (one retry on 429/503 or network error).
// Rationale: scan.ts runs under Vercel's 10s maxDuration. With timeout=5000ms
// and backoff 500ms, maxRetries=1 caps worst-case latency per fetch at ~10.5s,
// vs ~16.5s with the previous default of 2. Call sites that need stronger
// retry behaviour can still opt in explicitly.
// `onStatus` receives the HTTP status of every response (same contract as
// fetchJsonPost), so a caller can tell "refused" (401/403) from "unknown
// token" (404) even though the return value is null for both.
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  ms = 5000,
  maxRetries = 1,
  onStatus?: (status: number) => void,
): Promise<T | null> {
  const host = hostnameOf(url);
  if (host && isCircuitOpen(host)) {
    // Breaker open — return null immediately, don't touch the network.
    // Caller's null-handling path runs as if the upstream had errored.
    return null;
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t = withTimeout(ms);
    try {
      const r = await fetch(url, { ...init, signal: t.signal });
      t.clear();
      logAuthRejected(host, r.status);
      onStatus?.(r.status);
      if (r.status === 429 || r.status === 503) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
          continue;
        }
        if (host) recordFailure(host);
      }
      if (!r.ok) {
        // 5xx + the 429/503 case that fell through retries above both
        // count as failures for the breaker. 4xx (other than 429) are
        // request errors, not upstream-health signals — don't trip on
        // those.
        if (host && r.status >= 500) recordFailure(host);
        return null;
      }
      if (host) recordSuccess(host);
      return (await r.json()) as T;
    } catch (e: unknown) {
      t.clear();
      if (attempt === maxRetries) {
        if (host) recordFailure(host);
        logger.warn("http", "fetchJson failed", { error: scrubSensitive(String(e)) });
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}

/**
 * POST JSON and parse the answer, or null on any failure. `onStatus` receives
 * the HTTP status of every response, so a caller can tell "refused" (401/403)
 * from "down" or "rate limited" even though the return value is null for all.
 */
export async function fetchJsonPost<T = unknown>(
  url: string,
  body: object,
  ms = 5000,
  maxRetries = 1,
  extraHeaders: Record<string, string> = {},
  onStatus?: (status: number) => void,
): Promise<T | null> {
  const host = hostnameOf(url);
  if (host && isCircuitOpen(host)) return null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t = withTimeout(ms);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(body),
        signal: t.signal,
      });
      t.clear();
      onStatus?.(r.status);
      logAuthRejected(host, r.status);
      if (r.status === 429 || r.status === 503) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
          continue;
        }
        if (host) recordFailure(host);
      }
      if (!r.ok) {
        if (host && r.status >= 500) recordFailure(host);
        return null;
      }
      if (host) recordSuccess(host);
      return (await r.json()) as T;
    } catch (e: unknown) {
      t.clear();
      if (attempt === maxRetries) {
        if (host) recordFailure(host);
        logger.warn("http", "fetchJsonPost failed", { error: scrubSensitive(String(e)) });
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}
