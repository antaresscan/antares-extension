// scripts/backtest/fetch-snapshot.ts
//
// Build a TokenSnapshot for a given mint by hitting the same upstream
// APIs the runtime scanner uses. The function takes its `fetch` impl as
// a parameter so tests can inject a mock without touching the global.
//
// Each upstream source is independent: a failure or null in one source
// produces a `null` field in the snapshot, never a throw. The caller
// (the auto-label pipeline) already treats `null` as "rule abstains",
// so partial data degrades gracefully instead of poisoning the corpus.

import type { TokenSnapshot } from "./types";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const HELIUS_BASE = "https://mainnet.helius-rpc.com";

const SOLANA_CHAIN_ID = "101";

export type FetchLike = typeof fetch;

export interface FetchSnapshotEnv {
  heliusKey: string | null;
}

interface PartialSnapshot {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  tokenAgeHours: number | null;
  holderCount: number | null;
  top1HolderPct: number | null;
  mintAuthorityActive: boolean | null;
  freezeAuthorityActive: boolean | null;
  honeypot: boolean | null;
  lpBurned: boolean | null;
  lpLocked: boolean | null;
  rugcheckClassification: "safe" | "danger" | "rug" | null;
  solscanScamFlag: boolean | null;
}

const EMPTY: PartialSnapshot = {
  liquidityUsd: null,
  volume24hUsd: null,
  tokenAgeHours: null,
  holderCount: null,
  top1HolderPct: null,
  mintAuthorityActive: null,
  freezeAuthorityActive: null,
  honeypot: null,
  lpBurned: null,
  lpLocked: null,
  rugcheckClassification: null,
  solscanScamFlag: null,
};

export async function fetchSnapshot(
  ca: string,
  env: FetchSnapshotEnv,
  fetchImpl: FetchLike = fetch,
): Promise<TokenSnapshot> {
  const capturedAt = Math.floor(Date.now() / 1000);

  const [dex, helius, goPlus, rugCheck] = await Promise.allSettled([
    fetchDexScreener(ca, fetchImpl),
    env.heliusKey ? fetchHelius(ca, env.heliusKey, fetchImpl) : Promise.resolve(null),
    fetchGoPlus(ca, fetchImpl),
    fetchRugCheck(ca, fetchImpl),
  ]);

  const merged: PartialSnapshot = { ...EMPTY };
  applyResult(merged, dex);
  applyResult(merged, helius);
  applyResult(merged, goPlus);
  applyResult(merged, rugCheck);

  return { ca, capturedAt, ...merged };
}

function applyResult(target: PartialSnapshot, r: PromiseSettledResult<Partial<PartialSnapshot> | null>): void {
  if (r.status !== "fulfilled" || r.value == null) return;
  // Don't overwrite a real value with null from a less-authoritative source.
  const src = r.value;
  if (src.liquidityUsd != null && target.liquidityUsd == null) target.liquidityUsd = src.liquidityUsd;
  if (src.volume24hUsd != null && target.volume24hUsd == null) target.volume24hUsd = src.volume24hUsd;
  if (src.tokenAgeHours != null && target.tokenAgeHours == null) target.tokenAgeHours = src.tokenAgeHours;
  if (src.holderCount != null && target.holderCount == null) target.holderCount = src.holderCount;
  if (src.top1HolderPct != null && target.top1HolderPct == null) target.top1HolderPct = src.top1HolderPct;
  if (src.mintAuthorityActive != null && target.mintAuthorityActive == null) target.mintAuthorityActive = src.mintAuthorityActive;
  if (src.freezeAuthorityActive != null && target.freezeAuthorityActive == null) target.freezeAuthorityActive = src.freezeAuthorityActive;
  if (src.honeypot != null && target.honeypot == null) target.honeypot = src.honeypot;
  if (src.lpBurned != null && target.lpBurned == null) target.lpBurned = src.lpBurned;
  if (src.lpLocked != null && target.lpLocked == null) target.lpLocked = src.lpLocked;
  if (src.rugcheckClassification != null && target.rugcheckClassification == null) target.rugcheckClassification = src.rugcheckClassification;
  if (src.solscanScamFlag != null && target.solscanScamFlag == null) target.solscanScamFlag = src.solscanScamFlag;
}

// ─── DexScreener ─────────────────────────────────────────────────────
// Source of truth for liquidity, 24h volume, and token age (via the
// oldest pair's createdAt). Aggregates across all pairs because a token
// can have liquidity split across Raydium / Orca / Meteora.

