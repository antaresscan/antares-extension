// __tests__/replay/harness.ts
//
// Runs the REAL /api/scan handler on recorded upstream responses: every outgoing HTTP request of the scan is answered from
// the recording of a real scan (DexScreener, RugCheck, GoPlus, Helius, GeckoTerminal), the clock is set to the instant of
// the capture (token age, pump windows, candle recency), and nothing else is faked: schemas, fetchers, layers, scoring and
// verdict all run for real. So a pull request that changes any of them changes the replayed verdicts, and the replay says so.
//
// The environment is the one of the capture, minus what a replay has no use for: no Redis (the cache and the rate limiters
// fail open), no Gemini (the summary falls back to the local one), no GoPlus credentials (the same anonymous URL is asked).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { vi } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { canonicalKey, exchangeKey, redactUrl } from "./keys";
import { normalizeScan, type NormalizedScan } from "./normalize";
import { parseBulk, type BulkToken } from "./bulk";

/** `x` is set when the request FAILED (timeout, abort) instead of being answered: the replay fails it the same way. */
interface RecordedExchange { k: string; s: number; c: string | null; t: string; x?: string }
/** `degraded` names what was throttled (GeckoTerminal, the chart source) when the scan was recorded and could not be had again. */
export interface Recording { symbol: string; mint: string; capturedAt: number; exchanges: RecordedExchange[]; live: NormalizedScan; degraded?: string[] }
export interface ReplayOutcome { status: number; body: Record<string, unknown> | null; result: NormalizedScan; misses: string[] }

const HERE = fileURLToPath(new URL("./", import.meta.url));
const CORPUS_DIR = `${HERE}corpus/`;

/** One recording per token, named after its mint (symbols are not unique), compressed with brotli. */
export function loadRecording(mint: string): Recording | null {
  const file = `${CORPUS_DIR}${mint}.json.br`;
  return existsSync(file) ? (JSON.parse(brotliDecompressSync(readFileSync(file)).toString("utf8")) as Recording) : null;
}

export function recordedMints(): string[] {
  return existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json.br")).map((f) => f.replace(/\.json\.br$/, "")).sort() : [];
}

export function loadBulk(): BulkToken[] {
  return parseBulk(readFileSync(`${HERE}bulk.json`, "utf8"));
}

/**
 * The scan builds the insider graph (Helius getSignaturesForAddress + enhanced transactions) AFTER the verdict is final: it only
 * feeds the Critical Actors cards and the holder activity rows of the response (api/scan.ts, composeCriticalActors and
 * composeHolderActivity), and weighs more than all the other calls of a recording together. So it is not recorded; when a scan
 * asks for it, the replay answers "no activity" instead of counting a missing request. (A recording made before that decision may
 * still hold these calls: a recorded answer always wins.)
 */
