import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ---- Mock all external modules BEFORE importing handler ----

// Mock @upstash/redis
vi.mock("@upstash/redis", () => {
  class MockRedis {
    get = vi.fn().mockResolvedValue(null);
    setex = vi.fn().mockResolvedValue("OK");
  }
  return { Redis: MockRedis };
});

// Mock @upstash/ratelimit
vi.mock("@upstash/ratelimit", () => {
  class MockRatelimit {
    limit = vi.fn().mockResolvedValue({ success: true, remaining: 29 });
    static slidingWindow = vi.fn();
  }
  return { Ratelimit: MockRatelimit };
});

// Mock middleware — pass through
vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>("../api/_lib/middleware");
  return {
    ...actual,
    initRateLimiters: vi.fn(),
    checkRateLimit: vi.fn().mockResolvedValue(true),
  };
});

// Mock cache — short-cache helper replaces the ad-hoc getCacheRedis().setex
// call site that used to exist in scan.ts. The setex spy lives only to
// keep test introspection consistent with the previous version, in case
// any downstream assertion still pokes at it.
const mockSetex = vi.fn().mockResolvedValue("OK");
vi.mock("../api/_lib/cache", () => ({
  initCache: vi.fn(),
  getCachedResult: vi.fn().mockResolvedValue(null),
  setCachedResult: vi.fn(),
  setShortCachedResult: vi.fn(),
  // The memory of the last time an issuer-backed token's market was read: none by default.
  getLastGoodResult: vi.fn().mockResolvedValue(null),
  setLastGoodResult: vi.fn(),
  // Single-flight lock: acquire always wins (fail-open), waiter no-ops, in
  // unit tests so the handler proceeds straight to runAnalysis as before.
  acquireScanLock: vi.fn().mockResolvedValue(true),
  releaseScanLock: vi.fn().mockResolvedValue(undefined),
  waitForCachedResult: vi.fn().mockResolvedValue(null),
  getCacheRedis: vi.fn().mockReturnValue({ setex: mockSetex }),
}));

// Mock @sentry/node
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

// Mock fetchers
const mockHeliusGetLargestAccounts = vi.fn();
const mockHeliusGetTokenSupply = vi.fn();
const mockHeliusGetMintAccount = vi.fn();
const mockHeliusGetCreatorReputation = vi.fn();
const mockHeliusGetHoldersCount = vi.fn();
const mockHeliusGetProgramAccountHolderCount = vi.fn();
const mockFetchSolscan = vi.fn();
const mockFetchDexCandles = vi.fn();
const mockHeliusResolveAccountOwners = vi.fn();
const mockPublicRpcGetLargestAccounts = vi.fn();
const mockPublicRpcGetTokenSupply = vi.fn();
const mockPublicRpcGetMintInfo = vi.fn();
const mockPublicRpcGetMintAccount = vi.fn();

// getAccountInfo(jsonParsed) on a mint, in the real shape (supply + authorities, as the Helius call now returns).
// Defaults: a classic mint, 100,000 supply, both authorities renounced.
function mintAccountResponse(o: { supply?: number; decimals?: number; mintAuthority?: string | null; freezeAuthority?: string | null; program?: string; extensions?: string[] } = {}) {
  const decimals = o.decimals ?? 0;
  return {
    result: {
      value: {
        data: {
          program: o.program ?? "spl-token",
          parsed: {
            type: "mint",
            info: {
              decimals,
              supply: String((o.supply ?? 100000) * 10 ** decimals),
              mintAuthority: o.mintAuthority ?? null,
              freezeAuthority: o.freezeAuthority ?? null,
              ...(o.extensions ? { extensions: o.extensions.map((extension) => ({ extension })) } : {}),
            },
          },
        },
      },
    },
  };
}

