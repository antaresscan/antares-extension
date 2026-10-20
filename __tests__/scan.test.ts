import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { SCORING_VERSION } from "../api/_lib/constants";
import { STABLE_MINTS } from "../api/_lib/issuer-assets.data";

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
  // The memory of the last time an issuer-backed token's market was read: none.
  getLastGoodResult: vi.fn().mockResolvedValue(null),
  setLastGoodResult: vi.fn(),
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
  // The scan asks for the list through this one (it adds the last list and the retries): here it is the same mock, as a live answer.
  heliusGetLargestAccountsRemembered: async (...args: unknown[]) => ({ response: (await mockHeliusGetLargestAccounts(...args)) as unknown, source: "helius" as const }),
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

    const T0 = 1_760_000_000;
    const bleedFrom = (days: number) => Array.from({ length: days * 6 + 1 }, (_, i) => { const c = i === 0 ? 100 : 5; return { ts: T0 + i * 4 * 3600, o: c, h: c, l: c, c, v: 100 }; }); // 6 candles a day

    // The owner's rule (2026-10-21, TripleT): the collapse is the ONLY risky flag and Sell, Mint, Freeze, LP and Liq are all green (this token: burned LP, $500k pool).
    it("a collapse from a high 20 days back, alone, on a token whose five cells are green is a CAUTION, not a DANGER or a forced RUG; from a high 150 days back it is not read at all", async () => {
      setupGoodTokenMocks();
      const { fetchDexCandlesDaily } = await import("../api/_lib/fetchers");
      vi.mocked(fetchDexCandlesDaily).mockResolvedValueOnce(bleedFrom(20));
      const slow = await scanBody();
      expect(slow.risk).toBe("CAUTION");
      expect(slow.rugKind).toBeNull(); // only a RUG verdict has a kind
      const flag = slow.flags.find((f) => /^Collapsed/.test(f.label));
      expect(flag?.label).toBe("Collapsed -95% from its high 20 days ago");
      expect(flag?.severity).toBe("warning"); // shown as a warning: the token is never SAFE with it
      expect(slow.flags.filter((f) => f.severity === "critical" || f.severity === "warning")).toHaveLength(1);

      setupGoodTokenMocks();
      vi.mocked(fetchDexCandlesDaily).mockResolvedValueOnce(bleedFrom(150));
      const old = await scanBody();
      expect(old.risk).not.toBe("RUG");
      expect(old.flags.some((f) => /^Collapsed/.test(f.label))).toBe(false);
    });

    it("the same collapse stays a critical DANGER when one cell is not green: here the pool is under $50k (the Liq cell)", async () => {
      setupGoodTokenMocks();
      const base = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
        const res = await base(url, ...rest) as { ok: boolean; json: () => Promise<{ pairs: Array<{ liquidity: { usd: number } }> }> };
        if (!String(url).includes("dexscreener")) return res;
        const body = await res.json();
        body.pairs[0].liquidity = { usd: 40_000 };
        return { ok: true, json: () => Promise.resolve(body) };
      });
      const { fetchDexCandlesDaily } = await import("../api/_lib/fetchers");
      vi.mocked(fetchDexCandlesDaily).mockResolvedValueOnce(bleedFrom(20));
      const thin = await scanBody();
      expect(thin.risk).toBe("DANGER");
      expect(thin.flags.find((f) => /^Collapsed/.test(f.label))?.severity).toBe("critical");
    });

    it("a collapse from a high 10 days back stays a RUG PULL on the same green token: the rule is for the older highs only", async () => {
      setupGoodTokenMocks();
      const { fetchDexCandlesDaily } = await import("../api/_lib/fetchers");
      vi.mocked(fetchDexCandlesDaily).mockResolvedValueOnce(bleedFrom(10));
      const fresh = await scanBody();
      expect(fresh.risk).toBe("RUG");
      expect(fresh.rugKind).toBe("confirmed");
      expect(fresh.flags.find((f) => /^Collapsed/.test(f.label))?.severity).toBe("critical");
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

  it("stamps the quota headers the published extension reads (its tier, unlimited) and never refuses a scan for a quota", async () => {
    setupGoodTokenMocks();
    const req = createMockReq({ ca: "So11111111111111111111111111111111111111112" });
    const res = createMockRes();
    await handler(req, res);
    expect((res as unknown as { getStatusCode: () => number }).getStatusCode()).toBe(200);
    // The install of these tests is in DEV_PRO_INSTALLS (see the top of this file): its tier is Yearly.
    expect((res as unknown as { getHeaders: () => Record<string, string> }).getHeaders()).toMatchObject({
      "X-Antares-Quota-Tier": "yearly",
      "X-Antares-Quota-Limit": "-1",
      "X-Antares-Quota-Used": "0",
      "X-Antares-Quota-Remaining": "-1",
      "X-Antares-Quota-Reset": "0",
    });
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

// ─── The biggest holders when Helius gives none (2026-10-18) ──────────────────────────────────────────
// Helius answers the tokens with the most holders (TRUMP, RAY, JUP, PENGU, BONK) with "account index service overloaded" and an HTTP 200 about nine scans in ten; the scan then had no
// list, the whole Helius layer went missing and the verdict moved from one scan to the next. The call is asked again and the last list is served (fetchers.ts, tested there); when there
// is none, RugCheck's report holds the same 20 biggest holders: the concentration is read from them, SAFE stays blocked, and a line says where the list came from.
describe("scan handler — no list of the biggest holders from Helius", () => {
  const MINT = "So11111111111111111111111111111111111111112";
  const rcHolder = (i: number, uiAmount: number) => ({ address: `rc${i}`, owner: `rcowner${i}`, uiAmount, pct: uiAmount / 1000, amount: uiAmount, decimals: 9, insider: false });

  /** The good-token mocks, with a RugCheck report that has these holders (supply of the good-token mocks: 100,000). */
  function scanWithRugCheckHolders(topHolders: unknown, heliusList: unknown = null, pairAgeHours?: number) {
    setupGoodTokenMocks();
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation((url: string, ...rest: unknown[]) => {
      if (url.includes("rugcheck") && url.includes("report") && !url.includes("summary")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ risks: [], topHolders, totalHolders: 5000 }) });
      }
      if (pairAgeHours !== undefined && url.includes("dexscreener")) {
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
              pairCreatedAt: Date.now() - pairAgeHours * 3600 * 1000,
              info: { socials: [{ type: "twitter", url: "https://twitter.com/test" }], websites: [{ url: "https://test.com" }] },
            }],
          }),
        });
      }
      return goodMocks(url, ...rest);
    });
    mockHeliusGetLargestAccounts.mockResolvedValue(heliusList);
  }

  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; flags: Array<{ label: string; severity: string }> };
  }

  const READ_FROM_RUGCHECK = /holder concentration read from rugcheck/i;
  const HELIUS_UNAVAILABLE = /helius unavailable/i;

  it("RugCheck's list is read: a wallet at 60 % is the critical flag it is with Helius's list, and a line says where the list came from", async () => {
    scanWithRugCheckHolders([rcHolder(0, 60_000), ...Array.from({ length: 19 }, (_, i) => rcHolder(i + 1, 400))]);

    const body = await run();

    expect(body.flags.some((f) => f.severity === "critical" && /single wallet holds 60%/i.test(f.label))).toBe(true);
    expect(body.flags.some((f) => f.severity === "info" && READ_FROM_RUGCHECK.test(f.label))).toBe(true);
    expect(body.flags.some((f) => HELIUS_UNAVAILABLE.test(f.label))).toBe(false);
    expect(body.risk).not.toBe("SAFE");
    // RugCheck gives the owner of every account: no Helius call to find them (and none the recorded corpus of the replay would not have).
    expect(mockHeliusResolveAccountOwners).not.toHaveBeenCalled();
  });

  it("a quiet distribution is read too, and SAFE stays blocked: no second source confirms it", async () => {
    scanWithRugCheckHolders(Array.from({ length: 20 }, (_, i) => rcHolder(i, 400)));

    const body = await run();

    expect(body.flags.some((f) => READ_FROM_RUGCHECK.test(f.label))).toBe(true);
    expect(body.flags.some((f) => HELIUS_UNAVAILABLE.test(f.label))).toBe(false);
    expect(body.risk).not.toBe("SAFE");
  });

  it("witness: when Helius gives its list, RugCheck's is not used and no line is added", async () => {
    scanWithRugCheckHolders(
      [rcHolder(0, 60_000), ...Array.from({ length: 19 }, (_, i) => rcHolder(i + 1, 400))],
      { result: { value: Array.from({ length: 20 }, (_, i) => ({ address: `h${i}`, uiAmount: 400 })) } },
    );

    const body = await run();

    expect(body.flags.some((f) => READ_FROM_RUGCHECK.test(f.label))).toBe(false);
    expect(body.flags.some((f) => /single wallet holds 60%/i.test(f.label))).toBe(false);
  });

  it("a NEW token keeps the honest 'unverified': a launch's bonding curve is not a pool whose address is known, its vault would be read as a whale", async () => {
    scanWithRugCheckHolders([rcHolder(0, 60_000), ...Array.from({ length: 19 }, (_, i) => rcHolder(i + 1, 400))], null, 48);

    const body = await run();

    expect(body.flags.some((f) => READ_FROM_RUGCHECK.test(f.label))).toBe(false);
    expect(body.flags.some((f) => /single wallet holds 60%/i.test(f.label))).toBe(false);
    expect(body.flags.some((f) => HELIUS_UNAVAILABLE.test(f.label))).toBe(true);
  });

  it("witness: the same token at 4 days old is an established one, its list is read", async () => {
    scanWithRugCheckHolders([rcHolder(0, 60_000), ...Array.from({ length: 19 }, (_, i) => rcHolder(i + 1, 400))], null, 96);

    const body = await run();

    expect(body.flags.some((f) => READ_FROM_RUGCHECK.test(f.label))).toBe(true);
    expect(body.flags.some((f) => HELIUS_UNAVAILABLE.test(f.label))).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", []],
    ["with an entry that has no amount (an incomplete list is a wrong concentration)", [rcHolder(0, 400), { address: "x", owner: "y" }]],
  ])("a RugCheck report whose list is %s: the layer is missing as before, with its warning", async (_name, topHolders) => {
    scanWithRugCheckHolders(topHolders);

    const body = await run();

    expect(body.flags.some((f) => HELIUS_UNAVAILABLE.test(f.label))).toBe(true);
    expect(body.flags.some((f) => READ_FROM_RUGCHECK.test(f.label))).toBe(false);
    expect(body.risk).not.toBe("SAFE");
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

  // The writes that remember a RUG for good (condemnation, Wall of Shame) used to be started and left: once the answer is out the platform may
  // stop the function, and a write still in flight is lost. They are now waited for (1 s at most) before a RUG is answered, and for no other verdict.
  async function untilCalled(fn: ReturnType<typeof vi.fn>) {
    const t0 = Date.now();
    while (fn.mock.calls.length === 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
  }

  it("a confirmed rug: the answer is not sent before the condemnation has landed, and it is the same RUG", async () => {
    drainedPool();
    let land!: () => void;
    mockCondemn.mockReturnValue(new Promise<void>((resolve) => { land = resolve; }));
    const res = createMockRes();
    const pending = handler(createMockReq({ ca: MINT }), res);

    await untilCalled(mockCondemn);
    await new Promise((r) => setTimeout(r, 150)); // everything else is long done: only the write is holding the answer
    expect(mockCondemn).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();

    land();
    await pending;
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; rugKind: string | null };
    expect(body.risk).toBe("RUG");
    expect(body.rugKind).toBe("confirmed");
  });

  it("a condemnation that never lands holds the answer for 1 s at most, and the verdict does not change", async () => {
    drainedPool();
    mockCondemn.mockReturnValue(new Promise<void>(() => {})); // Redis hangs
    const res = createMockRes();
    const t0 = Date.now();
    await handler(createMockReq({ ca: MINT }), res);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; rugKind: string | null };
    expect(body.risk).toBe("RUG");
    expect(body.rugKind).toBe("confirmed");
  });

  it("a condemnation that fails cannot break the answer", async () => {
    drainedPool();
    mockCondemn.mockRejectedValue(new Error("redis down"));
    const body = await run();
    expect(body.risk).toBe("RUG");
    expect(mockCondemn).toHaveBeenCalledTimes(1);
  });

  it("a verdict that is not a RUG never waits for the rug writes", async () => {
    setupGoodTokenMocks();
    mockCondemn.mockReturnValue(new Promise<void>(() => {})); // would hang, but a clean scan does not even call it
    const res = createMockRes();
    const t0 = Date.now();
    await handler(createMockReq({ ca: MINT }), res);

    expect(Date.now() - t0).toBeLessThan(800);
    expect(mockCondemn).not.toHaveBeenCalled();
    expect((res.json as ReturnType<typeof vi.fn>).mock.calls[0][0].risk).not.toBe("RUG");
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

// ─── Stablecoins and tokenized stocks through the whole scan (the owner's rule of 2026-10-13: both SAFE when the market is healthy) ──────────────────────────────────
describe("scan handler — issuer-backed tokens are judged on their market", () => {
  const STOCK = "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"; // Apple xStock
  const STABLE = STABLE_MINTS.find((m) => m !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" && m !== "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") as string;
  const COPY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // same structure, not in the registry
  const ADDR = "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk";

  // The structure of an issuer: both authorities active, a permanent delegate, a pause.
  const issuerMint = () => mintAccountResponse({
    program: "spl-token-2022", mintAuthority: ADDR, freezeAuthority: ADDR,
    extensions: [{ extension: "permanentDelegate", state: { delegate: ADDR } }, { extension: "pausableConfig", state: { authority: ADDR, paused: false } },
      { extension: "metadataPointer", state: { authority: null, metadataAddress: ADDR } }],
  });

  function scanAs(mint: string, over: { liq?: number; vol?: number; pegged?: boolean; pairs?: unknown[]; priceUsd?: string } = {}) {
    setupGoodTokenMocks();
    mockHeliusGetMintAccount.mockResolvedValue(issuerMint());
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const answer = (await goodMocks(url, ...rest)) as { ok: boolean; json: () => Promise<unknown> };
      if (url.includes("gopluslabs")) {
        const j = (await answer.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ result: { [mint]: Object.values(j.result)[0] } }) };
      }
      if (url.includes("dexscreener")) {
        if (over.pairs) return { ok: true, json: () => Promise.resolve({ pairs: over.pairs }) };
        const j = (await answer.json()) as { pairs: Array<Record<string, unknown> & { baseToken: { address: string }; liquidity: { usd: number }; volume: { h24: number } }> };
        return { ok: true, json: () => Promise.resolve({ pairs: j.pairs.map((p) => ({
          ...p, baseToken: { ...p.baseToken, address: mint },
          liquidity: { usd: over.liq ?? p.liquidity.usd }, volume: { ...p.volume, h24: over.vol ?? p.volume.h24 },
          ...(over.pegged ? { priceChange: { m5: 0, h1: 0.05, h6: 0.1, h24: 0.2 }, priceUsd: "1.0001" } : {}),
          ...(over.priceUsd ? { priceUsd: over.priceUsd } : {}),
        })) }) };
      }
      return answer;
    });
  }
  async function run(mint: string) {
    const res = createMockRes();
    await handler(createMockReq({ ca: mint }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; rugKind: string | null; flags: Array<{ label: string; severity: string }> };
  }
  const flagOf = (b: { flags: Array<{ label: string; severity: string }> }, re: RegExp) => b.flags.find((f) => re.test(f.label));

  it("witness: the same structure on a token that is not in the registry is read as any token's: authorities are critical, not SAFE", async () => {
    scanAs(COPY);
    const body = await run(COPY);
    expect(["DANGER", "RUG"]).toContain(body.risk);
    expect(flagOf(body, /^Freeze authority active/)?.severity).toBe("critical");
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("critical");
  });

  it("a registry stablecoin with that structure and a healthy market is SAFE; its authorities are still shown, as information", async () => {
    scanAs(STABLE, { pegged: true });
    const body = await run(STABLE);
    expect(body.risk).toBe("SAFE");
    expect(flagOf(body, /^Stablecoin — the issuer holds/)?.severity).toBe("info");
    expect(flagOf(body, /^Freeze authority active/)?.severity).toBe("info");
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("info");
    expect(body.flags.some((f) => f.severity === "critical" || f.severity === "warning")).toBe(false);
  });

  it("a registry tokenized stock with that structure and a healthy market is SAFE, as a stablecoin is: its issuer's powers are information", async () => {
    scanAs(STOCK, { pegged: true });
    const body = await run(STOCK);
    expect(body.risk).toBe("SAFE");
    expect(body.rugKind).toBeNull();
    expect(flagOf(body, /^Tokenized asset — the issuer can freeze/)?.severity).toBe("info");
    expect(flagOf(body, /^Freeze authority active/)?.severity).toBe("info");
    expect(flagOf(body, /^Permanent delegate/)?.severity).toBe("info");
    expect(body.flags.some((f) => f.severity === "critical")).toBe(false);
  });

  it("a stablecoin that moved 12 % in a day has lost its peg: critical, DANGER", async () => {
    scanAs(STABLE, { priceUsd: "1.0002" }); // the fixture's pair moved +12 % in 24 h
    const body = await run(STABLE);
    expect(body.risk).toBe("DANGER");
    expect(flagOf(body, /^Stablecoin price moved 12%/)?.severity).toBe("critical");
  });

  it("a stablecoin that has sat at $0.93 (no move in 24 h) is off its peg: a warning, CAUTION", async () => {
    scanAs(STABLE, { pegged: true, priceUsd: "0.9300" });
    const body = await run(STABLE);
    expect(body.risk).toBe("CAUTION");
    expect(flagOf(body, /^Stablecoin trades at \$0\.9300, 7% from its \$1 peg/)?.severity).toBe("warning");
  });

  it("a real market problem still shows: the stock with a drained pool is a confirmed RUG, with $500 of liquidity DANGER", async () => {
    scanAs(STOCK, { liq: 0, vol: 90_000 });
    const drained = await run(STOCK);
    expect(drained.risk).toBe("RUG");
    expect(drained.rugKind).toBe("confirmed");
    scanAs(STOCK, { liq: 500 });
    const thin = await run(STOCK);
    expect(thin.risk).toBe("DANGER");
    expect(flagOf(thin, /^Very low liquidity/)?.severity).toBe("critical");
  });
});

// ─── Liquid staking tokens through the whole scan: SAFE with their peg to SOL read ─────────────────────────────────────────────
describe("scan handler — a liquid staking token is judged on its market and its peg to SOL", () => {
  const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
  const COPY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const WSOL = "So11111111111111111111111111111111111111112";
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const ADDR = "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk";
  const day = 24 * 3600 * 1000;

  // The stake pool is the mint authority (and holds most of the supply): critical for a meme coin, by design for an LST.
  const poolMint = () => mintAccountResponse({ program: "spl-token", mintAuthority: ADDR, freezeAuthority: null });
  const poolOf = (mint: string, quote: { address: string; symbol: string }, liq: number, native: string) => ({
    pairAddress: `pool-${quote.symbol}-${liq}`, dexId: "raydium", baseToken: { address: mint, symbol: "JITOSOL", name: "Jito Staked SOL" }, quoteToken: { ...quote, name: quote.symbol },
    liquidity: { usd: liq }, volume: { h24: 900_000, h1: 40_000 }, priceChange: { m5: 0, h1: 0.1, h6: 0.2, h24: 0.4 }, txns: { m5: { buys: 15, sells: 12 } },
    priceUsd: "232.5", priceNative: native, marketCap: 60_000_000, fdv: 60_000_000, pairCreatedAt: Date.now() - 400 * day,
    info: { socials: [{ type: "twitter", url: "https://twitter.com/test" }], websites: [{ url: "https://test.com" }] },
  });

  function scanLst(mint: string, pairs: unknown[]) {
    setupGoodTokenMocks();
    mockHeliusGetMintAccount.mockResolvedValue(poolMint());
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const answer = (await goodMocks(url, ...rest)) as { ok: boolean; json: () => Promise<unknown> };
      if (url.includes("gopluslabs")) {
        const j = (await answer.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ result: { [mint]: Object.values(j.result)[0] } }) };
      }
      if (url.includes("dexscreener")) return { ok: true, json: () => Promise.resolve({ pairs }) };
      return answer;
    });
  }
  async function run(mint: string) {
    const res = createMockRes();
    await handler(createMockReq({ ca: mint }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; flags: Array<{ label: string; severity: string }> };
  }
  const flagOf = (b: { flags: Array<{ label: string; severity: string }> }, re: RegExp) => b.flags.find((f) => re.test(f.label));
  const solPool = (mint: string, ratio: string) => poolOf(mint, { address: WSOL, symbol: "SOL" }, 600_000, ratio);
  const usdcPool = (mint: string) => poolOf(mint, { address: USDC_MINT, symbol: "USDC" }, 5_000_000, "232.5");

  it("a registry LST with a SOL-quoted pool at 1.27 SOL is SAFE; the stake pool's authority is information", async () => {
    scanLst(JITOSOL, [usdcPool(JITOSOL), solPool(JITOSOL, "1.2700")]);
    const body = await run(JITOSOL);
    expect(body.risk).toBe("SAFE");
    expect(flagOf(body, /^Liquid staking token — the stake pool holds/)?.severity).toBe("info");
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("info");
    expect(body.flags.some((f) => f.severity === "critical" || f.severity === "warning")).toBe(false);
  });

  it("the same LST at 0.85 SOL has lost its peg: critical, DANGER", async () => {
    scanLst(JITOSOL, [usdcPool(JITOSOL), solPool(JITOSOL, "0.8500")]);
    const body = await run(JITOSOL);
    expect(body.risk).toBe("DANGER");
    expect(flagOf(body, /^Liquid staking token trades at 0\.8500 SOL/)?.severity).toBe("critical");
  });

  it("an LST quoted only in USDC: its peg to SOL is not verified, CAUTION with a warning that says so (not RUG for its structure)", async () => {
    scanLst(JITOSOL, [usdcPool(JITOSOL)]);
    const body = await run(JITOSOL);
    expect(body.risk).toBe("CAUTION");
    expect(flagOf(body, /^Liquid staking token — its price in SOL could not be read/)?.severity).toBe("warning");
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("info");
  });

  it("witness: the same pools and structure on a token that is not in the registry are read as any token's (authority critical, not SAFE)", async () => {
    scanLst(COPY, [usdcPool(COPY), solPool(COPY, "1.2700")]);
    const body = await run(COPY);
    expect(["DANGER", "RUG"]).toContain(body.risk);
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("critical");
  });
});