function insiderGraphAnswer(href: string, body: string | null): Response | null {
  if (/api\.helius\.xyz\/v0\/transactions/.test(href)) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  if (/helius-rpc\.com/.test(href) && body && /"method"\s*:\s*"getSignaturesForAddress"/.test(body)) {
    let id: unknown = 1;
    try { id = (JSON.parse(body) as { id?: unknown }).id ?? 1; } catch { /* keep 1 */ }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return null;
}

/**
 * The all-time high of a token (api/_lib/ath.ts asks CoinGecko for it) is not a fact of the capture instant, so it is not in each recording: the replay answers that
 * request from one table (ath.json, built by scripts/replay/ath-table.ts from CoinGecko's market data). A token that is not in the table gets CoinGecko's own "not found"
 * (404), which is what the engine would see. A recording that holds the request itself (a capture made since the engine asks for it) always wins.
 */
let athTable: Record<string, { ath: number; athDate: string | null }> | null = null;
/** The day of a table date (ISO text or null) as the number Solscan sends, 20250114. */
function solscanDayOf(athDate: string | null, shiftDays = 0): number {
  const t = athDate ? Date.parse(athDate) : Date.parse("2024-01-01T00:00:00Z");
  return Number(new Date(t + shiftDays * 86_400_000).toISOString().slice(0, 10).replace(/-/g, ""));
}

function athAnswer(href: string, down = false, viaSolscan?: number): Response | null {
  const json = { "content-type": "application/json" };
  // Solscan is asked first (api/_lib/ath.ts) when the recording holds Solscan calls. Its price history is not recorded either. By default the replay answers "no price for this
  // token" (an answer, 200 without a row), so that the high comes from the table through the CoinGecko request, as it always did in the replay. With `viaSolscan` (a factor) it
  // answers from the same table the way a DAILY series would: the highest day at factor x CoinGecko's intraday high, with lower days around it.
  const sp = href.match(/^https:\/\/pro-api\.solscan\.io\/v2\.0\/token\/price\?address=([^&]+)/);
  if (sp) {
    if (viaSolscan === undefined) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: json });
    athTable ??= (JSON.parse(readFileSync(`${HERE}ath.json`, "utf8")) as { tokens: Record<string, { ath: number; athDate: string | null }> }).tokens;
    const t = athTable[decodeURIComponent(sp[1])];
    if (!t) return new Response(JSON.stringify({ success: true, data: [] }), { status: 200, headers: json });
    const top = t.ath * viaSolscan;
    const data = [{ date: solscanDayOf(t.athDate, -1), price: top * 0.8 }, { date: solscanDayOf(t.athDate), price: top }, { date: solscanDayOf(t.athDate, 1), price: top * 0.8 }];
    return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: json });
  }
  // Every other Solscan request of a scan that was not recorded: "nothing for this token" (a 404 is an answer: it does not trip the key backoff nor the circuit breaker).
  if (viaSolscan !== undefined && /^https:\/\/pro-api\.solscan\.io\//.test(href)) return new Response("{}", { status: 404, headers: json });
  const m = href.match(/^https:\/\/api\.coingecko\.com\/api\/v3\/coins\/solana\/contract\/([^?/]+)\?/);
  if (!m) return null;
  if (down) return new Response("replay: CoinGecko is down", { status: 503 }); // a test of what a scan does when CoinGecko does not answer
  athTable ??= (JSON.parse(readFileSync(`${HERE}ath.json`, "utf8")) as { tokens: Record<string, { ath: number; athDate: string | null }> }).tokens;
  const t = athTable[decodeURIComponent(m[1])];
  const headers = { "content-type": "application/json" };
  return t
    ? new Response(JSON.stringify({ id: "replay", market_data: { ath: { usd: t.ath }, ath_date: { usd: t.athDate } } }), { status: 200, headers })
    : new Response(JSON.stringify({ error: "coin not found" }), { status: 404, headers });
}

const UNSET = ["GEMINI_API_KEY", "GOPLUS_APP_KEY", "GOPLUS_APP_SECRET", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "SENTRY_DSN", "VERCEL_ENV", "LOG_LEVEL"];

function fakeRes() {
  let status = 200;
  let body: Record<string, unknown> | null = null;
  const res = {
    setHeader: () => res,
    status: (code: number) => { status = code; return res; },
    json: (data: Record<string, unknown>) => { body = data; return res; },
    end: () => res,
  };
  return { res: res as unknown as VercelResponse, get: () => ({ status, body }) };
}

/** Replays the scan of one recording through the real handler. */
/**
 * `athDown`: CoinGecko answers 503 to the all-time-high request (a test of what a scan does without it).
 * `athViaSolscan`: Solscan has a key and answers the price history with a daily series whose highest day is that factor of CoinGecko's high (a test that the daily high does not move a verdict).
 */
