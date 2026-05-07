// api/http.ts — HTTP utility functions extracted from helpers.ts
import { logger } from "./logger";

export function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
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

// Default maxRetries is 1 (one retry on 429/503 or network error).
// Rationale: scan.ts runs under Vercel's 10s maxDuration. With timeout=5000ms
// and backoff 500ms, maxRetries=1 caps worst-case latency per fetch at ~10.5s,
// vs ~16.5s with the previous default of 2. Call sites that need stronger
// retry behaviour can still opt in explicitly.
export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}, ms = 5000, maxRetries = 1): Promise<T | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const t = withTimeout(ms);
    try {
      const r = await fetch(url, { ...init, signal: t.signal });
      t.clear();
      if (r.status === 429 || r.status === 503) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
          continue;
        }
      }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch (e: unknown) {
      t.clear();
      if (attempt === maxRetries) { logger.warn("http", "fetchJson failed", { error: scrubSensitive(String(e)) }); return null; }
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}

export async function fetchJsonPost<T = unknown>(url: string, body: object, ms = 5000, maxRetries = 1, extraHeaders: Record<string, string> = {}): Promise<T | null> {
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
      if (r.status === 429 || r.status === 503) {
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
          continue;
        }
      }
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch (e: unknown) {
      t.clear();
      if (attempt === maxRetries) { logger.warn("http", "fetchJsonPost failed", { error: scrubSensitive(String(e)) }); return null; }
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}
