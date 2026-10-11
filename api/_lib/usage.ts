// api/_lib/usage.ts — how much each upstream API is used, and what that costs.
//
// Why: the paid plans (Helius credits, GoPlus CU) and the free limits (GeckoTerminal 30 calls a minute, Gemini's daily quota) are
// only worth buying, or worth working around, once they are MEASURED. Until now nothing counted: a 429 vanished into a `null`.
//
// What is counted, per upstream provider and per UTC day, in one Redis hash (`usage:<YYYY-MM-DD>`, kept 40 days):
//   calls     requests sent (a retry is a request)            ok        answered (any status except the four below)
//   refused   429 / 503: the provider says "too many"        denied    401 / 403: the key or the plan is refused
//   failed    network error, timeout, 5xx                    skipped   not sent: the circuit breaker was open
//   credits   estimated units the provider bills (see CREDIT_BASIS), counted for answered requests only
//
// What is NOT kept: the URL, the key, the token address, anything that identifies a user. A counter is `<provider>:<field>`.
//
// Cost: counts accumulate in memory and are written with ONE Redis command (a Lua script) at the end of a cold scan, so the
// counting costs one Upstash command per cold scan and nothing on a cache hit.
import type { Redis } from "@upstash/redis";
import { PUBLIC_SOLANA_RPCS } from "./constants";
import { logger } from "./logger";

export type Provider = "helius" | "goplus" | "rugcheck" | "dexscreener" | "geckoterminal" | "solscan" | "gemini" | "publicrpc" | "other";
export type Field = "calls" | "ok" | "refused" | "denied" | "failed" | "skipped" | "credits";
export type ProviderUsage = Record<Field, number>;

const FIELDS: Field[] = ["calls", "ok", "refused", "denied", "failed", "skipped", "credits"];
export const PROVIDERS: Provider[] = ["helius", "goplus", "rugcheck", "dexscreener", "geckoterminal", "solscan", "gemini", "publicrpc", "other"];

/** What one "credit" means for each provider: an estimate to size a plan with, not an invoice. */
export const CREDIT_BASIS: Record<Provider, string> = {
  helius: "Helius credits, from the published table: RPC call 1, DAS call (getTokenAccounts...) 10, getProgramAccounts 10, Enhanced Transactions API 100",
  goplus: "ASSUMED 1 CU per request: the real cost of an endpoint is in your GoPlus dashboard",
  rugcheck: "1 per request (no credit system known)",
  dexscreener: "1 per request (public limit about 300 a minute)",
  geckoterminal: "1 per request (public limit 30 a minute per address)",
  solscan: "1 per request (Pro API: units depend on the plan)",
  gemini: "1 per request (the bill is in tokens, and the free quota in requests a day)",
  publicrpc: "1 per request (free, shared, often refused)",
  other: "1 per request",
};

// ── what a request is, from its address ─────────────────────────────────────────────────────────────────────────────────
const PUBLIC_RPC_HOSTS = new Set(PUBLIC_SOLANA_RPCS.map((u) => new URL(u).hostname));
const HOST_PROVIDERS: Array<[RegExp, Provider]> = [
  [/(^|\.)helius-rpc\.com$|(^|\.)helius\.xyz$|(^|\.)helius\.dev$/, "helius"],
  [/(^|\.)gopluslabs\.io$/, "goplus"],
  [/(^|\.)rugcheck\.xyz$/, "rugcheck"],
  [/(^|\.)dexscreener\.com$/, "dexscreener"],
  [/(^|\.)geckoterminal\.com$/, "geckoterminal"],
  [/(^|\.)solscan\.io$/, "solscan"],
  [/(^|\.)googleapis\.com$/, "gemini"],
];

/** Helius DAS methods are billed 10 credits, Enhanced Transactions / Mint API 100, every other RPC call 1 (getProgramAccounts 10). */
const HELIUS_TEN_CREDIT_METHODS = new Set([
  "getAsset", "getAssetBatch", "getAssetsByOwner", "getAssetsByGroup", "getAssetsByCreator", "getAssetsByAuthority", "searchAssets",
  "getAssetProof", "getAssetProofBatch", "getSignaturesForAsset", "getTokenAccounts", "getNftEditions", "getProgramAccounts",
]);

export function heliusCredits(pathname: string, rpcMethod: string | null): number {
  if (pathname.startsWith("/v0/")) return 100; // Enhanced Transactions / Mint API (REST)
  if (rpcMethod && HELIUS_TEN_CREDIT_METHODS.has(rpcMethod)) return 10;
  return 1;
}

export function classify(url: string, body?: unknown): { provider: Provider; credits: number } {
  let host = "";
  let pathname = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    pathname = u.pathname;
  } catch { /* an unparseable address is counted as "other" */ }
  if (PUBLIC_RPC_HOSTS.has(host)) return { provider: "publicrpc", credits: 1 };
  const provider = HOST_PROVIDERS.find(([re]) => re.test(host))?.[1] ?? "other";
  if (provider !== "helius") return { provider, credits: 1 };
  const method = body && typeof body === "object" && typeof (body as { method?: unknown }).method === "string" ? (body as { method: string }).method : null;
  return { provider, credits: heliusCredits(pathname, method) };
}

