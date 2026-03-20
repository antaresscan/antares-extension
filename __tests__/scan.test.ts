import { vi, describe, it, expect, beforeEach } from "vitest";
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

// Mock cache — no-op
vi.mock("../api/_lib/cache", () => ({
  initCache: vi.fn(),
  getCachedResult: vi.fn().mockResolvedValue(null),
  setCachedResult: vi.fn(),
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
const mockSolscanGetHoldersCount = vi.fn();
const mockFetchSolscan = vi.fn();
const mockFetchDexCandles = vi.fn();

vi.mock("../api/_lib/fetchers", () => ({
  heliusGetLargestAccounts: (...args: unknown[]) => mockHeliusGetLargestAccounts(...args),
  heliusGetTokenSupply: (...args: unknown[]) => mockHeliusGetTokenSupply(...args),
  heliusGetCreatorReputation: (...args: unknown[]) => mockHeliusGetCreatorReputation(...args),
  solscanGetHoldersCount: (...args: unknown[]) => mockSolscanGetHoldersCount(...args),
  fetchSolscan: (...args: unknown[]) => mockFetchSolscan(...args),
  fetchDexCandles: (...args: unknown[]) => mockFetchDexCandles(...args),
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
  // Global fetch mock — DexScreener, RugCheck, GoPlus
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
            pairCreatedAt: Date.now() - 90 * 24 * 3600 * 1000, // 90 days old
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

  // Fetcher mocks
  mockHeliusGetLargestAccounts.mockResolvedValue({
    result: {
      value: [
        { address: "holder1", uiAmount: 1000 },
        { address: "holder2", uiAmount: 800 },
        { address: "holder3", uiAmount: 600 },
      ],
    },
  });
  mockHeliusGetTokenSupply.mockResolvedValue({
    result: { value: { uiAmount: 100000 } },
  });
  mockHeliusGetCreatorReputation.mockResolvedValue(null);
  mockSolscanGetHoldersCount.mockResolvedValue(5000);
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
    { ts: 1, o: 100, h: 110, l: 95, c: 105, v: 5000 },
    { ts: 2, o: 105, h: 115, l: 100, c: 110, v: 6000 },
    { ts: 3, o: 110, h: 120, l: 105, c: 115, v: 7000 },
    { ts: 4, o: 115, h: 125, l: 110, c: 120, v: 8000 },
    { ts: 5, o: 120, h: 130, l: 115, c: 125, v: 9000 },
    { ts: 6, o: 125, h: 135, l: 120, c: 130, v: 10000 },
    { ts: 7, o: 130, h: 140, l: 125, c: 135, v: 11000 },
    { ts: 8, o: 135, h: 145, l: 130, c: 140, v: 12000 },
    { ts: 9, o: 140, h: 150, l: 135, c: 145, v: 13000 },
    { ts: 10, o: 145, h: 155, l: 140, c: 150, v: 14000 },
  ]);
}

// Set env vars before import
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
    expect(body.scoring_version).toBe("6.2.0");
    expect(body.resolvedMint).toBeDefined();
    expect(body.flags).toBeDefined();
    expect(Array.isArray(body.sources_used)).toBe(true);
    // wSOL should NOT be flagged as brand imitation
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
    expect(score).toBeGreaterThan(600);
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
    expect(layers.identity).toBeDefined();
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
    mockSolscanGetHoldersCount.mockResolvedValue(null);
    mockFetchSolscan.mockResolvedValue(null);
    mockFetchDexCandles.mockResolvedValue([]);

    const req = createMockReq({ ca: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" });
    const res = createMockRes();
    await handler(req, res);
    // Should not crash — either returns a result or a 500
    expect(res.json).toHaveBeenCalled();
  });
});