// ─── Wrapped major assets through the whole scan ──────────────────────────────────────────────────────────────────────────────────
describe("scan handler — a wrapped major is judged on its market, a token CALLED BTC is not", () => {
  const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
  const FAKE_BTC = "BTCqQb9ZHEJ5yTrnARGsCjqpGDo1JhKohsEn637GUT1g"; // a look-alike of the corpus: same name, same structure, not the asset
  const ADDR = "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk";

  function scanBtc(mint: string) {
    setupGoodTokenMocks();
    // the bridge: both authorities active
    mockHeliusGetMintAccount.mockResolvedValue(mintAccountResponse({ mintAuthority: ADDR, freezeAuthority: ADDR }));
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const answer = (await goodMocks(url, ...rest)) as { ok: boolean; json: () => Promise<unknown> };
      if (url.includes("gopluslabs")) {
        const j = (await answer.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ result: { [mint]: Object.values(j.result)[0] } }) };
      }
      if (url.includes("dexscreener")) {
        const j = (await answer.json()) as { pairs: Array<Record<string, unknown> & { baseToken: { address: string } }> };
        return { ok: true, json: () => Promise.resolve({ pairs: j.pairs.map((p) => ({ ...p, baseToken: { ...p.baseToken, address: mint, symbol: "BTC", name: "Wrapped BTC" } })) }) };
      }
      return answer;
    });
  }
  async function run(mint: string) {
    const res = createMockRes();
    await handler(createMockReq({ ca: mint }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; flags: Array<{ label: string; severity: string }> };
  }
  const flagOf = (b: { flags: Array<{ label: string; severity: string }> }, re: RegExp) => b.flags.find((f) => re.test(f.label));

  it("cbBTC with the bridge's authorities and a healthy market is SAFE; its authorities are information", async () => {
    scanBtc(CBBTC);
    const body = await run(CBBTC);
    expect(body.risk).toBe("SAFE");
    expect(flagOf(body, /^Wrapped asset — the bridge or the custodian/)?.severity).toBe("info");
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("info");
    expect(flagOf(body, /^Freeze authority active/)?.severity).toBe("info");
    expect(body.flags.some((f) => f.severity === "critical" || f.severity === "warning")).toBe(false);
  });

  it("witness: a token CALLED Wrapped BTC with the same structure and market, not at the address of a wrapped asset, is read as any token's: authorities critical, not SAFE", async () => {
    scanBtc(FAKE_BTC);
    const body = await run(FAKE_BTC);
    expect(["DANGER", "RUG"]).toContain(body.risk);
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("critical");
    expect(flagOf(body, /^Wrapped asset/)).toBeUndefined();
  });
});