vi.mock("../api/_lib/fetchers", () => ({
  heliusGetLargestAccounts: (...args: unknown[]) => mockHeliusGetLargestAccounts(...args),
  heliusGetTokenSupply: (...args: unknown[]) => mockHeliusGetTokenSupply(...args),
  heliusGetMintAccount: (...args: unknown[]) => mockHeliusGetMintAccount(...args),
  heliusGetHolderPages: vi.fn().mockResolvedValue(null), // no chain holder count in these tests
  heliusGetCreatorReputation: (...args: unknown[]) => mockHeliusGetCreatorReputation(...args),
  heliusGetHoldersCount: (...args: unknown[]) => mockHeliusGetHoldersCount(...args),
  heliusGetProgramAccountHolderCount: (...args: unknown[]) => mockHeliusGetProgramAccountHolderCount(...args),
  fetchSolscan: (...args: unknown[]) => mockFetchSolscan(...args),
  fetchDexCandles: (...args: unknown[]) => mockFetchDexCandles(...args),
  fetchDexCandlesDaily: vi.fn().mockResolvedValue([]), // no daily candles in unit tests
  heliusResolveAccountOwners: (...args: unknown[]) => mockHeliusResolveAccountOwners(...args),
  publicRpcGetLargestAccounts: (...args: unknown[]) => mockPublicRpcGetLargestAccounts(...args),
  publicRpcGetTokenSupply: (...args: unknown[]) => mockPublicRpcGetTokenSupply(...args),
  publicRpcGetMintInfo: (...args: unknown[]) => mockPublicRpcGetMintInfo(...args),
  publicRpcGetMintAccount: (...args: unknown[]) => mockPublicRpcGetMintAccount(...args),
}));

// Mock global fetch for DexScreener, RugCheck, GoPlus
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---- Helpers ----
function createMockReq(query: Record<string, string> = {}, method = "GET"): VercelRequest {
  return {
    method,
    query,
    headers: { origin: "https://dexscreener.com", "x-forwarded-for": "1.2.3.4", "x-antares-install": "test-pro-install-0001" },
    socket: { remoteAddress: "1.2.3.4" },
  } as unknown as VercelRequest;
}

function createMockRes(): VercelResponse {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;

  const res: Record<string, unknown> = {
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    status: vi.fn(),
    json: vi.fn(),
    end: vi.fn(),
    getStatusCode: () => statusCode,
    getBody: () => body,
    getHeaders: () => headers,
  };
  (res.status as ReturnType<typeof vi.fn>).mockImplementation((code: number) => { statusCode = code; return res; });
  (res.json as ReturnType<typeof vi.fn>).mockImplementation((data: unknown) => { body = data; return res; });
  (res.end as ReturnType<typeof vi.fn>).mockImplementation(() => res);
  return res as unknown as VercelResponse;
}

// Standard mock responses for a "good" token
function setupGoodTokenMocks() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes("dexscreener")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          pairs: [{
            pairAddress: "pair1",
            baseToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL", name: "Wrapped SOL" },
            liquidity: { usd: 500000 },
            volume: { h24: 200000, h1: 50000 },
            priceChange: { m5: 1.2, h1: 3.5, h6: 8, h24: 12 },
            txns: { m5: { buys: 15, sells: 12 } },
            priceUsd: "150.25",
            marketCap: 50000000,
            fdv: 50000000,
            pairCreatedAt: Date.now() - 90 * 24 * 3600 * 1000,
            info: {
              socials: [{ type: "twitter", url: "https://twitter.com/test" }],
              websites: [{ url: "https://test.com" }],
              imageUrl: "https://img.test.com/icon.png",
            },
          }],
        }),
      });
    }
    if (url.includes("rugcheck") && url.includes("summary")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          lpBurned: true,
          lpLocked: false,
          metaMutable: false,
          topHolders: { top10Percentage: 25, top1Percentage: 5 },
          risks: [],
        }),
      });
    }
    if (url.includes("rugcheck") && url.includes("report")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          risks: [],
          topHolders: { top10Percentage: 25, top1Percentage: 5 },
          totalHolders: 5000,
        }),
      });
    }
    if (url.includes("gopluslabs")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          result: {
            So11111111111111111111111111111111111111112: {
              mint_authority: "0",
              freeze_authority: "0",
            },
          },
        }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });

  mockHeliusGetLargestAccounts.mockResolvedValue({
    result: {
      value: [
        { address: "holder1", uiAmount: 1000 },
        { address: "holder2", uiAmount: 800 },
        { address: "holder3", uiAmount: 600 },
      ],
    },
  });
  mockHeliusResolveAccountOwners.mockImplementation(async (holders: Record<string, unknown>[]) =>
    holders.map((h: Record<string, unknown>) => ({ ...h, owner: h.owner || h.address }))
  );
  mockHeliusGetMintAccount.mockResolvedValue(mintAccountResponse());
  mockPublicRpcGetMintAccount.mockResolvedValue(null);
  mockHeliusGetCreatorReputation.mockResolvedValue(null);
  mockHeliusGetHoldersCount.mockResolvedValue(null);
  mockHeliusGetProgramAccountHolderCount.mockResolvedValue(null);
  mockPublicRpcGetLargestAccounts.mockResolvedValue(null);
  mockPublicRpcGetTokenSupply.mockResolvedValue(null);
  mockPublicRpcGetMintInfo.mockResolvedValue(null);
  mockFetchSolscan.mockImplementation((endpoint: string) => {
    if (endpoint.includes("meta")) {
      return Promise.resolve({
        data: {
          created_time: Math.floor(Date.now() / 1000) - 90 * 24 * 3600,
          icon: "https://img.test.com/icon.png",
          creator: "creator123",
          decimals: 9,
          supply: 100000,
        },
      });
    }
    if (endpoint.includes("transfer")) {
      return Promise.resolve({ data: [] });
    }
    if (endpoint.includes("markets")) {
      return Promise.resolve({
        data: [{ liquidity: 500000, volume: 200000, trade: 1000, trader: 500 }],
      });
    }
    return Promise.resolve(null);
  });
  mockFetchDexCandles.mockResolvedValue([
    { ts: 1, o: 100, h: 102, l: 98, c: 101, v: 5000 },
    { ts: 2, o: 101, h: 103, l: 99, c: 100, v: 5500 },
    { ts: 3, o: 100, h: 102, l: 98, c: 101, v: 5200 },
    { ts: 4, o: 101, h: 103, l: 99, c: 100, v: 5100 },
    { ts: 5, o: 100, h: 102, l: 98, c: 101, v: 5300 },
    { ts: 6, o: 101, h: 103, l: 99, c: 100, v: 5400 },
    { ts: 7, o: 100, h: 102, l: 98, c: 101, v: 5000 },
    { ts: 8, o: 101, h: 103, l: 99, c: 100, v: 5200 },
    { ts: 9, o: 100, h: 102, l: 98, c: 101, v: 5100 },
    { ts: 10, o: 101, h: 103, l: 99, c: 100, v: 5300 },
  ]);
}