interface DexPair {
  pairCreatedAt?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

async function fetchDexScreener(ca: string, fetchImpl: FetchLike): Promise<Partial<PartialSnapshot> | null> {
  const r = await fetchImpl(`${DEXSCREENER_BASE}/tokens/${ca}`);
  if (!r.ok) return null;
  const data = (await r.json()) as { pairs?: DexPair[] };
  const pairs = data.pairs ?? [];
  if (pairs.length === 0) return null;

  let liquidityUsd = 0;
  let volume24hUsd = 0;
  let oldestCreatedMs: number | null = null;

  for (const p of pairs) {
    if (typeof p.liquidity?.usd === "number") liquidityUsd += p.liquidity.usd;
    if (typeof p.volume?.h24 === "number") volume24hUsd += p.volume.h24;
    if (typeof p.pairCreatedAt === "number") {
      if (oldestCreatedMs == null || p.pairCreatedAt < oldestCreatedMs) {
        oldestCreatedMs = p.pairCreatedAt;
      }
    }
  }

  const tokenAgeHours =
    oldestCreatedMs != null ? Math.max(0, (Date.now() - oldestCreatedMs) / 3_600_000) : null;

  return {
    liquidityUsd: liquidityUsd > 0 ? liquidityUsd : null,
    volume24hUsd: volume24hUsd > 0 ? volume24hUsd : null,
    tokenAgeHours,
  };
}

// ─── Helius ──────────────────────────────────────────────────────────
// We use Helius for two things the other sources don't expose
// authoritatively: top-1 holder concentration (via getTokenLargestAccounts
// + getTokenSupply) and total holder count (via the same call's array
// length, capped by Solana's 20-row response cap — good enough for the
// corpus's "is there meaningful distribution?" question).

interface HeliusRpcResponse<T> {
  result?: T;
  error?: { message: string };
}

async function fetchHelius(
  ca: string,
  key: string,
  fetchImpl: FetchLike,
): Promise<Partial<PartialSnapshot> | null> {
  const url = `${HELIUS_BASE}/?api-key=${encodeURIComponent(key)}`;

  const [largestRaw, supplyRaw] = await Promise.allSettled([
    rpc<{ value: Array<{ amount: string; uiAmount: number | null }> }>(url, "getTokenLargestAccounts", [ca], fetchImpl),
    rpc<{ value: { amount: string; decimals: number; uiAmount: number | null } }>(url, "getTokenSupply", [ca], fetchImpl),
  ]);

  const largest = settled(largestRaw);
  const supply = settled(supplyRaw);
  if (!largest && !supply) return null;

  const holders = largest?.value ?? [];
  const totalUi = supply?.value.uiAmount ?? null;
  const top1Ui = holders[0]?.uiAmount ?? null;

  const top1HolderPct =
    top1Ui != null && totalUi != null && totalUi > 0 ? (top1Ui / totalUi) * 100 : null;

  // getTokenLargestAccounts returns up to 20 accounts; for a corpus
  // entry, "20+ holders" is what we report and the auto-label rule
  // treats <500 as suspect anyway. This is intentionally a floor, not
  // an exact count — exact count would need a paginated DAS call.
  const holderCount = holders.length > 0 ? holders.length : null;

  return { top1HolderPct, holderCount };
}

async function rpc<T>(url: string, method: string, params: unknown[], fetchImpl: FetchLike): Promise<T | null> {
  const r = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) return null;
  const data = (await r.json()) as HeliusRpcResponse<T>;
  if (data.error) return null;
  return data.result ?? null;
}

function settled<T>(r: PromiseSettledResult<T | null>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

// ─── GoPlus ──────────────────────────────────────────────────────────
// Source of truth for honeypot, authority status, and LP burn/lock —
// the same reading we trust at runtime in the layerRugCheck path.

interface GoPlusDexEntry {
  liquidity_type?: string;
  liquidity?: string;
  burn_percent?: number;
}

interface GoPlusTokenResult {
  is_honeypot?: string | number | boolean;
  cannot_sell_all?: string | number | boolean;
  mintable?: { status?: string | number };
  freezable?: { status?: string | number };
  dex?: GoPlusDexEntry[];
}

async function fetchGoPlus(ca: string, fetchImpl: FetchLike): Promise<Partial<PartialSnapshot> | null> {
  const r = await fetchImpl(`${GOPLUS_BASE}/solana/token_security?contract_addresses=${ca}`);
  if (!r.ok) return null;
  const data = (await r.json()) as { result?: Record<string, GoPlusTokenResult> };
  const result = data.result?.[ca] ?? data.result?.[ca.toLowerCase()];
  if (!result) return null;

  const truthy = (v: unknown): boolean => v === "1" || v === 1 || v === true;

  const honeypot = truthy(result.is_honeypot) || truthy(result.cannot_sell_all);
  const mintAuthorityActive = truthy(result.mintable?.status);
  const freezeAuthorityActive = truthy(result.freezable?.status);

  // LP burn detection follows the rule established in #fix-lp-goplus-detection:
  // GoPlus reports burn_percent per pool; if the largest pool is fully burned
  // (>=99%) we treat LP as burned. Locked is reported separately on liquidity_type.
  let lpBurned: boolean | null = null;
  let lpLocked: boolean | null = null;
  if (Array.isArray(result.dex) && result.dex.length > 0) {
    const sorted = [...result.dex].sort((a, b) => Number(b.liquidity ?? 0) - Number(a.liquidity ?? 0));
    const top = sorted[0];
    if (typeof top.burn_percent === "number") lpBurned = top.burn_percent >= 99;
    if (typeof top.liquidity_type === "string") lpLocked = top.liquidity_type.toLowerCase() === "locked";
  }

  return { honeypot, mintAuthorityActive, freezeAuthorityActive, lpBurned, lpLocked };
}

// ─── RugCheck ────────────────────────────────────────────────────────
// We map their numeric score to one of three classification buckets.
// Their `risks` array is richer but a single classification is what the
// auto-label oracle expects.

interface RugCheckSummary {
  score?: number;
  risks?: Array<{ name?: string; level?: string }>;
}

async function fetchRugCheck(ca: string, fetchImpl: FetchLike): Promise<Partial<PartialSnapshot> | null> {
  const r = await fetchImpl(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`);
  if (!r.ok) return null;
  const data = (await r.json()) as RugCheckSummary;
  return { rugcheckClassification: classifyRugCheck(data) };
}

export function classifyRugCheck(data: RugCheckSummary | null): "safe" | "danger" | "rug" | null {
  if (!data) return null;
  // Their score is "danger points": higher = more dangerous. Buckets here
  // mirror the runtime SAFE_GATE thresholds so backtest oracle agrees with
  // what we'd flag at scan time.
  const s = typeof data.score === "number" ? data.score : null;
  const danger = (data.risks ?? []).some(r => r.level === "danger");
  if (s != null && s >= 30000) return "rug";
  if (danger || (s != null && s >= 10000)) return "danger";
  if (s != null && s < 5000) return "safe";
  return null;
}