// ─── Yield-bearing dollar tokens and Jupiter's vault shares through the whole scan ────────────────────────────────────────────────
describe("scan handler — a yield-bearing token and a Jupiter vault share are judged on their market, a look-alike is not", () => {
  const USDY = "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"; // Ondo US Dollar Yield
  const JL_USDC = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D"; // Jupiter Lend USDC receipt
  const COPY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"; // same name and structure, not in the registry
  const ADDR = "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk";

  function scanWith(mint: string, over: { liq: number; vol: number; price: string }) {
    setupGoodTokenMocks();
    // the issuer / the protocol: both authorities active
    mockHeliusGetMintAccount.mockResolvedValue(mintAccountResponse({ mintAuthority: ADDR, freezeAuthority: ADDR }));
    const goodMocks = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const answer = (await goodMocks(url, ...rest)) as { ok: boolean; json: () => Promise<unknown> };
      if (url.includes("gopluslabs")) {
        const j = (await answer.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ result: { [mint]: Object.values(j.result)[0] } }) };
      }
      if (url.includes("dexscreener")) {
        const j = (await answer.json()) as { pairs: Array<Record<string, unknown> & { baseToken: { address: string }; volume: Record<string, number> }> };
        return { ok: true, json: () => Promise.resolve({ pairs: j.pairs.map((p) => ({
          ...p, baseToken: { ...p.baseToken, address: mint },
          liquidity: { usd: over.liq }, volume: { ...p.volume, h24: over.vol },
          priceChange: { m5: 0, h1: 0.05, h6: 0.1, h24: 0.2 }, priceUsd: over.price,
        })) }) };
      }
      return answer;
    });
  }
  async function run(mint: string) {
    const res = createMockRes();
    await handler(createMockReq({ ca: mint }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; flags: Array<{ label: string; severity: string }> };
  }
  const flagOf = (b: { flags: Array<{ label: string; severity: string }> }, re: RegExp) => b.flags.find((f) => re.test(f.label));
  const noRedFlags = (b: { flags: Array<{ severity: string }> }) => !b.flags.some((f) => f.severity === "critical" || f.severity === "warning");

  it("USDY at $1.15 with the issuer's authorities and a deep pool is SAFE; its authorities are information", async () => {
    scanWith(USDY, { liq: 1_700_000, vol: 400_000, price: "1.1516" });
    const body = await run(USDY);
    expect(body.risk).toBe("SAFE");
    expect(flagOf(body, /^Yield-bearing token — the issuer holds/)?.severity).toBe("info");
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("info");
    expect(flagOf(body, /^Freeze authority active/)?.severity).toBe("info");
    expect(noRedFlags(body)).toBe(true);
  });

  it("the same USDY under $1 (0.93) has lost value: not SAFE, and the flag says it", async () => {
    scanWith(USDY, { liq: 1_700_000, vol: 400_000, price: "0.93" });
    const body = await run(USDY);
    expect(body.risk).toBe("CAUTION");
    expect(flagOf(body, /^Yield-bearing token trades at \$0\.9300, 7% under \$1/)?.severity).toBe("warning");
  });

  it("a yield-bearing token with a $47 pool is DANGER (it is sold in a pool)", async () => {
    scanWith(USDY, { liq: 47, vol: 3, price: "1.1516" });
    const body = await run(USDY);
    expect(["DANGER", "RUG"]).toContain(body.risk);
    expect(flagOf(body, /^Very low liquidity/)?.severity).toBe("critical");
  });

  it("jlUSDC, a Jupiter Lend receipt, with pools that hold $47 and authorities held by the protocol, is SAFE: the thin pool is information", async () => {
    scanWith(JL_USDC, { liq: 47, vol: 3, price: "1.064" });
    const body = await run(JL_USDC);
    expect(body.risk).toBe("SAFE");
    expect(flagOf(body, /^Vault token — the protocol mints a share/)?.severity).toBe("info");
    expect(flagOf(body, /^Very low liquidity/)?.severity).toBe("info");
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("info");
    expect(noRedFlags(body)).toBe(true);
  });

  it("witness: a token with the same name, structure and $47 pool, not at a registry address, is read as any token's: DANGER or RUG", async () => {
    scanWith(COPY, { liq: 47, vol: 3, price: "1.064" });
    const body = await run(COPY);
    expect(["DANGER", "RUG"]).toContain(body.risk);
    expect(flagOf(body, /^Very low liquidity/)?.severity).toBe("critical");
    expect(flagOf(body, /^Mint authority active/)?.severity).toBe("critical");
    expect(flagOf(body, /^Vault token|^Yield-bearing token/)).toBeUndefined();
  });
});

