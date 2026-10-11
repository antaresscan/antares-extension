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
    headers: { origin: "https://dexscreener.com", "x-forwarded-for": "1.2.3.4" },
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
              is_honeypot: "0",
              cannot_sell_all: "0",
              mint_authority: "0",
              freeze_authority: "0",
              is_blacklisted: "0",
              sell_tax: "0",
              buy_tax: "0",
              owner_percent: "0",
              creator_percent: "0",
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

const { default: handler } = await import("../api/scan");
// The cache module is mocked above; import it AFTER the mock variables exist.
const { acquireScanLock, waitForCachedResult, getCachedResult, setCachedResult, setShortCachedResult } = await import("../api/_lib/cache");

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
    expect(mockHeliusGetCreatorReputation).toHaveBeenCalled();
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