process.env.UPSTASH_REDIS_REST_URL = "https://mock.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "mock-token";
process.env.HELIUS_API_KEY = "mock-helius-key";
// These tests read the FULL scan, which only a Pro caller receives (api/_lib/pro-gate.ts): this install is a Pro one (the dev escape hatch).
process.env.DEV_PRO_INSTALLS = "test-pro-install-0001";

const { default: handler } = await import("../api/scan");
// The cache module is mocked above; import it AFTER the mock variables exist.
const { acquireScanLock, waitForCachedResult, getCachedResult, setCachedResult, setShortCachedResult, getLastGoodResult, setLastGoodResult } = await import("../api/_lib/cache");

// ─── Deadline behaviour ──────────────────────────────────────────────────────
// With every upstream merely SLOW (not down) the scan used to reach the global
// timer at the same instant it finished and answered 504; waiters on the
// single-flight lock gave up after a fixed 18 s and each started its own full
// scan. The scan now keeps a reserve at the end of its budget, only starts a
// serial step that can still finish, and waiters wait until their own deadline.

const GLOBAL_MS = 24000;
const SCAN_RESERVE_MS = 2500;
const WSOL = "So11111111111111111111111111111111111111112";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
  vi.mocked(acquireScanLock).mockResolvedValue(true);
  vi.mocked(waitForCachedResult).mockResolvedValue(null);
  vi.mocked(getCachedResult).mockReset();
  vi.mocked(getCachedResult).mockResolvedValue(null);
  vi.mocked(getLastGoodResult).mockReset();
  vi.mocked(getLastGoodResult).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A promise that resolves with `value` after `ms` of (fake) time. */
const after = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

async function run(req: VercelRequest, res: VercelResponse, advanceMs = GLOBAL_MS + 1000) {
  const started = Date.now();
  let doneAt = -1;
  const p = handler(req, res).then(() => { doneAt = Date.now(); });
  await vi.advanceTimersByTimeAsync(advanceMs);
  await p;
  return { elapsedMs: doneAt - started };
}

