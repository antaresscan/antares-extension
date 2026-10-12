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

// The record of condemned tokens lives in Redis: the store is faked here (the rules that decide are the real ones, tested in condemned.test.ts).
const mockGetCondemned = vi.fn();
const mockCondemn = vi.fn();
vi.mock("../api/_lib/condemned", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/_lib/condemned")>()),
  initCondemned: vi.fn(),
  getCondemned: (...args: unknown[]) => mockGetCondemned(...args),
  condemn: (...args: unknown[]) => mockCondemn(...args),
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
const mockHeliusGetHolderPages = vi.fn().mockResolvedValue(null); // no chain holder count in these tests
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
function mintAccountResponse(o: { supply?: number; decimals?: number; mintAuthority?: string | null; freezeAuthority?: string | null; program?: string; extensions?: Array<string | { extension: string; state?: Record<string, unknown> }> } = {}) {
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
              ...(o.extensions ? { extensions: o.extensions.map((e) => (typeof e === "string" ? { extension: e } : e)) } : {}),
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
  heliusGetHolderPages: (...args: unknown[]) => mockHeliusGetHolderPages(...args),
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

// The insider graph is faked so that a scan which still built it would be caught (it costs ~120 Helius credits).
const mockBuildInsiderGraph = vi.fn().mockResolvedValue(null);
vi.mock("../api/_lib/insider-graph", () => ({
  buildInsiderGraph: (...args: unknown[]) => mockBuildInsiderGraph(...args),
  initGraphCache: vi.fn(),
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
// These tests read the FULL scan, which only a Pro caller receives (api/_lib/pro-gate.ts): this install is a Pro one (the dev escape hatch).
process.env.DEV_PRO_INSTALLS = "test-pro-install-0001";

const { default: handler } = await import("../api/scan");

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCondemned.mockResolvedValue(null);
  mockCondemn.mockResolvedValue(undefined);
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

  // The collapse rule, through the WHOLE engine (audit: GOIF, -97 % from its high two days earlier, was CAUTION). Everything else about the token
  // is clean (a 90-day-old pair, burned LP, 5 000 holders, a +12 % day), so only the 30-day history can say it collapsed.
  describe("a token that collapsed more than a day ago", () => {
    const GOIF_CANDLES = JSON.parse(readFileSync(new URL("./fixtures/goif-4h-candles.json", import.meta.url), "utf8")) as Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }>;
    const WSOL = "So11111111111111111111111111111111111111112";
    const scanBody = async () => {
      const res = createMockRes();
      await handler(createMockReq({ ca: WSOL }), res);
      return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; rugKind: string | null; flags: Array<{ label: string; severity: string }>; layers: Record<string, { available: boolean }> };
    };

    it("the real GOIF candles (-97 % from a high 2.2 days old) make the scan a RUG, with the collapse flag, even though every 24 h figure is calm", async () => {
      setupGoodTokenMocks();
      const { fetchDexCandlesDaily } = await import("../api/_lib/fetchers");
      vi.mocked(fetchDexCandlesDaily).mockResolvedValueOnce(GOIF_CANDLES);
      const body = await scanBody();
      expect(body.risk).toBe("RUG");
      expect(body.rugKind).toBe("confirmed"); // it already collapsed: RUG PULL, not RUG RISK
      const flag = body.flags.find((f) => /^Collapsed/.test(f.label));
      expect(flag?.label).toBe("Collapsed -97% from its high 2 days ago");
      expect(flag?.severity).toBe("critical");
    });

    it("control: the same clean token with an ordinary 30-day history is not a RUG and carries no collapse flag", async () => {
      setupGoodTokenMocks();
      const { fetchDexCandlesDaily } = await import("../api/_lib/fetchers");
      const calm = GOIF_CANDLES.map((c, i) => ({ ...c, c: 100 - i * 0.5, o: 100 - i * 0.5, h: 101 - i * 0.5, l: 99 - i * 0.5 })); // drifts 9 % down over the history
      vi.mocked(fetchDexCandlesDaily).mockResolvedValueOnce(calm);
      const body = await scanBody();
      expect(body.risk).not.toBe("RUG");
      expect(body.flags.some((f) => /^Collapsed/.test(f.label))).toBe(false);
    });

    it("a collapse from a high 20 days back is DANGER, not a forced RUG; from a high 150 days back it is not read at all", async () => {
      const T0 = 1_760_000_000;
      const bleedFrom = (days: number) => Array.from({ length: days * 6 + 1 }, (_, i) => { const c = i === 0 ? 100 : 5; return { ts: T0 + i * 4 * 3600, o: c, h: c, l: c, c, v: 100 }; }); // 6 candles a day
      setupGoodTokenMocks();
      const { fetchDexCandlesDaily } = await import("../api/_lib/fetchers");
      vi.mocked(fetchDexCandlesDaily).mockResolvedValueOnce(bleedFrom(20));
      const slow = await scanBody();
      expect(slow.risk).toBe("DANGER");
      expect(slow.rugKind).toBeNull(); // only a RUG verdict has a kind
      expect(slow.flags.find((f) => /^Collapsed/.test(f.label))?.label).toBe("Collapsed -95% from its high 20 days ago");

      setupGoodTokenMocks();
      vi.mocked(fetchDexCandlesDaily).mockResolvedValueOnce(bleedFrom(150));
      const old = await scanBody();
      expect(old.risk).not.toBe("RUG");
      expect(old.flags.some((f) => /^Collapsed/.test(f.label))).toBe(false);
    });
  });

  it("the Helius holder pages are given GoPlus's holder count, so the pages of a very large token can be skipped", async () => {
    setupGoodTokenMocks();
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) =>
      String(url).includes("gopluslabs")
        ? Promise.resolve({ ok: true, json: () => Promise.resolve({ result: { So11111111111111111111111111111111111111112: { holder_count: "1234567" } } }) })
        : base(url, ...rest));
    const res = createMockRes();
    await handler(createMockReq({ ca: "So11111111111111111111111111111111111111112" }), res);

    expect(mockHeliusGetHolderPages).toHaveBeenCalledTimes(1);
    const hint = mockHeliusGetHolderPages.mock.calls[0][2] as Promise<number | null>;
    await expect(hint).resolves.toBe(1234567);
  });

  it("a cold scan does not build the insider graph: it feeds no verdict and costs ~120 Helius credits", async () => {
    setupGoodTokenMocks();
    const res = createMockRes();
    await handler(createMockReq({ ca: "So11111111111111111111111111111111111111112" }), res);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    // The premise: this scan has what the graph used to need (holders and a supply), so it WOULD have been built.
    expect(mockHeliusGetLargestAccounts).toHaveBeenCalled();
    expect(mockBuildInsiderGraph).not.toHaveBeenCalled();
    // The hero cards still exist: they come from the holders and the creator, not from the graph.
    expect(Array.isArray(body.criticalActors)).toBe(true);
    expect((body.criticalActors as unknown[]).every((a) => (a as { type: string }).type !== "cluster")).toBe(true);
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
// The same warning from two layers cannot be produced without faking the layers themselves, so this guard reads the order in the source: the flags are deduplicated, THEN counted, THEN the verdict is decided on those counts.
describe("the decision counts the flags after deduplicating them", () => {
  // The decision lives in api/_lib/decide.ts (a pure function), no longer in the handler.
  const src = readFileSync(new URL("../api/_lib/decide.ts", import.meta.url), "utf8");

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

// ─── A live pump.fun token: its pair has no liquidity field (audit M8) ───────────────────────────────────────────────
// A pair still on the pump.fun bonding curve never carries a liquidity figure. With $73k of volume it used to be an "abandoned
// pool" forced to RUG. It must be judged on what is known: the missing liquidity is a warning that blocks SAFE, not a verdict.
describe("scan handler — token on the pump.fun bonding curve", () => {
  const MINT = "So11111111111111111111111111111111111111112";

  function scanOnCurve(ageHours: number, volume24h: number, liquidity?: { usd: number }) {
    setupGoodTokenMocks();
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("dexscreener")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            pairs: [{
              pairAddress: "pair1",
              dexId: "pumpfun",
              baseToken: { address: MINT, symbol: "CURVE", name: "Curve" },
              ...(liquidity ? { liquidity } : {}),
              volume: { h24: volume24h, h1: volume24h / 3 },
              priceChange: { m5: 0.5, h1: 4, h6: 20, h24: 60 },
              txns: { m5: { buys: 15, sells: 12 } },
              priceUsd: "0.00005",
              marketCap: 44_000,
              fdv: 44_000,
              pairCreatedAt: Date.now() - ageHours * 3600 * 1000,
              info: { socials: [{ type: "twitter", url: "https://twitter.com/test" }], websites: [{ url: "https://test.com" }] },
            }],
          }),
        });
      }
      return goodMocks(url, ...rest);
    });
    // the engine takes the OLDEST age among its sources: Solscan must agree on the age
    const solscanGood = mockFetchSolscan.getMockImplementation() as (endpoint: string) => Promise<unknown>;
    mockFetchSolscan.mockImplementation((endpoint: string) =>
      endpoint.includes("meta")
        ? Promise.resolve({ data: { created_time: Math.floor(Date.now() / 1000) - ageHours * 3600, icon: "https://img.test.com/icon.png", creator: "creator123", decimals: 9, supply: 100000 } })
        : solscanGood(endpoint));
  }

  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; flags: Array<{ label: string; severity: string }> };
  }

  it("1 h old, $73k of volume, no liquidity field: not an abandoned pool, not RUG, and not SAFE", async () => {
    scanOnCurve(1, 73_000);

    const body = await run();

    expect(body.flags.some((f) => /abandoned pool|Very low liquidity/i.test(f.label))).toBe(false);
    expect(body.flags.some((f) => f.severity === "warning" && /bonding curve \(not migrated yet\)/i.test(f.label))).toBe(true);
    expect(body.risk).toBe("CAUTION"); // a young curve token cannot be SAFE (no measured pool) and is not an exit trap
  });

  it("witness: the same pair 553 days later, never migrated, is the abandoned pool it always was: RUG", async () => {
    scanOnCurve(553 * 24, 62_999);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /abandoned pool/i.test(f.label))).toBe(true);
    expect(body.risk).toBe("RUG");
  });

  it("witness: a MEASURED zero liquidity with $73k of volume is an abandoned pool even on pump.fun", async () => {
    scanOnCurve(1, 73_000, { usd: 0 });

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /abandoned pool/i.test(f.label))).toBe(true);
    expect(body.risk).toBe("RUG");
  });
});