export function outcomeOf(status: number): "ok" | "refused" | "denied" | "failed" {
  if (status === 429 || status === 503) return "refused";
  if (status === 401 || status === 403) return "denied";
  if (status === 0 || status >= 500) return "failed"; // 0 = no answer (network error, timeout)
  return "ok";
}

// ── counting (in memory, then one write) ────────────────────────────────────────────────────────────────────────────────
let pending = new Map<string, number>();
const bump = (provider: Provider, field: Field, n = 1): void => { const k = `${provider}:${field}`; pending.set(k, (pending.get(k) ?? 0) + n); };

/** Count one request that was sent. `status` is the HTTP status, or 0 when nothing came back. Never throws. */
export function recordCall(url: string, status: number, body?: unknown): void {
  try {
    const { provider, credits } = classify(url, body);
    const outcome = outcomeOf(status);
    bump(provider, "calls");
    bump(provider, outcome);
    if (outcome === "ok") bump(provider, "credits", credits); // a refused or failed request is not billed
  } catch { /* counting must never break a scan */ }
}

/** Count one request that was NOT sent because the provider's circuit breaker is open. Never throws. */
export function recordSkipped(url: string): void {
  try { bump(classify(url).provider, "skipped"); } catch { /* see above */ }
}

/** What has been counted and not yet written (tests, and a quick look from a debugger). */
export function pendingUsage(): Record<string, number> { return Object.fromEntries(pending); }

// ── writing and reading ──────────────────────────────────────────────────────────────────────────────────────────────────
let redis: Redis | null = null;
export function initUsage(r: Redis | null): void { redis = r; }
export function _resetUsageForTests(): void { pending = new Map(); redis = null; }

const KEEP_DAYS = 40;
const dayKey = (d: Date): string => `usage:${d.toISOString().slice(0, 10)}`;
// ARGV[1] = ttl in seconds, then field / amount pairs. One command, whatever the number of counters.
const FLUSH_LUA = "local ttl = tonumber(ARGV[1]) for i = 2, #ARGV, 2 do redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1]) end redis.call('EXPIRE', KEYS[1], ttl) return 1";

/**
 * Write what has been counted (one Redis command). Bounded by `maxWaitMs`: a slow Redis must not slow the answer to the user, and
 * counts that could not be written are dropped, not queued (a usage figure is an estimate, a scan is not).
 */
export async function flushUsage(maxWaitMs = 300): Promise<void> {
  if (!redis || pending.size === 0) return;
  const batch = pending;
  pending = new Map();
  const args: string[] = [String(KEEP_DAYS * 86400)];
  for (const [field, n] of batch) args.push(field, String(n));
  // A failure is logged here, so a write that loses the race against the timeout cannot surface later as an unhandled rejection.
  const failed = (e: unknown): void => { logger.warn("usage", "usage counters not written", { error: String(e) }); };
  let write: Promise<void>;
  try {
    // The call itself can throw before returning a promise (a client without `eval`, a bad argument): counting must NEVER break a scan.
    write = Promise.resolve(redis.eval(FLUSH_LUA, [dayKey(new Date())], args)).then(() => undefined, failed);
  } catch (e) { failed(e); return; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, maxWaitMs); });
  try { await Promise.race([write, timeout]); } finally { clearTimeout(timer); }
}

export interface UsageReport {
  /** UTC dates, oldest first. */
  days: Array<{ date: string; providers: Partial<Record<Provider, ProviderUsage>> }>;
  totals: Partial<Record<Provider, ProviderUsage>>;
  basis: Record<Provider, string>;
}

const empty = (): ProviderUsage => ({ calls: 0, ok: 0, refused: 0, denied: 0, failed: 0, skipped: 0, credits: 0 });

/** The last `days` days (1 to 31) of counters, per provider, with totals. */
export async function readUsage(days: number, now: Date = new Date()): Promise<UsageReport> {
  const n = Math.min(31, Math.max(1, Math.floor(days) || 1));
  const dates: string[] = [];
  for (let i = n - 1; i >= 0; i--) dates.push(new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10));
  const rows = redis ? await Promise.all(dates.map((d) => redis!.hgetall<Record<string, number | string>>(`usage:${d}`).catch(() => null))) : dates.map(() => null);
  const totals: Partial<Record<Provider, ProviderUsage>> = {};
  const out: UsageReport["days"] = dates.map((date, i) => {
    const providers: Partial<Record<Provider, ProviderUsage>> = {};
    for (const [field, raw] of Object.entries(rows[i] ?? {})) {
      const [p, f] = field.split(":") as [Provider, Field];
      if (!PROVIDERS.includes(p) || !FIELDS.includes(f)) continue;
      const v = Number(raw) || 0;
      (providers[p] ??= empty())[f] += v;
      (totals[p] ??= empty())[f] += v;
    }
    return { date, providers };
  });
  return { days: out, totals, basis: CREDIT_BASIS };
}