// ─── Solscan: the age of the token and nothing else (SOLSCAN_AGE_AND_HOLDERS_ONLY) ────────────────────────────────────────────────────────────
describe("scan handler — Solscan is read for the age of the token only", () => {
  const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const DAY = 24 * 3600 * 1000;

  /** `solscan`: how old Solscan says the token is, or null when it answers nothing at all (as when it refused the key). */
  function scanWith(o: { poolAgeDays: number; solscan: { ageDays: number } | null }) {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const answer = (await good(url, ...rest)) as { ok: boolean; json: () => Promise<unknown> };
      if (url.includes("gopluslabs")) {
        const j = (await answer.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ result: { [MINT]: Object.values(j.result)[0] } }) };
      }
      if (url.includes("dexscreener")) {
        const j = (await answer.json()) as { pairs: Array<Record<string, unknown> & { baseToken: { address: string } }> };
        return { ok: true, json: () => Promise.resolve({ pairs: j.pairs.map((p) => ({ ...p, baseToken: { ...p.baseToken, address: MINT }, pairCreatedAt: Date.now() - o.poolAgeDays * DAY })) }) };
      }
      return answer;
    });
    mockFetchSolscan.mockImplementation((endpoint: string) => {
      if (o.solscan === null) return Promise.resolve(null);
      if (endpoint.includes("/token/meta")) {
        return Promise.resolve({ data: { created_time: Math.floor((Date.now() - o.solscan.ageDays * DAY) / 1000), icon: "https://img.test.com/icon.png", creator: "creator123", decimals: 9, supply: 100000 } });
      }
      // What Solscan would say if it were read: trades with no trader at all (a critical wash-trading flag), a pile of transfers.
      if (endpoint.includes("/token/markets")) return Promise.resolve({ data: [{ liquidity: 400000, volume: 900000, trade: 900, trader: 0 }] });
      return Promise.resolve({ data: [{ trans_id: "t1", from_address: "a", to_address: "b", amount: 1, block_time: Math.floor(Date.now() / 1000) }] });
    });
    mockFetchSolscan.mockClear();
  }
  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; score: number; flags: Array<{ label: string; severity: string }>; sources_used?: string[] };
  }
  const has = (b: { flags: Array<{ label: string }> }, re: RegExp) => b.flags.some((f) => re.test(f.label));

  it("one call: token/meta. The transfers and the markets are not asked for", async () => {
    scanWith({ poolAgeDays: 5, solscan: { ageDays: 300 } });
    await run();
    const endpoints = mockFetchSolscan.mock.calls.map((c) => String(c[0]));
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]).toMatch(/^\/token\/meta\?address=/);
  });

  it("the age is Solscan's when it is older than the pool's: a token whose pool is 5 days old and whose mint is 300 days old is established", async () => {
    scanWith({ poolAgeDays: 5, solscan: { ageDays: 300 } });
    const withSolscan = await run();
    expect(has(withSolscan, /^Established token \(30d\+\)/)).toBe(true);
    scanWith({ poolAgeDays: 5, solscan: null });
    const without = await run();
    expect(has(without, /^Established token \(30d\+\)/)).toBe(false);
  });

  it("nothing else of what Solscan says reaches the verdict: no wash-trading flag, no age conflict, no source, no creator lookup", async () => {
    scanWith({ poolAgeDays: 5, solscan: { ageDays: 300 } });
    const body = await run();
    expect(has(body, /wash trading/i)).toBe(false);
    expect(has(body, /age conflict/i)).toBe(false);
    expect(body.sources_used ?? []).not.toContain("solscan");
    expect(mockHeliusGetCreatorReputation).not.toHaveBeenCalled();
  });

  it("when the ages agree, the answer is the same with Solscan as without it (the rest of what it says changes nothing)", async () => {
    scanWith({ poolAgeDays: 5, solscan: { ageDays: 5 } });
    const withSolscan = await run();
    scanWith({ poolAgeDays: 5, solscan: null });
    const without = await run();
    expect(withSolscan.risk).toBe(without.risk);
    expect(withSolscan.score).toBe(without.score);
    expect(withSolscan.flags.map((f) => `${f.severity}:${f.label}`).sort()).toEqual(without.flags.map((f) => `${f.severity}:${f.label}`).sort());
  });

  it("a mint time that is far from the pool's (the token was minted weeks before its pool) is no 'age conflict' and costs no trust", async () => {
    scanWith({ poolAgeDays: 20, solscan: { ageDays: 25 } }); // 5 days apart: over the 72 h of the old cross-check
    const apart = await run();
    scanWith({ poolAgeDays: 20, solscan: { ageDays: 20 } });
    const together = await run();
    expect(has(apart, /age conflict/i)).toBe(false);
    expect(apart.score).toBe(together.score);
  });
});