const jsonBody = (res: VercelResponse) => (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<string, unknown> | undefined;

describe("scan deadline", () => {
  it("does not START serial steps when the parallel phase ate the whole budget, and still answers", async () => {
    setupGoodTokenMocks();
    // Phase 2 answers just before the data deadline (24 s - 2.5 s reserve = 21.5 s):
    // no holders and no supply, which would normally trigger the public-RPC fallbacks.
    const late = GLOBAL_MS - SCAN_RESERVE_MS - 300;
    mockHeliusGetLargestAccounts.mockImplementation(() => after(late, { result: { value: [] } }));
    mockHeliusGetMintAccount.mockImplementation(() => after(late, null));
    const res = createMockRes();

    const { elapsedMs } = await run(createMockReq({ ca: WSOL }), res);

    expect(mockPublicRpcGetLargestAccounts).not.toHaveBeenCalled();
    expect(mockPublicRpcGetTokenSupply).not.toHaveBeenCalled();
    expect(mockPublicRpcGetMintInfo).not.toHaveBeenCalled();
    expect(mockHeliusGetCreatorReputation).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(504);
    expect(jsonBody(res)?.risk).toBeDefined(); // a verdict, computed from what arrived
    expect(elapsedMs).toBeLessThan(GLOBAL_MS);
  });

  it("witness: the same steps DO run when there is plenty of time", async () => {
    setupGoodTokenMocks();
    const res = createMockRes();

    await run(createMockReq({ ca: WSOL }), res);

    expect(mockHeliusResolveAccountOwners).toHaveBeenCalled();
    // The creator's history is looked up with the creator Solscan's `token/meta` names, and only the age is read from it now
    // (SOLSCAN_AGE_AND_HOLDERS_ONLY): the step does not run at all, with or without time.
    expect(mockHeliusGetCreatorReputation).not.toHaveBeenCalled();
    expect(jsonBody(res)?.risk).toBeDefined();
  });
});

describe("scan deadline — requests waiting on the single-flight lock", () => {
  it("waits for the holder until ITS OWN deadline, not a fixed 18 s", async () => {
    setupGoodTokenMocks();
    vi.mocked(acquireScanLock).mockResolvedValue(false);
    const res = createMockRes();

    await run(createMockReq({ ca: WSOL }), res);

    const opts = vi.mocked(waitForCachedResult).mock.calls[0][2] as { timeoutMs: number };
    expect(opts.timeoutMs).toBe(GLOBAL_MS - SCAN_RESERVE_MS); // nothing elapsed yet: 21 500 ms
  });

  it("answers 503 + Retry-After instead of launching a doomed scan when the wait used up the budget", async () => {
    setupGoodTokenMocks();
    vi.mocked(acquireScanLock).mockResolvedValue(false);
    vi.mocked(waitForCachedResult).mockImplementation(async (_ca, _id, opts) => {
      await vi.advanceTimersByTimeAsync((opts as { timeoutMs: number }).timeoutMs);
      return null;
    });
    const res = createMockRes();

    await run(createMockReq({ ca: WSOL }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", "2");
    expect(mockFetch).not.toHaveBeenCalled(); // no upstream call: no second scan
  });

  it("witness: with plenty of time left (holder crashed early) it scans for itself", async () => {
    setupGoodTokenMocks();
    vi.mocked(acquireScanLock).mockResolvedValue(false);
    vi.mocked(waitForCachedResult).mockResolvedValue(null); // returns at once
    const res = createMockRes();

    await run(createMockReq({ ca: WSOL }), res);

    expect(res.status).not.toHaveBeenCalledWith(503);
    expect(jsonBody(res)?.risk).toBeDefined();
  });

  it("arms the global timer from the request start, not from after the lock wait", async () => {
    setupGoodTokenMocks();
    vi.mocked(acquireScanLock).mockResolvedValue(false);
    vi.mocked(waitForCachedResult).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5000); // 5 s spent waiting on the lock holder
      return null;
    });
    // The cache read for the resolved mint never answers, so only the global
    // timer can end this request.
    vi.mocked(getCachedResult).mockResolvedValueOnce(null).mockImplementationOnce(() => new Promise(() => {}));
    const res = createMockRes();

    const { elapsedMs } = await run(createMockReq({ ca: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }), res, 40_000);

    expect(res.status).toHaveBeenCalledWith(504);
    // 5 s of waiting + what is left of the 24 s = 24 s in total. A timer re-armed
    // after the wait would fire at 29 s, past Vercel's 25 s kill.
    expect(elapsedMs).toBe(GLOBAL_MS);
  });
});

