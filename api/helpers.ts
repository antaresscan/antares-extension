// api/helpers.ts — Utility functions for Antares scan engine

import type { VercelResponse } from "@vercel/node";
import type {
  Severity, ScanFlag,
  GoPlusTokenResult, GoPlusResponse,
  RugCheckSummary, RugCheckReport, RugCheckRisk,
} from "./types";
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

export async function fetchJson(url: string, init: RequestInit = {}, ms = 5000) {
  const t = withTimeout(ms);
  try {
    const r = await fetch(url, { ...init, signal: t.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { t.clear(); }
}

export async function fetchJsonPost(url: string, body: object, ms = 5000) {
  const t = withTimeout(ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { t.clear(); }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function asNumber(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

export function pickGoPlusResult(raw: unknown, ca: string): GoPlusTokenResult | null {
  if (!isObject(raw)) return null;
  const result = (raw as GoPlusResponse).result;
  if (!result || typeof result !== "object") return null;
  return result[ca] || result[ca.toLowerCase()] || result[ca.toUpperCase()] || null;
}

export function makeFlag(label: string, severity: Severity, impact: number): ScanFlag {
  return { label, severity, impact };
}

export function getLpLockDurationDays(rugData: RugCheckSummary): number {
  const raw = rugData?.lpLockDurationDays ?? rugData?.lpLockDuration ?? rugData?.lockDurationDays ?? 0;
  return asNumber(raw);
}

export function riskIncludes(data: RugCheckSummary | RugCheckReport | null | undefined, matcher: RegExp): boolean {
  if (!data || !Array.isArray(data.risks)) return false;
  return data.risks.some((r: RugCheckRisk) => matcher.test(String(r?.name || "")));
}

export function _mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function _std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = _mean(xs);
  return Math.sqrt(_mean(xs.map(x => (x - m) ** 2)));
}

export function _pct(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return ((to - from) / Math.abs(from)) * 100;
}

export function settled<T>(p: Promise<T>): Promise<T | null> {
  return p.then(v => v).catch(() => null);
}

export function computeCacheTTL(tokenAgeMinutes: number | null): number {
  if (tokenAgeMinutes === null) return 20;
  if (tokenAgeMinutes < 60) return 15;
  if (tokenAgeMinutes < 1440) return 30;
  return 120;
}