// ─── The first three months of an LP that is not burned or locked, through the whole scan ─────────────────────────────────────────
describe("scan handler — an LP that is not burned or locked, by the age of the token", () => {
  const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const DAY = 24 * 3600 * 1000;

  function scanAged(ageDays: number) {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const answer = (await good(url, ...rest)) as { ok: boolean; json: () => Promise<unknown> };
      if (url.includes("gopluslabs")) {
        const j = (await answer.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ result: { [MINT]: Object.values(j.result)[0] } }) };
      }
      if (url.includes("dexscreener")) {
        const j = (await answer.json()) as { pairs: Array<Record<string, unknown> & { baseToken: { address: string } }> };
        return { ok: true, json: () => Promise.resolve({ pairs: j.pairs.map((p) => ({ ...p, baseToken: { ...p.baseToken, address: MINT }, pairCreatedAt: Date.now() - ageDays * DAY })) }) };
      }
      // RugCheck says the LP is neither burned nor locked (the good-token mock says it is burned)
      if (url.includes("rugcheck") && url.includes("summary")) {
        return { ok: true, json: () => Promise.resolve({ lpBurned: false, lpLocked: false, metaMutable: false, topHolders: { top10Percentage: 25, top1Percentage: 5 }, risks: [] }) };
      }
      return answer;
    });
    // The engine takes the OLDEST age among its sources (Solscan's mint time, DexScreener's pool): the good-token Solscan mock says 90 days,
    // which would make every token here old. Solscan must agree on the age, as it does in production now that its plan is back.
    const solscanGood = mockFetchSolscan.getMockImplementation() as (endpoint: string) => Promise<unknown>;
    mockFetchSolscan.mockImplementation((endpoint: string) =>
      endpoint.includes("meta")
        ? Promise.resolve({ data: { created_time: Math.floor((Date.now() - ageDays * DAY) / 1000), icon: "https://img.test.com/icon.png", creator: "creator123", decimals: 9, supply: 100000 } })
        : solscanGood(endpoint));
  }
  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as { risk: string; flags: Array<{ label: string; severity: string }> };
  }
  const lpFlag = (b: { flags: Array<{ label: string; severity: string }> }) => b.flags.find((f) => /^LP /.test(f.label));

  it("10 days old: the LP flag is critical and the verdict is DANGER", async () => {
    scanAged(10);
    const body = await run();
    expect(lpFlag(body)).toMatchObject({ severity: "critical", label: "LP not burned or locked — token under 30 days old, dev can rug liquidity" });
    expect(body.risk).toBe("DANGER");
  });

  it("45 days old: no 'under 30 days' flag any more, a warning at most, the verdict is not DANGER because of the LP", async () => {
    scanAged(45);
    const body = await run();
    expect(body.flags.some((f) => /under 30 days old/.test(f.label))).toBe(false);
    expect(lpFlag(body)?.severity).not.toBe("critical");
    expect(body.risk).not.toBe("SAFE");
  });

  it("120 days old: nothing about the first month, and the LP is not a critical", async () => {
    scanAged(120);
    const body = await run();
    expect(body.flags.some((f) => /under 30 days old/.test(f.label))).toBe(false);
    expect(lpFlag(body)?.severity).not.toBe("critical");
  });
});

