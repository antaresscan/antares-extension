import { vi, describe, it, expect, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SCORING_VERSION } from "../api/_lib/constants";

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
const mockHeliusGetCreatorReputation = vi.fn();
const mockHeliusGetHoldersCount = vi.fn();
const mockHeliusGetProgramAccountHolderCount = vi.fn();
const mockSolscanGetHoldersCount = vi.fn();
const mockFetchSolscan = vi.fn();
const mockFetchDexCandles = vi.fn();
const mockHeliusResolveAccountOwners = vi.fn();
const mockPublicRpcGetLargestAccounts = vi.fn();
const mockPublicRpcGetTokenSupply = vi.fn();
const mockPublicRpcGetMintInfo = vi.fn();

vi.mock("../api/_lib/fetchers", () => ({
  heliusGetLargestAccounts: (...args: unknown[]) => mockHeliusGetLargestAccounts(...args),
  heliusGetTokenSupply: (...args: unknown[]) => mockHeliusGetTokenSupply(...args),
  heliusGetCreatorReputation: (...args: unknown[]) => mockHeliusGetCreatorReputation(...args),
  heliusGetHoldersCount: (...args: unknown[]) => mockHeliusGetHoldersCount(...args),
  heliusGetProgramAccountHolderCount: (...args: unknown[]) => mockHeliusGetProgramAccountHolderCount(...args),
  solscanGetHoldersCount: (...args: unknown[]) => mockSolscanGetHoldersCount(...args),
  fetchSolscan: (...args: unknown[]) => mockFetchSolscan(...args),
  fetchDexCandles: (...args: unknown[]) => mockFetchDexCandles(...args),
  fetchDexCandlesDaily: vi.fn().mockResolvedValue([]), // no daily candles in unit tests
  fetchDexCandlesLongTerm: vi.fn().mockResolvedValue([]), // no long-term candles in unit tests
  heliusResolveAccountOwners: (...args: unknown[]) => mockHeliusResolveAccountOwners(...args),
  publicRpcGetLargestAccounts: (...args: unknown[]) => mockPublicRpcGetLargestAccounts(...args),
  publicRpcGetTokenSupply: (...args: unknown[]) => mockPublicRpcGetTokenSupply(...args),
  publicRpcGetMintInfo: (...args: unknown[]) => mockPublicRpcGetMintInfo(...args),
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
  mockHeliusGetTokenSupply.mockResolvedValue({
    result: { value: { uiAmount: 100000 } },
  });
  mockHeliusGetCreatorReputation.mockResolvedValue(null);
  mockHeliusGetHoldersCount.mockResolvedValue(null);
  mockHeliusGetProgramAccountHolderCount.mockResolvedValue(null);
  mockSolscanGetHoldersCount.mockResolvedValue(5000);
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── TESTS ───────────────────────────────────────────────────────────────────

describe("scan handler", () => {
  it("returns 400 for missing ca parameter", async () => {
    const req = createMockReq({});
    const res = createMockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 400 for invalid ca (special chars)", async () => {
    const req = createMockReq({ ca: "DROP TABLE users;--" });
    const res = createMockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 204 for OPTIONS request", async () => {
    const req = createMockReq({ ca: "So11111111111111111111111111111111111111112" }, "OPTIONS");
    const res = createMockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("returns 405 for POST method", async () => {
    const req = createMockReq({ ca: "So11111111111111111111111111111111111111112" }, "POST");
    const res = createMockRes();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("processes valid wSOL scan with full pipeline", async () => {
    setupGoodTokenMocks();
    const req = createMockReq({ ca: "So11111111111111111111111111111111111111112" });
    const res = createMockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalled();
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(body.score).toBeTypeOf("number");
    expect(body.risk).toBeDefined();
    // Assert against the imported constant so this test doesn't break every
    // time SCORING_VERSION is bumped (which is the standard cache-invalidation
    // step after any scoring or flag-label change — see api/_lib/constants.ts).
    expect(body.scoring_version).toBe(SCORING_VERSION);
    expect(body.resolvedMint).toBeDefined();
    expect(body.flags).toBeDefined();
    expect(Array.isArray(body.sources_used)).toBe(true);
    const flags = body.flags as Array<{ label: string }>;
    expect(flags.some(f => /brand imitation/i.test(f.label))).toBe(false);
  });

  it("returns high score for clean official token", async () => {
    setupGoodTokenMocks();
    const req = createMockReq({ ca: "So11111111111111111111111111111111111111112" });
    const res = createMockRes();
    await handler(req, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    const score = body.score as number;
    expect(score).toBeGreaterThan(550);
    expect(body.risk).not.toBe("DANGER");
    expect(body.risk).not.toBe("RUG");
  });

  it("includes layer snapshots in result", async () => {
    setupGoodTokenMocks();
    const req = createMockReq({ ca: "So11111111111111111111111111111111111111112" });
    const res = createMockRes();
    await handler(req, res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    const layers = body.layers as Record<string, { trust: number; available: boolean }>;
    expect(layers.dexscreener).toBeDefined();
    expect(layers.rugcheck).toBeDefined();
    expect(layers.goplus).toBeDefined();
    expect(layers.identity).toBeUndefined();
  });

  it("sets CORS and cache headers", async () => {
    setupGoodTokenMocks();
    const req = createMockReq({ ca: "So11111111111111111111111111111111111111112" });
    const res = createMockRes();
    await handler(req, res);
    expect(res.setHeader).toHaveBeenCalledWith("Access-Control-Allow-Origin", "https://dexscreener.com");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  });

  it("handles fetch failures gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    mockHeliusGetLargestAccounts.mockResolvedValue(null);
    mockHeliusGetTokenSupply.mockResolvedValue(null);
    mockHeliusGetCreatorReputation.mockResolvedValue(null);
    mockHeliusGetHoldersCount.mockResolvedValue(null);
    mockHeliusGetProgramAccountHolderCount.mockResolvedValue(null);
    mockSolscanGetHoldersCount.mockResolvedValue(null);
    mockFetchSolscan.mockResolvedValue(null);
    mockFetchDexCandles.mockResolvedValue([]);
    mockPublicRpcGetLargestAccounts.mockResolvedValue(null);
    mockPublicRpcGetTokenSupply.mockResolvedValue(null);
    mockPublicRpcGetMintInfo.mockResolvedValue(null);

    const req = createMockReq({ ca: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" });
    const res = createMockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalled();
  });

  it("uses short TTL cache when aiSummary is null", async () => {
    setupGoodTokenMocks();
    // Force generateAISummary to return null
    vi.mock("../api/_lib/ai-summary", () => ({
      generateAISummary: vi.fn().mockResolvedValue(null),
    }));
    const req = createMockReq({ ca: "So11111111111111111111111111111111111111112" });
    const res = createMockRes();
    await handler(req, res);
    expect(res.json).toHaveBeenCalled();
    // setCachedResult should NOT have been called when aiSummary is null —
    // scan.ts routes incomplete results through setShortCachedResult (30s
    // TTL) so the next scan picks up the AI summary.
    const { setCachedResult, setShortCachedResult } = await import("../api/_lib/cache");
    expect(setCachedResult).not.toHaveBeenCalled();
    expect(setShortCachedResult).toHaveBeenCalledWith(
      "So11111111111111111111111111111111111111112",
      expect.any(Object),
      30,
    );
  });
});
