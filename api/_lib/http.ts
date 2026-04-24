// api/http.ts — HTTP utility functions extracted from helpers.ts
import { logger } from "./logger";

export function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
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
      if (attempt === maxRetries) { logger.warn("http", "fetchJson failed", { error: String(e) }); return null; }
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
      if (attempt === maxRetries) { logger.warn("http", "fetchJsonPost failed", { error: String(e) }); return null; }
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
  return null;
}