// ─── GoPlus' answer is reused for an established token (the free tier is about 30 calls a minute) ──────────────────────────────────
describe("scan handler — GoPlus' answer is kept for an established token, not for a young one", () => {
  const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const goplusCalls = () => mockFetch.mock.calls.filter((c) => String(c[0]).includes("gopluslabs") && String(c[0]).includes("token_security")).length;

  // A tiny Redis with what the GoPlus cache and the rest of the scan use.
  function fakeRedis() {
    const store = new Map<string, unknown>();
    return { get: vi.fn(async (k: string) => store.get(k) ?? null), set: vi.fn((k: string, v: unknown) => { store.set(k, v); return Promise.resolve("OK"); }), setex: vi.fn() };
  }

  function scanSetup(pairAgeMs: number) {
    setupGoodTokenMocks();
    const good = mockFetch.getMockImplementation() as (url: string, ...rest: unknown[]) => Promise<unknown>;
    mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
      const answer = (await good(url, ...rest)) as { ok: boolean; json: () => Promise<unknown> };
      if (url.includes("gopluslabs")) {
        const j = (await answer.json()) as { result: Record<string, unknown> };
        return { ok: true, json: () => Promise.resolve({ code: 1, result: { [MINT]: Object.values(j.result)[0] } }) };
      }
      if (url.includes("dexscreener")) {
        const j = (await answer.json()) as { pairs: Array<Record<string, unknown> & { baseToken: { address: string } }> };
        return { ok: true, json: () => Promise.resolve({ pairs: j.pairs.map((p) => ({ ...p, baseToken: { ...p.baseToken, address: MINT }, pairCreatedAt: Date.now() - pairAgeMs })) }) };
      }
      return answer;
    });
    mockFetchSolscan.mockResolvedValue(null); // the age is the pool's
    mockFetch.mockClear();
  }
  async function run() {
    const res = createMockRes();
    await handler(createMockReq({ ca: MINT }), res);
    return (res.json as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as { risk: string };
  }
  // The cache module is mocked at the top of this file: give it a Redis for the test, and put the default one back after.
  async function useRedis(redis: unknown) {
    const { getCacheRedis } = await import("../api/_lib/cache");
    (getCacheRedis as unknown as ReturnType<typeof vi.fn>).mockReturnValue(redis);
  }
  afterEach(async () => { await useRedis({ setex: mockSetex }); });

  it("a token of 90 days: GoPlus is asked by the first scan and not by the second", async () => {
    await useRedis(fakeRedis());
    scanSetup(90 * 24 * 3600 * 1000);
    await run();
    expect(goplusCalls()).toBe(1);
    await run();
    expect(goplusCalls()).toBe(1);
  });

  it("a token of 10 minutes: GoPlus is asked by every scan", async () => {
    await useRedis(fakeRedis());
    scanSetup(10 * 60 * 1000);
    await run();
    await run();
    expect(goplusCalls()).toBe(2);
  });

  it("without Redis, every scan asks GoPlus, as before", async () => {
    await useRedis(null);
    scanSetup(90 * 24 * 3600 * 1000);
    await run();
    await run();
    expect(goplusCalls()).toBe(2);
  });

  it("the verdict is the same with the answer from the cache as with the answer from GoPlus", async () => {
    await useRedis(fakeRedis());
    scanSetup(90 * 24 * 3600 * 1000);
    const first = await run();
    const second = await run();
    expect(second.risk).toBe(first.risk);
  });
});