describe("scan deadline — what gets cached", () => {
  it("a result built under deadline pressure is cached for 30 s only, never for the full TTL", async () => {
    setupGoodTokenMocks();
    const late = GLOBAL_MS - SCAN_RESERVE_MS - 300; // data arrives with ~0.3 s of budget left
    mockHeliusGetLargestAccounts.mockImplementation(() => after(late, { result: { value: [] } }));
    mockHeliusGetMintAccount.mockImplementation(() => after(late, null));

    await run(createMockReq({ ca: WSOL }), createMockRes());

    expect(setShortCachedResult).toHaveBeenCalledWith(WSOL, expect.anything(), 30);
    expect(setCachedResult).not.toHaveBeenCalled();
  });

  it("a SAFE or CAUTION built without the chart layer (a GeckoTerminal 429) is cached for 30 s only, not for the full TTL (audit M11)", async () => {
    setupGoodTokenMocks();
    mockFetchDexCandles.mockResolvedValue([]); // GeckoTerminal refused: no candles, so no chart layer, on a 90-day-old token
    const res = createMockRes();

    await run(createMockReq({ ca: WSOL }), res);

    const body = jsonBody(res) as { risk: string; layers: Record<string, { available: boolean }> };
    expect(body.layers.chart.available).toBe(false);
    expect(["SAFE", "CAUTION"]).toContain(body.risk);
    expect(setShortCachedResult).toHaveBeenCalledWith(WSOL, expect.anything(), 30);
    expect(setCachedResult).not.toHaveBeenCalled();
  });

  it("witness: a normal scan is cached with the usual TTL", async () => {
    setupGoodTokenMocks();

    await run(createMockReq({ ca: WSOL }), createMockRes());

    expect(setCachedResult).toHaveBeenCalled();
    expect(setShortCachedResult).not.toHaveBeenCalled();
  });
});

// ─── A scan started from a PAIR address (audit A-07) ─────────────────────────
// DexScreener puts the address of the PAIR in its URLs. The scan resolves the token's mint from it, but used to keep the RugCheck report it
// had asked for under the pair address (RugCheck answers 400 for a pair): bundle, snipers, rug history and creator sells were skipped, and the
// incomplete result was cached under the MINT for the full TTL.

const PAIR = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const RUG_REPORT_OF_MINT = "https://api.rugcheck.xyz/v1/tokens/" + MINT + "/report";

/** The good-token mocks, but the page's address is a pair: DexScreener resolves it to MINT, RugCheck refuses to know a pair. */
function setupPairScenario({ mintReportAvailable }: { mintReportAvailable: boolean }) {
  setupGoodTokenMocks();
  const base = mockFetch.getMockImplementation()! as (url: string, ...rest: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
    const u = String(url);
    if (u.includes("rugcheck") && u.includes("/tokens/" + PAIR + "/")) return { ok: false, status: 400, json: () => Promise.resolve({ error: "invalid mint" }) };
    if (u === RUG_REPORT_OF_MINT && !mintReportAvailable) return { ok: false, status: 404, json: () => Promise.resolve(null) };
    const res = await base(url, ...rest);
    if (u.includes("dexscreener")) {
      const body = (await res.json()) as { pairs: Array<{ pairAddress: string; baseToken: { address: string } }> };
      for (const p of body.pairs) { p.pairAddress = PAIR; p.baseToken.address = MINT; }
      return { ok: true, json: () => Promise.resolve(body) };
    }
    if (u.includes("gopluslabs")) {
      const body = (await res.json()) as { result: Record<string, unknown> };
      return { ok: true, json: () => Promise.resolve({ result: { [MINT]: Object.values(body.result)[0] } }) };
    }
    return res;
  });
}

describe("scan started from a pair address", () => {
  it("reads the RugCheck report of the RESOLVED mint, not only the one of the address it was given", async () => {
    setupPairScenario({ mintReportAvailable: true });
    const res = createMockRes();
    await run(createMockReq({ ca: PAIR }), res);

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(RUG_REPORT_OF_MINT);
    expect(jsonBody(res)?.resolvedMint).toBe(MINT);
  });

  it("a scan that starts from the mint itself still asks for the report once (nothing extra)", async () => {
    setupPairScenario({ mintReportAvailable: true });
    await run(createMockReq({ ca: MINT }), createMockRes());

    const reportCalls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u === RUG_REPORT_OF_MINT);
    expect(reportCalls).toHaveLength(1);
  });

  it("the report in hand, the result is cached the normal way, under the pair and under the mint", async () => {
    setupPairScenario({ mintReportAvailable: true });
    await run(createMockReq({ ca: PAIR }), createMockRes());

    const longKeys = vi.mocked(setCachedResult).mock.calls.map((c) => c[0]);
    expect(longKeys).toEqual(expect.arrayContaining([PAIR, MINT]));
  });

  it("without the report, a SAFE / CAUTION result is kept 30 s only under BOTH keys: the mint's cache is not polluted for the full TTL", async () => {
    setupPairScenario({ mintReportAvailable: false });
    const res = createMockRes();
    await run(createMockReq({ ca: PAIR }), res);

    const body = jsonBody(res);
    expect(["SAFE", "CAUTION"]).toContain(body?.risk); // the premise: the verdict is one a missing report could flatter
    expect(setCachedResult).not.toHaveBeenCalled();
    const shortCalls = vi.mocked(setShortCachedResult).mock.calls;
    expect(shortCalls.map((c) => c[0])).toEqual(expect.arrayContaining([PAIR, MINT]));
    expect(shortCalls.every((c) => c[2] === 30)).toBe(true);
  });
});

