// api/helpers.ts — Utility functions for Antares scan engine
// Re-exports split modules for backward compatibility

import type { VercelResponse } from "@vercel/node";
import type {
  Severity, ScanFlag,
  GoPlusTokenResult, GoPlusResponse,
  DexScreenerResponse, RugCheckSummary, RugCheckReport, RugCheckRisk,
} from "./types";
import {
  GoPlusTokenResultSchema,
  RugCheckSummarySchema,
  RugCheckReportSchema,
  HeliusLargestAccountsResponseSchema,
  HeliusSupplyResponseSchema,
} from "./upstream-schemas";

// Re-export split modules
export { asNumber, _mean, _std, _pct } from "./math";
export { withTimeout, fetchJson, fetchJsonPost } from "./http";

// Import for local use
import { asNumber } from "./math";

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function pickGoPlusResult(raw: unknown, ca: string): GoPlusTokenResult | null {
  if (!isObject(raw)) return null;
  const result = (raw as GoPlusResponse)?.result;
  if (!result || typeof result !== "object") return null;
  const picked = result[ca] || result[ca.toLowerCase()] || result[ca.toUpperCase()] || null;
  if (!picked) return null;
  // Validate shape at runtime — if upstream changes a type unexpectedly,
  // drop the result instead of feeding malformed data to the scoring layer.
  const parsed = GoPlusTokenResultSchema.safeParse(picked);
  return parsed.success ? parsed.data : null;
}

export function goPlusBool(val: unknown): boolean {
  return val === "1" || val === 1 || val === true;
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

export function settled<T>(p: Promise<T>): Promise<T | null> {
  return p.then(v => v).catch(() => null);
}

// Cap a promise at a fixed duration. If it resolves within budget, returns its
// value (or null on rejection). If the timer fires first, returns null so the
// caller can proceed with partial data instead of hanging the whole pipeline.
//
// Used in scan.ts to bound each upstream fetch: when one source (e.g. Helius)
// is slow, the others still return real data and scoring can degrade
// gracefully instead of hitting the global 9s timeout and returning 504.
export function withBudget<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.then(v => v).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

export function computeCacheTTL(tokenAgeMinutes: number | null): number {
    if (tokenAgeMinutes === null) return 60;    // 1 minute (unknown age)
  if (tokenAgeMinutes < 30) return 20;          // 20s for <30min tokens (fast-moving)
  if (tokenAgeMinutes < 60) return 45;          // 45s for <1h tokens
  if (tokenAgeMinutes < 1440) return 120;       // 2 minutes for <1 day tokens
  if (tokenAgeMinutes < 10080) return 300;      // 5 minutes for <1 week tokens
  return 600;                                    // 10 minutes for established tokens (>1 week)
}

export function apiError(res: VercelResponse, status: number, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: message, ...(details ? { details } : {}) });
}

export function isCorsAllowed(origin: string, allowedOrigins: string[]): boolean {
  try {
    const h = new URL(origin).hostname;
    return allowedOrigins.some(o => {
      try { return h === new URL(o).hostname; }
      catch { return false; }
    });
  } catch {
    return false;
  }
}
export function isValidDexScreenerResponse(data: unknown): data is DexScreenerResponse {
  if (!isObject(data)) return false;
  return Array.isArray(data.pairs) || data.pair !== undefined;
}

export function isValidRugCheckSummary(data: unknown): data is RugCheckSummary {
  if (!isObject(data)) return false;
  // Preserve the original "at least one of these keys is present" gate so
  // an empty response still fails fast. Zod adds the per-field type check.
  if (!("lpBurned" in data) && !("risks" in data) && !("error" in data)) return false;
  return RugCheckSummarySchema.safeParse(data).success;
}

// ─── RUNTIME TYPE GUARDS ─────────────────────────────────────────────────────

export function isHeliusLargestAccountsResponse(data: unknown): data is import("./types").HeliusLargestAccountsResponse {
  const parsed = HeliusLargestAccountsResponseSchema.safeParse(data);
  // The scoring layer expects `result.value` to be an array before it reads
  // holders from it. An empty/missing value is valid for Zod but useless to
  // us, so keep the stricter check here.
  return parsed.success && Array.isArray(parsed.data.result?.value);
}

export function isHeliusSupplyResponse(data: unknown): data is import("./types").HeliusSupplyResponse {
  const parsed = HeliusSupplyResponseSchema.safeParse(data);
  return parsed.success && parsed.data.result !== undefined;
}

export function isSolscanMarketsResponse(data: unknown): data is import("./types").SolscanMarketsResponse {
  if (!isObject(data)) return false;
  return Array.isArray(data.data);
}

export function isSolscanMeta(data: unknown): data is import("./types").SolscanMeta {
  if (!isObject(data)) return false;
  return "data" in data && isObject(data.data);
}

export function isSolscanTransfersResponse(data: unknown): data is import("./types").SolscanTransfersResponse {
  if (!isObject(data)) return false;
  return Array.isArray(data.data);
}

export function isRugCheckReport(data: unknown): data is import("./types").RugCheckReport {
  if (!isObject(data)) return false;
  if (!("risks" in data) && !("topHolders" in data) && !("totalHolders" in data)) return false;
  return RugCheckReportSchema.safeParse(data).success;
}

// ─── XSS SANITIZATION ────────────────────────────────────────────────────────
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function sanitizeString(val: string | null | undefined): string | null {
  if (val == null) return null;
  return String(val).replace(/[&<>"']/g, ch => HTML_ESCAPE_MAP[ch] || ch);
}

export function sanitizeUrl(val: string | null | undefined): string | null {
  if (val == null) return null;
  const s = String(val).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}