export async function replayScan(rec: Recording, opts: { athDown?: boolean; athViaSolscan?: number } = {}): Promise<ReplayOutcome> {
  const byKey = new Map<string, RecordedExchange[]>();
  for (const e of rec.exchanges) { const k = canonicalKey(e.k); byKey.set(k, [...(byKey.get(k) ?? []), e]); }
  const used = new Map<string, number>();
  const misses: string[] = [];

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? (typeof input === "object" && "method" in input ? (input as Request).method : "GET");
    const authorized = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined)).has("authorization");
    // GoPlus' token exchange is never recorded (its body carries the app key and a signature). When the recording holds an
    // authenticated GoPlus call, the replay gives fake credentials and answers the exchange itself, so the engine makes the
    // same sequence of calls as in the capture (authenticated, then anonymous if that one was rate limited).
    if (/gopluslabs\.io\/api\/v1\/token(\?|$)/.test(href) && method.toUpperCase() === "POST") {
      return new Response(JSON.stringify({ code: 1, message: "OK", result: { access_token: "Bearer replay-token", expires_in: 7200 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = init?.body == null ? null : String(init.body);
    // With \`athViaSolscan\` Solscan ACCEPTS the key: what the recordings hold of it (the 401 of the days the key was refused) is not what it answers, and a 401 would pause it.
    if (opts.athViaSolscan !== undefined) {
      const solscan = athAnswer(href, false, opts.athViaSolscan);
      if (solscan && /pro-api\.solscan\.io/.test(href)) return solscan;
    }
    const key = exchangeKey(method, href, body, authorized);
    const list = byKey.get(key);
    if (!list) {
      const graph = insiderGraphAnswer(href, body);
      if (graph) return graph;
      const ath = athAnswer(href, opts.athDown === true, opts.athViaSolscan);
      if (ath) return ath;
      misses.push(`${method.toUpperCase()} ${redactUrl(href)}`);
      if (process.env.REPLAY_DEBUG) console.log(`[replay] not recorded: ${method.toUpperCase()} ${redactUrl(href)} ${init?.body ? String(init.body).slice(0, 160) : ""}`);
      return new Response("replay: this request was not recorded", { status: 599 });
    }
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const ex = list[Math.min(n, list.length - 1)]; // a repeated request gets the last recorded answer again
    if (ex.x) throw Object.assign(new Error("replay: the recorded request failed"), { name: ex.x });
    return new Response(ex.t, { status: ex.s, headers: ex.c ? { "content-type": ex.c } : {} });
  }) as typeof fetch;

  for (const name of UNSET) vi.stubEnv(name, undefined);
  // The golden file is the FULL scan, which only a Pro caller receives (api/_lib/pro-gate.ts): the replay asks as a Pro install.
  vi.stubEnv("DEV_PRO_INSTALLS", "replay-pro-install");
  vi.stubEnv("HELIUS_API_KEY", "replay-key"); // the capture had keys: the same calls are made, and answered from the recording
  // Solscan: the engine pauses it for 10 minutes after a 401, so a recording made after the first 401 of its instance holds
  // no Solscan call at all. The replay gives a key only when the recording has such calls (and then answers them as recorded).
  if (opts.athViaSolscan !== undefined || rec.exchanges.some((e) => e.k.includes("pro-api.solscan.io"))) vi.stubEnv("SOLSCAN_API_KEY", "replay-key");
  else vi.stubEnv("SOLSCAN_API_KEY", undefined);
  // GoPlus: credentials only when the recording holds an authenticated call (see the token exchange above).
  if (rec.exchanges.some((e) => e.k.includes("gopluslabs.io/api/v1/solana/token_security") && e.k.endsWith(" #auth"))) {
    vi.stubEnv("GOPLUS_APP_KEY", "replay-key");
    vi.stubEnv("GOPLUS_APP_SECRET", "replay-secret");
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(rec.capturedAt);
  vi.resetModules(); // a scan starts from fresh module state (circuit breakers, caches, back-offs)
  // The engine logs every scan (metrics, warnings for the recorded 4xx answers): silent unless REPLAY_DEBUG is set.
  const quiet = process.env.REPLAY_DEBUG ? [] : (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  try {
    const { default: handler } = await import("../../api/scan");
    const out = fakeRes();
    await handler(
      { method: "GET", query: { ca: rec.mint, fresh: "1" }, headers: { origin: "https://dexscreener.com", "x-forwarded-for": "203.0.113.7", "x-antares-install": "replay-pro-install" }, socket: { remoteAddress: "203.0.113.7" } } as unknown as VercelRequest,
      out.res,
    );
    const { status, body } = out.get();
    return { status, body, result: normalizeScan(body), misses };
  } finally {
    for (const spy of quiet) spy.mockRestore();
    globalThis.fetch = realFetch;
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
}