// ─── RugCheck is waited for at most RUGCHECK_WAIT_MS ─────────────────────────────────────────────────────────────────────────────
// Measured live (2026-10-14): for the very largest tokens RugCheck's report answers an error after 6 to 14 s and its summary does not answer within
// 30 s. The scan waited for each call up to its own 5 s timeout and a retry, then asked again for the resolved mint: BONK took 23 s of its 24 s.
describe("scan deadline — a slow RugCheck is not waited for beyond RUGCHECK_WAIT_MS", () => {
  const RUGCHECK_WAIT_MS = 4000;
  const slowRugcheck = (ms: number) => {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()! as (url: string, ...rest: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => (url.includes("rugcheck") ? after(ms, undefined).then(() => good(url, ...rest)) : good(url, ...rest)));
  };

  it("RugCheck never answers: the scan answers about RUGCHECK_WAIT_MS after the start, with a verdict, instead of 10 s or more", async () => {
    slowRugcheck(60_000);
    const res = createMockRes();
    const { elapsedMs } = await run(createMockReq({ ca: WSOL }), res, 40_000);
    expect(jsonBody(res)?.risk).toBeDefined();
    expect(elapsedMs).toBeGreaterThanOrEqual(RUGCHECK_WAIT_MS);
    expect(elapsedMs).toBeLessThan(RUGCHECK_WAIT_MS + 3000);
    expect(jsonBody(res)?.sources_used as string[]).not.toContain("rugcheck");
  });

  it("RugCheck answers within the budget (3 s): its answer is used, as before", async () => {
    slowRugcheck(3000);
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res, 40_000);
    expect(jsonBody(res)?.sources_used as string[]).toContain("rugcheck");
  });

  it("RugCheck answers after the budget (5 s): the scan did not wait for it", async () => {
    slowRugcheck(5000);
    const res = createMockRes();
    const { elapsedMs } = await run(createMockReq({ ca: WSOL }), res, 40_000);
    expect(elapsedMs).toBeLessThan(RUGCHECK_WAIT_MS + 3000);
    expect(jsonBody(res)?.sources_used as string[]).not.toContain("rugcheck");
  });

  it("the other sources are not slowed down: a fast RugCheck leaves the scan as fast as before", async () => {
    setupGoodTokenMocks();
    const res = createMockRes();
    const { elapsedMs } = await run(createMockReq({ ca: WSOL }), res, 40_000);
    expect(elapsedMs).toBeLessThan(RUGCHECK_WAIT_MS);
    expect(jsonBody(res)?.sources_used as string[]).toContain("rugcheck");
  });
});

describe("scan deadline — RugCheck for the RESOLVED mint (a scan started from a pair address) is capped too", () => {
  it("the pair address answers fast, the mint it resolves to has a RugCheck that never answers: the scan does not wait for it", async () => {
    const PAIR = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // a pair address: DexScreener says its base token is WSOL
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()! as (url: string, ...rest: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("rugcheck") && url.includes(PAIR)) return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve(null) });
      if (url.includes("rugcheck") && url.includes(WSOL)) return after(60_000, undefined).then(() => good(url, ...rest));
      return good(url, ...rest);
    });
    const res = createMockRes();
    const { elapsedMs } = await run(createMockReq({ ca: PAIR }), res, 40_000);
    expect(jsonBody(res)?.risk).toBeDefined();
    // two rounds of RugCheck (the pair address, then the mint it resolves to), each capped at RUGCHECK_WAIT_MS: about 8 s; uncapped it is two 10.5 s rounds
    expect(elapsedMs).toBeLessThan(4000 + 4000 + 3000);
  });
});

// ─── DexScreener has no pool for the token (an outage answers "no pairs" too: 2026-10-07, about an hour) ──────────────────────────────
// The answer cannot be told from a token that really has no pool. A verdict born from a market nobody read must not stick for 30 minutes
// (INTCX, an issuer-backed stock: SAFE, then RUG for the 30 minutes DexScreener was silent, then SAFE again), and an issuer-backed token is
// not RUG in that case: a stablecoin stays SAFE, any other issuer-backed token is CAUTION.