// ─── The Pro/Free line is drawn on the server (api/_lib/pro-gate.ts) ─────────────────────────────────────────────────
// Every other test of this file asks as a Pro install (see the header of createMockReq): they read the FULL scan. These two ask the
// same scan as a Free caller (no install, no session) and as a Pro one, and compare.
describe("scan handler — the Pro/Free line is drawn on the server", () => {
  const MINT = "So11111111111111111111111111111111111111112";
  const ask = async (asPro: boolean) => {
    setupGoodTokenMocks();
    const base = createMockReq({ ca: MINT });
    const req = asPro ? base : ({ ...base, headers: { origin: "https://dexscreener.com", "x-forwarded-for": "1.2.3.4" } } as unknown as VercelRequest);
    const res = createMockRes();
    await handler(req, res);
    return (res as unknown as { getBody: () => Record<string, unknown> }).getBody();
  };

  it("a Free caller gets the verdict, the score and the Sell/Mint/Freeze/LP line, and none of the analysis", async () => {
    const body = await ask(false);
    expect(body.proLocked).toBe(true);
    expect(body.risk).toBeDefined();
    expect(body.score).toBeTypeOf("number");
    expect(body).toHaveProperty("mintAuthority");
    expect(body).toHaveProperty("freezeAuthority");
    expect(body).toHaveProperty("honeypot");
    for (const pro of ["layers", "sources_used", "aiSummary", "criticalActors", "verdictHistory", "holderActivity", "holders", "confidence", "tokenCreator"]) {
      expect(body, pro).not.toHaveProperty(pro);
    }
    // Whatever flags are left carry no text.
    for (const f of body.flags as Array<{ label: string }>) expect(f.label).toBe("Part of Antares Pro");
  });

  it("a Pro caller gets the full scan", async () => {
    const body = await ask(true);
    expect(body.proLocked).toBeUndefined();
    expect(body.layers).toBeDefined();
    expect(Array.isArray(body.sources_used)).toBe(true);
    expect((body.flags as Array<{ label: string }>).some((f) => f.label !== "Part of Antares Pro")).toBe(true);
  });

  it("Free and Pro get the same verdict and the same score: the gate shows less, it never decides differently", async () => {
    const free = await ask(false);
    const pro = await ask(true);
    expect(free.risk).toBe(pro.risk);
    expect(free.score).toBe(pro.score);
  });
});

