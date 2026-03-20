// api/helpers.ts — Utility functions for Antares scan engine
// Re-exports split modules for backward compatibility

import type { VercelResponse } from "@vercel/node";
import type {
  Severity, ScanFlag,
  GoPlusTokenResult, GoPlusResponse,
  DexScreenerResponse, RugCheckSummary, RugCheckReport, RugCheckRisk,
} from "./types";

// Re-export split modules
export { asNumber, _mean, _std, _pct } from "./math";
export { setHeaders, withTimeout, fetchJson, fetchJsonPost } from "./http";

// Import for local use
import { asNumber } from "./math";

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function pickGoPlusResult(raw: unknown, ca: string): GoPlusTokenResult | null {
  if (!isObject(raw)) return null;
  const result = (raw as GoPlusResponse).result;
  if (!result || typeof result !== "object") return null;
  return result[ca] || result[ca.toLowerCase()] || result[ca.toUpperCase()] || null;
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

export function computeCacheTTL(tokenAgeMinutes: number | null): number {
  if (tokenAgeMinutes === null) return 20;
  if (tokenAgeMinutes < 60) return 15;
  if (tokenAgeMinutes < 1440) return 30;
  return 120;
}

export function apiError(res: VercelResponse, status: number, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: message, ...(details ? { details } : {}) });
}

export function isCorsAllowed(origin: string, allowedOrigins: string[]): boolean {
  return allowedOrigins.some(o => origin.startsWith(o)) || origin.startsWith("chrome-extension://");
}

export function isValidDexScreenerResponse(data: unknown): data is DexScreenerResponse {
  if (!isObject(data)) return false;
  return Array.isArray(data.pairs) || data.pair !== undefined;
}

export function isValidRugCheckSummary(data: unknown): data is RugCheckSummary {
  if (!isObject(data)) return false;
  return "lpBurned" in data || "risks" in data || "error" in data;
}

// ─── RUNTIME TYPE GUARDS ─────────────────────────────────────────────────────

export function isHeliusLargestAccountsResponse(data: unknown): data is import("./types").HeliusLargestAccountsResponse {
  if (!isObject(data)) return false;
  if (!("result" in data) || !isObject(data.result)) return false;
  return Array.isArray((data.result as Record<string, unknown>).value);
}

export function isHeliusSupplyResponse(data: unknown): data is import("./types").HeliusSupplyResponse {
  if (!isObject(data)) return false;
  if (!("result" in data) || !isObject(data.result)) return false;
  return "value" in (data.result as Record<string, unknown>);
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
  return "risks" in data || "topHolders" in data || "totalHolders" in data;
}