describe("scan — DexScreener lists no pool for the token", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // in the issuer registry (stable)
  const dexSilent = () => {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()! as (url: string, ...rest: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => (url.includes("dexscreener")
      ? Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs: null }) })
      : good(url, ...rest)));
  };

  it("the verdict is cached for 30 s only, never for the full TTL", async () => {
    dexSilent();
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res);
    expect(jsonBody(res)?.risk).toBeDefined();
    expect(setShortCachedResult).toHaveBeenCalledWith(WSOL, expect.anything(), 30);
    expect(setCachedResult).not.toHaveBeenCalled();
  });

  it("a stablecoin of the registry stays SAFE while DexScreener is silent (one information line says the peg could not be checked), cached 30 s only", async () => {
    dexSilent();
    const res = createMockRes();
    await run(createMockReq({ ca: USDC }), res);
    const body = jsonBody(res) as { risk: string; rugKind: string | null; flags: Array<{ label: string; severity: string }> };
    expect(body.risk).toBe("SAFE");
    expect(body.rugKind ?? null).toBeNull();
    expect(body.flags.filter((f) => f.severity === "critical" || f.severity === "warning")).toEqual([]);
    expect(setShortCachedResult).toHaveBeenCalledWith(USDC, expect.anything(), 30);
    expect(setCachedResult).not.toHaveBeenCalled();
  });

  it("a token of the registry with NO memory: SAFE by its issuer, nothing says it comes from memory", async () => {
    dexSilent();
    const res = createMockRes();
    await run(createMockReq({ ca: USDC }), res);
    const body = jsonBody(res) as { risk: string; servedFromMemory?: boolean; scannedAgoSec?: number };
    expect(body.risk).toBe("SAFE");
    expect(body.servedFromMemory).toBeUndefined();
    expect(body.scannedAgoSec).toBeUndefined();
    expect(getLastGoodResult).toHaveBeenCalledWith(USDC);
  });

  it("a token of the registry WITH a memory (its last good verdict, 6 min old): that verdict is served again, with its age, and kept 30 s only", async () => {
    dexSilent();
    const made = Date.now() - 6 * 60_000;
    vi.mocked(getLastGoodResult).mockResolvedValueOnce({
      score: 950, risk: "SAFE", rugKind: null, flags: [], pair: null, resolvedMint: USDC, confidence: 90, sources_used: ["dexscreener", "rugcheck", "goplus", "helius"],
      tokenSymbol: "USDC", tokenName: "USD Coin", priceUsd: 1.0001, liquidity: 52_000_000, pairCreatedAt: Date.now() - 900 * 86_400_000, solscanTokenAgeHours: 900 * 24,
      priceChange1h: 0, fetchedAt: made, aiSummary: "old summary", requestId: "old",
    } as never);
    const res = createMockRes();
    await run(createMockReq({ ca: USDC }), res);
    const body = jsonBody(res) as { risk: string; priceUsd: number; servedFromMemory?: boolean; scannedAgoSec?: number; degraded?: boolean; freshForSec: number; fetchedAt: number };
    expect(body.risk).toBe("SAFE");
    expect(body.priceUsd).toBe(1.0001); // the old reading, not nothing
    expect(body.servedFromMemory).toBe(true);
    expect(body.scannedAgoSec).toBe(360);
    expect(body.fetchedAt).toBe(made); // the moment the market was read, not now
    expect(body.degraded).toBe(true);
    expect(body.freshForSec).toBe(30);
    expect(setShortCachedResult).toHaveBeenCalledWith(USDC, expect.objectContaining({ servedFromMemory: true }), 30);
    expect(setCachedResult).not.toHaveBeenCalled();
  });

  it("a token that is NOT of the registry never reads the memory (its verdict is the general decision, as before)", async () => {
    dexSilent();
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res);
    expect(getLastGoodResult).not.toHaveBeenCalled();
    expect((jsonBody(res) as { servedFromMemory?: boolean }).servedFromMemory).toBeUndefined();
  });

  it("witness: with a readable market the same token is not told its market is unreadable, and is cached with the usual TTL", async () => {
    setupGoodTokenMocks();
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res);
    expect((jsonBody(res) as { flags: Array<{ label: string }> }).flags.some((f) => /^Market unreadable/.test(f.label))).toBe(false);
    expect(setCachedResult).toHaveBeenCalled();
    expect(setShortCachedResult).not.toHaveBeenCalled();
  });
});

// ─── The answer says how long the overlay may keep it (freshForSec) and still show it if the scanner is unreachable (staleLeftSec) ─────