// ─── A token that has rugged stays a RUG (the owner's rule, 2026-10-12) ───────────────────────────────────────────────────────
describe("scan handler — a condemned token stays a RUG", () => {
  const MINT = "So11111111111111111111111111111111111111112";
  const CONDEMNED_AT = Date.UTC(2026, 5, 3); // flagged on 2026-06-03, months before the scan

  function drainedPool() {
    setupGoodTokenMocks();
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("dexscreener")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            pairs: [{
              pairAddress: "pair1",
              baseToken: { address: MINT, symbol: "GONE", name: "Gone" },
              liquidity: { usd: 0 }, volume: { h24: 73_000, h1: 3_000 },
              priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 }, txns: { m5: { buys: 2, sells: 2 } },
              priceUsd: "0.0001", marketCap: 40_000, fdv: 40_000,
              pairCreatedAt: Date.now() - 90 * 24 * 3600 * 1000,
              info: { socials: [{ type: "twitter", url: "https://twitter.com/test" }], websites: [{ url: "https://test.com" }] },
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
      risk: string; rugKind: string | null; score: number; flags: Array<{ label: string; severity: string }>;
    };
  }

  it("witness: the data of a token that rugged months ago is clean now, and a token that is not condemned reads as the data says (not RUG)", async () => {
    setupGoodTokenMocks();
    const body = await run();
    expect(body.risk).not.toBe("RUG");
    expect(mockGetCondemned).toHaveBeenCalledWith(MINT);
    expect(mockCondemn).not.toHaveBeenCalled(); // a clean scan condemns nobody
  });

  it("the same clean data on a condemned token: still a RUG PULL, with the date and the reason, and a score of a RUG", async () => {
    setupGoodTokenMocks();
    mockGetCondemned.mockResolvedValue({ mint: MINT, symbol: "SOL", condemnedAt: CONDEMNED_AT, evidence: ["Volume with zero liquidity — abandoned pool"] });

    const body = await run();

    expect(body.risk).toBe("RUG");
    expect(body.rugKind).toBe("confirmed");
    expect(body.score).toBeLessThanOrEqual(100);
    const flag = body.flags.find((f) => /^Flagged as a rug on 2026-06-03/.test(f.label));
    expect(flag?.severity).toBe("critical");
    expect(flag?.label).toContain("abandoned pool");
    expect(mockCondemn).not.toHaveBeenCalled(); // the first record is kept, not rewritten
  });

  it("a drained pool on complete data condemns the token, with the critical flags that said it", async () => {
    drainedPool();

    const body = await run();

    expect(body.risk).toBe("RUG");
    expect(body.rugKind).toBe("confirmed");
    expect(mockCondemn).toHaveBeenCalledTimes(1);
    const entry = mockCondemn.mock.calls[0][0] as { mint: string; symbol: string | null; evidence: string[]; condemnedAt: number };
    expect(entry.mint).toBe(MINT);
    expect(entry.evidence).toContain("Volume with zero liquidity — abandoned pool");
    expect(entry.condemnedAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a record that cannot be read (Redis slow or down) is 'not condemned': the scan goes on from the data and still answers", async () => {
    setupGoodTokenMocks();
    mockGetCondemned.mockRejectedValue(new Error("redis down"));
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    // withBudget turns a rejection into null: the verdict is the data's
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string };
    expect(body.risk).not.toBe("RUG");
  });
});

