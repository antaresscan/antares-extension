import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
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
    mockHeliusGetMintAccount.mockResolvedValue(null);
    mockHeliusGetCreatorReputation.mockResolvedValue(null);
    mockHeliusGetHoldersCount.mockResolvedValue(null);
    mockHeliusGetProgramAccountHolderCount.mockResolvedValue(null);
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

// ─── A token DexScreener has no registered links for ─────────────────────────
// USDC has no website/social registered on any of its 30 DexScreener pairs.
// That alone used to be a critical flag, i.e. DANGER, for the best-known
// stablecoin: the production e2e test for USDC failed for hours.
describe("scan handler — token without registered links", () => {
  const MINT = "So11111111111111111111111111111111111111112";

  /** `otherPoolUsd`: a second pool of the same token, quoted in a non-stable token, so selectBestPair does not choose it. */
  function scanWithNoLinks(ageDays: number, liquidityUsd: number, otherPoolUsd = 0) {
    setupGoodTokenMocks();
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("dexscreener")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            pairs: [{
              pairAddress: "pair1",
              baseToken: { address: MINT, symbol: "USDC", name: "USD Coin" },
              quoteToken: { address: "USDTmint", symbol: "USDT" },
              liquidity: { usd: liquidityUsd },
              volume: { h24: liquidityUsd / 4, h1: liquidityUsd / 20 },
              priceChange: { m5: 0, h1: 0.1, h6: 0.2, h24: 0.3 },
              txns: { m5: { buys: 15, sells: 12 } },
              priceUsd: "1.0001",
              marketCap: 9_000_000_000,
              fdv: 9_000_000_000,
              pairCreatedAt: Date.now() - ageDays * 24 * 3600 * 1000,
              info: { socials: [], websites: [] }, // nothing registered
            }, ...(otherPoolUsd > 0 ? [{
              pairAddress: "pair2",
              baseToken: { address: MINT, symbol: "USDC", name: "USD Coin" },
              quoteToken: { address: "JitoSOLmint", symbol: "JitoSOL" }, // not a stable / SOL quote: never chosen
              liquidity: { usd: otherPoolUsd },
              volume: { h24: 1_000, h1: 50 },
              priceChange: { m5: 0, h1: 0.1, h6: 0.2, h24: 0.3 },
              txns: { m5: { buys: 15, sells: 12 } },
              priceUsd: "1.0001",
              marketCap: 9_000_000_000,
              fdv: 9_000_000_000,
              pairCreatedAt: Date.now() - ageDays * 24 * 3600 * 1000,
              info: { socials: [], websites: [] },
            }] : [])],
          }),
        });
      }
      return goodMocks(url, ...rest);
    });
  }

  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      risk: string; flags: Array<{ label: string; severity: string }>;
    };
    return body;
  }

  it("an established, liquid token is not turned into DANGER by the missing links", async () => {
    scanWithNoLinks(786, 1_544_566);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /No website/.test(f.label))).toBe(false);
    expect(body.flags.some((f) => f.severity === "info" && /registered on DexScreener/.test(f.label))).toBe(true);
    expect(body.risk).not.toBe("DANGER");
  });

  it("holders reach the layer: a 40-day-old token with 5 000 holders counts as established", async () => {
    scanWithNoLinks(40, 500_000); // the good-token mocks report 5 000 holders

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /No website/.test(f.label))).toBe(false);
  });

  it("the deepest pool counts: the chosen pool is thin ($62k, USDT-quoted) but another pool of the token holds $1.3M", async () => {
    scanWithNoLinks(786, 61_847, 1_300_296);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /No website/.test(f.label))).toBe(false);
    expect(body.flags.some((f) => f.severity === "info" && /registered on DexScreener/.test(f.label))).toBe(true);
  });

  it("witness: the same thin pool alone (no deep pool elsewhere) keeps the strict reading", async () => {
    scanWithNoLinks(786, 61_847);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /No website/.test(f.label))).toBe(true);
  });

  it("witness: the same missing links on a 2-day-old token still raise the critical flag", async () => {
    scanWithNoLinks(2, 1_544_566);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /No website/.test(f.label))).toBe(true);
    expect(body.risk).toBe("DANGER");
  });
});

// ─── A price pump alone (M6) ─────────────────────────────────────────────────
// A pump alone is never critical, whatever the percentage (rule #628): a liquid token with balanced trades that pumped
// +1784 % in 24h (the TELEMONEY case) used to be forced to RUG by "Extreme 24h pump — exit liquidity trap". It now gets a
// warning and the verdict is capped, while the same pump on thin liquidity is still the exit trap it always was.
describe("scan handler — a price pump alone", () => {
  const MINT = "So11111111111111111111111111111111111111112";

  function scanWithPump(priceChange: Record<string, number>, liquidityUsd: number, volume24h: number) {
    setupGoodTokenMocks();
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("dexscreener")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            pairs: [{
              pairAddress: "pair1",
              baseToken: { address: MINT, symbol: "TELE", name: "Telemoney" },
              liquidity: { usd: liquidityUsd },
              volume: { h24: volume24h, h1: volume24h / 24 },
              priceChange: { m5: 1.2, h6: 8, ...priceChange },
              txns: { m5: { buys: 15, sells: 12 } },
              priceUsd: "0.01",
              marketCap: 5_000_000,
              fdv: 5_000_000,
              pairCreatedAt: Date.now() - 90 * 24 * 3600 * 1000,
              info: {
                socials: [{ type: "twitter", url: "https://twitter.com/test" }],
                websites: [{ url: "https://test.com" }],
              },
            }],
          }),
        });
      }
      return goodMocks(url, ...rest);
    });
  }

  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      risk: string; flags: Array<{ label: string; severity: string }>;
    };
  }

  it("+1784 % in 24h on a liquid token with balanced trades: a warning, not an exit trap, and not RUG", async () => {
    scanWithPump({ h24: 1784, h1: 6 }, 500_000, 200_000);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /pump/i.test(f.label))).toBe(false);
    expect(body.flags.some((f) => f.severity === "warning" && /extreme 24h pump \+1784% — high retrace risk/i.test(f.label))).toBe(true);
    expect(body.risk).toBe("CAUTION"); // the ceiling: a pump is a retrace risk, not a clean bill of health, and not an exit trap
  });

  it("+450 % in 1h on a liquid token with balanced trades: a warning, not an exit trap, and not RUG", async () => {
    scanWithPump({ h1: 450, h24: 450 }, 500_000, 200_000);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /pump/i.test(f.label))).toBe(false);
    expect(body.flags.some((f) => f.severity === "warning" && /extreme pump \+450% in 1h — high retrace risk/i.test(f.label))).toBe(true);
    expect(body.risk).toBe("CAUTION");
  });

  it("witness: the same +1784 % on thin liquidity ($9k) is still the exit trap: a critical flag and DANGER", async () => {
    scanWithPump({ h24: 1784, h1: 6 }, 9_000, 40_000);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /extreme 24h pump/i.test(f.label))).toBe(true);
    expect(body.risk).toBe("DANGER");
  });
});

