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
import { exchangeKey, redactUrl } from "./keys";
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
export async function replayScan(rec: Recording): Promise<ReplayOutcome> {
  const byKey = new Map<string, RecordedExchange[]>();
  for (const e of rec.exchanges) byKey.set(e.k, [...(byKey.get(e.k) ?? []), e]);
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
    const key = exchangeKey(method, href, body, authorized);
    const list = byKey.get(key);
    if (!list) {
      const graph = insiderGraphAnswer(href, body);
      if (graph) return graph;
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
  vi.stubEnv("HELIUS_API_KEY", "replay-key"); // the capture had keys: the same calls are made, and answered from the recording
  // Solscan: the engine pauses it for 10 minutes after a 401, so a recording made after the first 401 of its instance holds
  // no Solscan call at all. The replay gives a key only when the recording has such calls (and then answers them as recorded).
  if (rec.exchanges.some((e) => e.k.includes("pro-api.solscan.io"))) vi.stubEnv("SOLSCAN_API_KEY", "replay-key");
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
      { method: "GET", query: { ca: rec.mint, fresh: "1" }, headers: { origin: "https://dexscreener.com", "x-forwarded-for": "203.0.113.7" }, socket: { remoteAddress: "203.0.113.7" } } as unknown as VercelRequest,
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