// ─── A crash on a blue chip (audit A-09, the owner's bar: 2 months, $100k in the pool, $5M of market cap) ─────────────────────
describe("scan handler — a price crash on a blue chip", () => {
  const MINT = "So11111111111111111111111111111111111111112";
  const DAY_MS = 24 * 3600 * 1000;

  function scanCrash(o: { ageDays: number; liq: number; mcap: number; pc6: number; pc1: number; pc24: number }) {
    setupGoodTokenMocks();
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("dexscreener")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            pairs: [{
              pairAddress: "pair1",
              baseToken: { address: MINT, symbol: "BLUE", name: "Blue" },
              liquidity: { usd: o.liq },
              volume: { h24: 900_000, h1: 40_000 },
              priceChange: { m5: -1, h1: o.pc1, h6: o.pc6, h24: o.pc24 },
              txns: { m5: { buys: 15, sells: 15 } },
              priceUsd: "1.5",
              marketCap: o.mcap,
              fdv: o.mcap,
              pairCreatedAt: Date.now() - o.ageDays * DAY_MS,
              info: { socials: [{ type: "twitter", url: "https://twitter.com/test" }], websites: [{ url: "https://test.com" }] },
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
      risk: string; rugKind: string | null; flags: Array<{ label: string; severity: string }>;
    };
  }

  const bar = { ageDays: 90, liq: 500_000, mcap: 50_000_000 };
  const sixHourCrash = { pc6: -63, pc1: -22, pc24: -40 };

  it("the 6 h crash on a blue chip is a critical Sharp crash and DANGER, not a RUG", async () => {
    scanCrash({ ...bar, ...sixHourCrash });
    const body = await run();
    expect(body.risk).toBe("DANGER");
    expect(body.rugKind).toBeNull();
    expect(body.flags.find((f) => /^Sharp crash/.test(f.label))?.severity).toBe("critical");
    expect(body.flags.some((f) => /slow rug/i.test(f.label))).toBe(false);
  });

  it("the 24 h crash on a blue chip is a critical Sharp crash and DANGER, not a RUG", async () => {
    scanCrash({ ...bar, pc6: -10, pc1: -25, pc24: -65 });
    const body = await run();
    expect(body.risk).toBe("DANGER");
    expect(body.flags.find((f) => /^Sharp crash: -65% on 24h/.test(f.label))?.severity).toBe("critical");
    expect(body.flags.some((f) => /active dump/i.test(f.label))).toBe(false);
  });

  it.each([
    ["a pair of 30 days", { ageDays: 30 }],
    ["a pool of $90k", { liq: 90_000 }],
    ["a market cap of $4M", { mcap: 4_000_000 }],
  ])("%s is not a blue chip: the 6 h crash stays a RUG, with the old label", async (_name, over) => {
    scanCrash({ ...bar, ...over, ...sixHourCrash });
    const body = await run();
    expect(body.risk).toBe("RUG");
    expect(body.flags.some((f) => /^Slow rug detected/.test(f.label))).toBe(true);
  });

  it.each([
    ["a pair of 30 days", { ageDays: 30 }],
    ["a pool of $90k", { liq: 90_000 }],
    ["a market cap of $4M", { mcap: 4_000_000 }],
  ])("%s is not a blue chip: the 24 h crash stays a RUG, with the old label", async (_name, over) => {
    scanCrash({ ...bar, ...over, pc6: -10, pc1: -25, pc24: -65 });
    const body = await run();
    expect(body.risk).toBe("RUG");
    expect(body.flags.some((f) => /^Active dump/.test(f.label))).toBe(true);
  });

  it("a real token with a thin DEX pool (W, ZBCN, PHY: $100k to $190k) is covered: the floor of the pool is $100k", async () => {
    scanCrash({ ...bar, liq: 100_000, ...sixHourCrash });
    expect((await run()).risk).toBe("DANGER");
    scanCrash({ ...bar, liq: 150_000, mcap: 120_000_000, pc6: -10, pc1: -25, pc24: -65 });
    expect((await run()).risk).toBe("DANGER");
  });

  it("a blue chip that lost more than 70 % in 6 h is no longer a market-wide sell-off: RUG", async () => {
    scanCrash({ ...bar, pc6: -75, pc1: -22, pc24: -80 });
    expect((await run()).risk).toBe("RUG");
  });
});

// ─── Token-2022 extensions through the whole scan (audit A-10) ─────────────────────────────────────────────────────────────────
describe("scan handler — Token-2022 extensions", () => {
  // Not So1111...: wrapped SOL is on the list of official mints, whose authorities and extensions are information only.
  const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const ADDR = "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk";
  const fee = (bps: number, authority: string | null) => ({ extension: "transferFeeConfig", state: {
    newerTransferFee: { epoch: 1, maximumFee: 0, transferFeeBasisPoints: bps }, olderTransferFee: { epoch: 1, maximumFee: 0, transferFeeBasisPoints: bps }, transferFeeConfigAuthority: authority } });
  const metadata = [{ extension: "metadataPointer", state: { authority: null, metadataAddress: ADDR } }, { extension: "tokenMetadata", state: { name: "Blue", symbol: "BLUE" } }];

  function token2022(extensions: Array<{ extension: string; state?: Record<string, unknown> }>, goplusDown = false) {
    setupGoodTokenMocks();
    mockHeliusGetMintAccount.mockResolvedValue(mintAccountResponse({ program: "spl-token-2022", extensions }));
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const answer = (await goodMocks(url, ...rest)) as { ok: boolean; json: () => Promise<unknown> };
      if (url.includes("gopluslabs")) {
        if (goplusDown) return { ok: false, json: () => Promise.resolve(null) };
        const j = (await answer.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ result: { [MINT]: Object.values(j.result)[0] } }) };
      }
      if (url.includes("dexscreener")) {
        const j = (await answer.json()) as { pairs: Array<{ baseToken: { address: string } }> };
        return { ok: true, json: () => Promise.resolve({ pairs: j.pairs.map((p) => ({ ...p, baseToken: { ...p.baseToken, address: MINT } })) }) };
      }
      return answer;
    });
  }
  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; flags: Array<{ label: string; severity: string }> };
  }
  const labels = (b: { flags: Array<{ label: string }> }) => b.flags.map((f) => f.label);

  it("witness: a Token-2022 token with only metadata is read as before (nothing about the extensions, not blocked by them)", async () => {
    token2022(metadata);
    const body = await run();
    expect(labels(body).some((l) => /delegate|pausable|frozen|hook|transfer fee/i.test(l))).toBe(false);
    expect(body.risk).toBe("SAFE");
  });

  it("a permanent delegate and a fee an authority can change: critical flags, not SAFE", async () => {
    token2022([...metadata, { extension: "permanentDelegate", state: { delegate: ADDR } }, fee(0, ADDR)]);
    const body = await run();
    expect(labels(body)).toEqual(expect.arrayContaining(["Permanent delegate — an address can move or burn any holder's tokens", "Transfer fee can be changed — an authority can raise it to 100%"]));
    expect(body.flags.find((f) => /^Permanent delegate/.test(f.label))?.severity).toBe("critical");
    expect(body.risk).not.toBe("SAFE");
    expect(["DANGER", "RUG"]).toContain(body.risk);
  });

  it("the audit's proof case: GoPlus not answering does not hide them (permanent delegate + fee authority, still not SAFE)", async () => {
    token2022([...metadata, { extension: "permanentDelegate", state: { delegate: ADDR } }, fee(0, ADDR)], true);
    const body = await run();
    expect(labels(body)).toEqual(expect.arrayContaining(["Permanent delegate — an address can move or burn any holder's tokens"]));
    expect(body.risk).not.toBe("SAFE");
  });

  it("a 4 % transfer fee with its authority renounced ($CWIF, BURN): a warning, CAUTION, no longer SAFE", async () => {
    token2022([...metadata, fee(400, null)]);
    const body = await run();
    expect(body.flags.find((f) => /^Transfer fee 4% on every transfer/.test(f.label))?.severity).toBe("warning");
    expect(body.risk).toBe("CAUTION");
  });

  it("a fee extension at 0 % with no authority is harmless: nothing is said", async () => {
    token2022([...metadata, fee(0, null)]);
    const body = await run();
    expect(labels(body).some((l) => /transfer fee/i.test(l))).toBe(false);
    expect(body.risk).toBe("SAFE");
  });

  it("a hook extension with no program set (as PYUSD and the tokenised stocks have it) says nothing; with a program set it is critical", async () => {
    token2022([...metadata, { extension: "transferHook", state: { authority: ADDR, programId: null } }]);
    expect(labels(await run()).some((l) => /^Transfer hook/.test(l))).toBe(false);
    token2022([...metadata, { extension: "transferHook", state: { authority: null, programId: "Hook111111111111111111111111111111111111111" } }]);
    const body = await run();
    expect(body.flags.find((f) => /^Transfer hook/.test(f.label))?.severity).toBe("critical");
    expect(body.risk).not.toBe("SAFE");
  });
});