// ─── A young token with one wallet at 12 % (audit M5) ────────────────────────────────────────────────────────────────
// The written intent of the 10-15 % tier on a token under 30 days old is "CAUTION max"; it was emitted as a critical flag and so
// came out DANGER. Everything else about the token is clean: the verdict must be CAUTION, and the flag a warning.
describe("scan handler — young token, one wallet at 12 %", () => {
  const MINT = "So11111111111111111111111111111111111111112";

  function scanYoungWithTop1(top1Units: number) {
    setupGoodTokenMocks();
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("dexscreener")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            pairs: [{
              pairAddress: "pair1",
              baseToken: { address: MINT, symbol: "YNG", name: "Young" },
              liquidity: { usd: 200_000 },
              volume: { h24: 100_000, h1: 5_000 },
              priceChange: { m5: 0.5, h1: 2, h6: 6, h24: 12 },
              txns: { m5: { buys: 15, sells: 12 } },
              priceUsd: "0.01",
              marketCap: 1_000_000,
              fdv: 1_000_000,
              pairCreatedAt: Date.now() - 48 * 3600 * 1000,
              info: { socials: [{ type: "twitter", url: "https://twitter.com/test" }], websites: [{ url: "https://test.com" }] },
            }],
          }),
        });
      }
      return goodMocks(url, ...rest);
    });
    // The engine takes the OLDEST age among its sources: the good-token Solscan mock says 90 days, which would make the token
    // established. Both sources must agree that it is 48 h old.
    const solscanGood = mockFetchSolscan.getMockImplementation() as (endpoint: string) => Promise<unknown>;
    mockFetchSolscan.mockImplementation((endpoint: string) =>
      endpoint.includes("meta")
        ? Promise.resolve({ data: { created_time: Math.floor(Date.now() / 1000) - 48 * 3600, icon: "https://img.test.com/icon.png", creator: "creator123", decimals: 9, supply: 100000 } })
        : solscanGood(endpoint));
    // supply of the good-token mocks: 100,000. One wallet at top1Units, then a long tail so the top-10 ladder stays quiet.
    mockHeliusGetLargestAccounts.mockResolvedValue({
      result: { value: [{ address: "whale", uiAmount: top1Units }, ...Array.from({ length: 19 }, (_, i) => ({ address: `h${i}`, uiAmount: 400 }))] },
    });
  }

  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; flags: Array<{ label: string; severity: string }> };
  }

  it("12 % on a 48 h old token, all else clean: the flag is a warning and the verdict is CAUTION, not DANGER", async () => {
    scanYoungWithTop1(12_000);

    const body = await run();

    const f = body.flags.find((x) => /single wallet holds 12%/i.test(x.label));
    expect(f?.label).toMatch(/elevated concentration · young token/);
    expect(f?.severity).toBe("warning");
    expect(body.flags.filter((x) => x.severity === "critical")).toEqual([]);
    expect(body.risk).toBe("CAUTION");
  });

  it("witness: the same token with a wallet at 20 % is DANGER", async () => {
    scanYoungWithTop1(20_000);

    const body = await run();

    expect(body.flags.some((x) => x.severity === "critical" && /single wallet holds 20%/i.test(x.label))).toBe(true);
    expect(body.risk).toBe("DANGER");
  });
});

// ─── The verdict is decided on the deduplicated flags (audit M4) ────────────────────────────────────────────────────
// runAnalysis cannot be driven into "the same warning from two layers" without faking the layers themselves, so this guard reads the
// order in the source: the flags are deduplicated, THEN counted, THEN the verdict is decided on those counts.
describe("scan.ts counts the flags after deduplicating them", () => {
  const src = readFileSync(new URL("../api/scan.ts", import.meta.url), "utf8");

  it("dedupeFlags runs before countVerdictFlags, which runs before determineVerdict", () => {
    const dedupe = src.indexOf("dedupeFlags(_allFlagsForVerdict)");
    const count = src.indexOf("countVerdictFlags(flags)");
    const verdict = src.indexOf("determineVerdict({");
    expect(dedupe).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(dedupe);
    expect(verdict).toBeGreaterThan(count);
  });

  it("the raw list is never what the counts are taken on", () => {
    expect(src).not.toMatch(/countVerdictFlags\(_allFlagsForVerdict\)/);
    expect(src).not.toMatch(/_allFlagsForVerdict\.filter\(/);
  });
});
