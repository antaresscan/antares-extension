// api/http.ts — HTTP utility functions extracted from helpers.ts

import type { VercelResponse } from "@vercel/node";
import { CORS } from "./constants";

export function setHeaders(res: VercelResponse) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
}

export function withTimeout(ms: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(t) };
}

export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}, ms = 5000): Promise<T | null> {
  const t = withTimeout(ms);
  try {
    const r = await fetch(url, { ...init, signal: t.signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch (e: unknown) { console.warn("[antares]", e); return null; }
  finally { t.clear(); }
}

export async function fetchJsonPost<T = unknown>(url: string, body: object, ms = 5000): Promise<T | null> {
  const t = withTimeout(ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch (e: unknown) { console.warn("[antares]", e); return null; }
  finally { t.clear(); }
}