// ─── Pools where the scanned token is only the quote (audit A-26) ──────────────────────────────────────────────────────────────────
describe("scan handler — a pool where the scanned token is only the quote", () => {
  const MINT = "So11111111111111111111111111111111111111112"; // the scanned token
  const OTHER = "OtherTokenMint1111111111111111111111111111111";

  function dexWith(pairs: unknown[]) {
    setupGoodTokenMocks();
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("dexscreener") && url.includes("/tokens/")) return Promise.resolve({ ok: true, json: () => Promise.resolve({ pairs }) });
      return goodMocks(url, ...rest);
    });
  }
  const info = { socials: [{ type: "twitter", url: "https://twitter.com/test" }], websites: [{ url: "https://test.com" }] };
  const quoteOnly = {
    pairAddress: "pairQuote", dexId: "raydium", baseToken: { address: OTHER, symbol: "OTHER", name: "Other" }, quoteToken: { address: MINT, symbol: "BLUE", name: "Blue" },
    liquidity: { usd: 90_000_000 }, volume: { h24: 50_000_000 }, priceChange: { m5: 0, h1: 0, h6: 0, h24: 2 }, priceUsd: "150", marketCap: 80_000_000, fdv: 80_000_000,
    pairCreatedAt: Date.now() - 400 * 24 * 3600 * 1000, info,
  };
  const asBase = {
    pairAddress: "pairBase", dexId: "raydium", baseToken: { address: MINT, symbol: "BLUE", name: "Blue" }, quoteToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", name: "USDC" },
    liquidity: { usd: 500_000 }, volume: { h24: 200_000 }, priceChange: { m5: 1, h1: 1, h6: 1, h24: 3 }, priceUsd: "1.5", marketCap: 12_000_000, fdv: 12_000_000,
    pairCreatedAt: Date.now() - 400 * 24 * 3600 * 1000, info,
  };

  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { resolvedMint: string; priceUsd: number | null; liquidity: number | null; tokenSymbol: string | null };
  }

  it("the deepest pool lists the scanned token as the quote and comes FIRST: the scan still reads the token's own pool", async () => {
    dexWith([quoteOnly, asBase]);
    const body = await run();
    expect(body.resolvedMint).toBe(MINT);       // not OTHER, the base of the first pool
    expect(body.tokenSymbol).toBe("BLUE");
    expect(Number(body.priceUsd)).toBe(1.5);    // not 150, the price of the OTHER token
    expect(body.liquidity).toBe(500_000);
  });

  it("the same when the pool where it is the base comes first (order does not matter)", async () => {
    dexWith([asBase, quoteOnly]);
    const body = await run();
    expect(body.resolvedMint).toBe(MINT);
    expect(Number(body.priceUsd)).toBe(1.5);
    expect(body.liquidity).toBe(500_000);
  });
});