describe("scan — the answer carries its windows", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  it("a normal scan: reusable 5 min, not degraded", async () => {
    setupGoodTokenMocks();
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res);
    const body = jsonBody(res) as { freshForSec: number; staleLeftSec: number; degraded?: boolean };
    expect(body.freshForSec).toBe(300);
    expect(Number.isInteger(body.staleLeftSec) && body.staleLeftSec >= 0).toBe(true);
    expect(body.degraded).toBe(false);
  });

  it("a scan with no DexScreener pool is marked degraded, reusable 30 s, and the marked answer is the one that is cached", async () => {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()! as (url: string, ...rest: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => (url.includes("dexscreener")
      ? Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs: null }) })
      : good(url, ...rest)));
    const res = createMockRes();
    await run(createMockReq({ ca: USDC }), res);
    const body = jsonBody(res) as { freshForSec: number; staleLeftSec: number; degraded?: boolean; risk: string };
    expect(body.degraded).toBe(true);
    expect(body.freshForSec).toBe(30);
    expect(body.risk).toBe("SAFE");
    expect(body.staleLeftSec).toBe(0); // a degraded SAFE is never shown stale by the overlay
    const stored = vi.mocked(setShortCachedResult).mock.calls[0]?.[1] as { degraded?: boolean; freshForSec?: number; staleLeftSec?: number };
    expect(stored.degraded).toBe(true);
    expect("freshForSec" in stored).toBe(false); // the windows are computed when the answer is SENT, never stored
    expect("staleLeftSec" in stored).toBe(false);
  });

  it("an answer served from the server cache counts its window from when the verdict was made", async () => {
    setupGoodTokenMocks();
    const made = Date.now() - 120_000;
    vi.mocked(getCachedResult).mockResolvedValueOnce({
      score: 120, risk: "DANGER", rugKind: null, flags: [], aiSummary: "x", fetchedAt: made, pair: null, resolvedMint: WSOL,
      pairCreatedAt: null, solscanTokenAgeHours: null, priceChange1h: 0,
    } as never);
    const res = createMockRes();
    await run(createMockReq({ ca: WSOL }), res);
    const body = jsonBody(res) as { freshForSec: number; staleLeftSec: number };
    expect(body.freshForSec).toBe(300);
    expect(body.staleLeftSec).toBe(3600 - 120); // a DANGER, held 2 minutes
  });
});

// ─── The memory is written when the market WAS read ───────────────────────────────────────────────────────────────────────────────────

describe("scan — the memory of the last good verdict of an issuer-backed token", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // in the issuer registry (stable)
  /** The good-token mocks, but the pool DexScreener lists is the one of USDC: the scan resolves to a token of the registry. */
  const usdcReadable = () => {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()! as (url: string, ...rest: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const res = await good(url, ...rest);
      if (String(url).includes("dexscreener")) {
        const body = (await res.json()) as { pairs: Array<{ baseToken: { address: string } }> };
        for (const p of body.pairs) p.baseToken.address = USDC;
        return { ok: true, json: () => Promise.resolve(body) };
      }
      // GoPlus answers for this token too (its answer is keyed by the mint): a scan with a silent source is not the memory (holdLastVerdict).
      if (String(url).includes("gopluslabs")) {
        const body = (await res.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ result: { [USDC]: Object.values(body.result)[0] } }) };
      }
      return res;
    });
  };

  it("a scan that read the market of a token of the registry writes it down (the verdict, as sent to the overlay: no windows, no age)", async () => {
    usdcReadable();
    const res = createMockRes();
    await run(createMockReq({ ca: USDC }), res);
    expect(vi.mocked(setLastGoodResult)).toHaveBeenCalledTimes(1);
    const [mint, stored] = vi.mocked(setLastGoodResult).mock.calls[0] as [string, Record<string, unknown>];
    expect(mint).toBe(USDC);
    expect(stored.risk).toBeDefined();
    expect("freshForSec" in stored).toBe(false);
    expect("scannedAgoSec" in stored).toBe(false);
    expect(stored.servedFromMemory).toBeUndefined();
  });

  it("a token that is not of the registry writes nothing", async () => {
    setupGoodTokenMocks();
    await run(createMockReq({ ca: WSOL }), createMockRes());
    expect(setLastGoodResult).not.toHaveBeenCalled();
  });

  it("a scan that could NOT read the market writes nothing (a verdict born from no market is never the memory)", async () => {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation()! as (url: string, ...rest: unknown[]) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => (url.includes("dexscreener")
      ? Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs: null }) })
      : good(url, ...rest)));
    await run(createMockReq({ ca: USDC }), createMockRes());
    expect(setLastGoodResult).not.toHaveBeenCalled();
  });
});

