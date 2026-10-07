import { vi, describe, it, expect, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
const mockFetchSolscan = vi.fn();
const mockFetchDexCandles = vi.fn();
const mockHeliusResolveAccountOwners = vi.fn();
const mockPublicRpcGetTokenSupply = vi.fn();
const mockPublicRpcGetMintInfo = vi.fn();

vi.mock("../api/_lib/fetchers", () => ({
  heliusGetLargestAccounts: (...args: unknown[]) => mockHeliusGetLargestAccounts(...args),
  heliusGetTokenSupply: (...args: unknown[]) => mockHeliusGetTokenSupply(...args),
  heliusGetCreatorReputation: (...args: unknown[]) => mockHeliusGetCreatorReputation(...args),
  heliusGetHoldersCount: (...args: unknown[]) => mockHeliusGetHoldersCount(...args),
  heliusGetProgramAccountHolderCount: (...args: unknown[]) => mockHeliusGetProgramAccountHolderCount(...args),
  fetchSolscan: (...args: unknown[]) => mockFetchSolscan(...args),
  fetchDexCandles: (...args: unknown[]) => mockFetchDexCandles(...args),
  fetchDexCandlesDaily: vi.fn().mockResolvedValue([]), // no daily candles in unit tests
  heliusResolveAccountOwners: (...args: unknown[]) => mockHeliusResolveAccountOwners(...args),
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
    // RugCheck: the summary in the shape the API really sends (a token it found
    // nothing on, LP 99.5% locked or burned). The full /report is not requested
    // any more, so it has no mock: a test below checks that it stays that way.
    if (url.includes("rugcheck") && url.includes("report/summary")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          tokenType: "",
          risks: [],
          score: 1,
          score_normalised: 1,
          lpLockedPct: 99.5,
        }),
      });
    }
    if (url.includes("gopluslabs")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          result: {
            // The shape GoPlus really sends for Solana: nothing held, nothing
            // special on the token. (Holders and supply come from the Helius mocks.)
            So11111111111111111111111111111111111111112: {
              mintable: { authority: [], status: "0" },
              freezable: { authority: [], status: "0" },
              balance_mutable_authority: { authority: [], status: "0" },
              default_account_state: "1",
              non_transferable: "0",
              transfer_fee: {},
              transfer_hook: [],
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
  mockHeliusGetHoldersCount.mockResolvedValue(5000);
  mockHeliusGetProgramAccountHolderCount.mockResolvedValue(null);
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

  // A DexScreener profile (website, socials) says nothing about whether a token
  // can rug. "No website / Twitter / Telegram" used to be a critical flag, and
  // determineVerdict turns any critical flag into DANGER: the same clean token
  // scanned SAFE 1000 with a profile and DANGER 850 without one.
  it("scores a token the same with or without a DexScreener website and socials", async () => {
    async function scan(withProfile: boolean) {
      setupGoodTokenMocks();
      type Reply = { json: () => Promise<{ pairs: Array<Record<string, unknown>> }> };
      const base = mockFetch.getMockImplementation() as (...args: unknown[]) => Promise<Reply>;
      mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
        const r = await base(url, ...rest);
        if (!withProfile && url.includes("dexscreener")) {
          const j = await r.json();
          for (const p of j.pairs) delete p.info; // keep the pair, drop the profile
          return { ok: true, json: () => Promise.resolve(j) };
        }
        return r;
      });
      const res = createMockRes();
      await handler(createMockReq({ ca: "So11111111111111111111111111111111111111112", fresh: "1" }), res);
      return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        risk: string;
        score: number;
        flags: Array<{ label: string; severity: string }>;
      };
    }
    const noProfile = /^No website \/ Twitter \/ Telegram/;

    const withProfile = await scan(true);
    const without = await scan(false);

    expect(withProfile.flags.some((f) => noProfile.test(f.label))).toBe(false);
    expect(without.flags.find((f) => noProfile.test(f.label))?.severity).toBe("info");
    expect(without.flags.some((f) => f.severity === "critical")).toBe(false);
    expect(without.risk).not.toBe("DANGER");
    expect(without.risk).toBe(withProfile.risk);
    expect(without.score).toBe(withProfile.score);
  });

  describe("RugCheck", () => {
    // Real answers of api.rugcheck.xyz, captured and not edited.
    const here = dirname(fileURLToPath(import.meta.url));
    const rugCheckFixtures = JSON.parse(
      readFileSync(join(here, "fixtures", "rugcheck-summaries.json"), "utf8"),
    ) as { summaries: Record<string, { summary: unknown }> };

    type Reply = { json: () => Promise<unknown> };
    /** Answer RugCheck summary requests with this payload, everything else as before. */
    function rugCheckSays(summary: unknown) {
      const base = mockFetch.getMockImplementation() as (...args: unknown[]) => Promise<Reply>;
      mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
        if (url.includes("rugcheck") && url.includes("report/summary")) {
          return { ok: true, json: () => Promise.resolve(summary) };
        }
        return base(url, ...rest);
      });
    }
    function heliusDown() {
      mockHeliusGetLargestAccounts.mockResolvedValue(null);
    }
    async function scan() {
      const res = createMockRes();
      await handler(createMockReq({ ca: "So11111111111111111111111111111111111111112", fresh: "1" }), res);
      return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        risk: string;
        score: number;
        topHolderPct: number | null;
        flags: Array<{ label: string; severity: string }>;
        sources_used: string[];
      };
    }

    it("asks for the summary only, never for the full report (up to 2.5 MB, thrown away by the validator)", async () => {
      setupGoodTokenMocks();
      await scan();

      const rugCheckUrls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("rugcheck"));
      expect(rugCheckUrls.length).toBeGreaterThan(0);
      expect(rugCheckUrls.every((u) => u.endsWith("/report/summary"))).toBe(true);
    });

    it("with Helius down, RugCheck says one wallet holds 44%: DANGER, where it was capped at CAUTION", async () => {
      setupGoodTokenMocks();
      heliusDown();
      rugCheckSays(rugCheckFixtures.summaries.HAWK.summary);

      const body = await scan();

      expect(body.risk).toBe("DANGER");
      const flag = body.flags.find((f) => /single wallet holds 44%/i.test(f.label));
      expect(flag?.severity).toBe("critical");
      expect(body.topHolderPct).toBeCloseTo(43.98, 2);
    });

    it("with Helius down and nothing raised by RugCheck, the holders stay unverified: CAUTION, never SAFE", async () => {
      setupGoodTokenMocks();
      heliusDown();
      rugCheckSays(rugCheckFixtures.summaries.WIF.summary);

      const body = await scan();

      expect(body.risk).toBe("CAUTION");
      expect(body.flags.some((f) => f.severity === "critical")).toBe(false);
      expect(body.topHolderPct).toBeNull();
    });

    it("with Helius up, RugCheck's concentration is not added on top of the engine's own reading", async () => {
      setupGoodTokenMocks();
      rugCheckSays(rugCheckFixtures.summaries.HAWK.summary);

      const body = await scan();

      expect(body.flags.some((f) => /(RugCheck)/.test(f.label) && /wallet holds|top 10/i.test(f.label))).toBe(false);
    });

    it("a creator RugCheck knows to have rugged before makes the token DANGER", async () => {
      setupGoodTokenMocks();
      rugCheckSays(rugCheckFixtures.summaries.CREATOR_RUGGED.summary);

      const body = await scan();

      expect(body.risk).toBe("DANGER");
      expect(body.flags.find((f) => /creator history of rugged tokens/i.test(f.label))?.severity).toBe("critical");
    });

    it("an error answer from RugCheck is no data: the source is left out, not counted as clean", async () => {
      setupGoodTokenMocks();
      rugCheckSays({ error: "unable to generate report" });

      const body = await scan();

      expect(body.sources_used).not.toContain("rugcheck");
    });
  });

  describe("holders from GoPlus", () => {
    // Real GoPlus answers for Solana (see __tests__/fixtures/goplus-solana.json).
    const here = dirname(fileURLToPath(import.meta.url));
    const goplusFixtures = JSON.parse(
      readFileSync(join(here, "fixtures", "goplus-solana.json"), "utf8"),
    ) as { tokens: Record<string, { result: unknown }> };
    const WSOL = "So11111111111111111111111111111111111111112";

    type Reply = { json: () => Promise<unknown> };
    /** Answer GoPlus requests with this token result (keyed by the scanned mint), everything else as before. */
    function goplusSays(result: unknown) {
      const base = mockFetch.getMockImplementation() as (...args: unknown[]) => Promise<Reply>;
      mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
        if (url.includes("gopluslabs")) {
          return { ok: true, json: () => Promise.resolve({ code: 1, result: { [WSOL]: result } }) };
        }
        return base(url, ...rest);
      });
    }
    /** Helius down: no holder list, no supply, no holder count. */
    function heliusDown() {
      mockHeliusGetLargestAccounts.mockResolvedValue(null);
      mockHeliusGetTokenSupply.mockResolvedValue(null);
      mockHeliusGetHoldersCount.mockResolvedValue(null);
    }
    async function scan() {
      const res = createMockRes();
      await handler(createMockReq({ ca: WSOL, fresh: "1" }), res);
      return (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        risk: string;
        topHolderPct: number | null;
        holdersSource: string | null;
        flags: Array<{ label: string; severity: string }>;
      };
    }

    it("with Helius down, GoPlus's holder list gives the concentration: HAWK is DANGER and the source says so", async () => {
      setupGoodTokenMocks();
      heliusDown();
      goplusSays(goplusFixtures.tokens.HAWK.result);

      const body = await scan();

      expect(body.holdersSource).toBe("goplus");
      expect(body.flags.find((f) => /single wallet holds 44%/i.test(f.label))?.severity).toBe("critical");
      expect(body.risk).toBe("DANGER");
      expect(body.topHolderPct).toBeCloseTo(43.98, 1);
    });

    it("with Helius up, the list is Helius's and GoPlus's is not used", async () => {
      setupGoodTokenMocks();
      goplusSays(goplusFixtures.tokens.HAWK.result);

      const body = await scan();

      expect(body.holdersSource).toBe("helius");
      expect(body.flags.some((f) => /single wallet holds 44%/i.test(f.label))).toBe(false);
    });

    it("a GoPlus list that cannot be right (balances ten times the supply) is dropped: holders stay unverified", async () => {
      setupGoodTokenMocks();
      heliusDown();
      goplusSays(goplusFixtures.tokens.NFLXX.result);

      const body = await scan();

      expect(body.holdersSource).toBeNull();
      expect(body.risk).not.toBe("SAFE");
      expect(body.topHolderPct).toBeNull();
    });

    it("takes the supply from GoPlus before asking a public RPC", async () => {
      setupGoodTokenMocks();
      heliusDown();
      goplusSays(goplusFixtures.tokens.HAWK.result);

      await scan();

      expect(mockPublicRpcGetTokenSupply).not.toHaveBeenCalled();
    });

    it("the holder count GoPlus reports reaches the holder-count flags: a 2-holder token is flagged", async () => {
      setupGoodTokenMocks();
      mockHeliusGetHoldersCount.mockResolvedValue(null);
      goplusSays(goplusFixtures.tokens.BEAR.result);

      const body = await scan();

      expect(body.flags.find((f) => /very few holders/i.test(f.label))?.severity).toBe("critical");
    });

    // Authorities still held (mint, freeze, permanent delegate...). The engine read none of
    // them before: its GoPlus layer looked for EVM fields. 118 of the 505 corpus tokens hold
    // a mint authority, almost all legitimate issuer- or DAO-run assets.
    describe("authorities", () => {
      const authorityFlag = (flags: Array<{ label: string; severity: string }>) =>
        flags.find((f) => /^Authorities still active/.test(f.label));

      type Indicators = { mintAuthority?: boolean | null; freezeAuthority?: boolean | null; honeypot?: boolean | null };
      /** Scan, and return the indicators the clients show next to what the AI summary was told. */
      async function indicators() {
        const res = createMockRes();
        await handler(createMockReq({ ca: WSOL, fresh: "1" }), res);
        const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0] as Indicators;
        const { generateAISummary } = await import("../api/_lib/ai-summary");
        const told = vi.mocked(generateAISummary).mock.calls[0][0] as Indicators;
        const pick = (r: Indicators) => ({ mintAuthority: r.mintAuthority, freezeAuthority: r.freezeAuthority, honeypot: r.honeypot });
        return { shown: pick(body), told: pick(told) };
      }
      function goplusDown() {
        const base = mockFetch.getMockImplementation() as (...args: unknown[]) => Promise<Reply>;
        mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
          if (url.includes("gopluslabs")) return { ok: false, json: () => Promise.resolve(null) };
          return base(url, ...rest);
        });
      }

      /** A token created 3 days ago: DexScreener's pair and Solscan's mint time agree. */
      function threeDaysOld() {
        const base = mockFetch.getMockImplementation() as (...args: unknown[]) => Promise<Reply>;
        mockFetch.mockImplementation(async (url: string, ...rest: unknown[]) => {
          const r = await base(url, ...rest);
          if (url.includes("dexscreener")) {
            const j = (await r.json()) as { pairs: Array<Record<string, unknown>> };
            for (const p of j.pairs) p.pairCreatedAt = Date.now() - 3 * 24 * 3600 * 1000;
            return { ok: true, json: () => Promise.resolve(j) };
          }
          return r;
        });
        const prior = mockFetchSolscan.getMockImplementation() as (endpoint: string) => Promise<unknown>;
        mockFetchSolscan.mockImplementation((endpoint: string) => {
          if (endpoint.includes("meta")) {
            return Promise.resolve({ data: { created_time: Math.floor(Date.now() / 1000) - 3 * 24 * 3600, icon: "https://img.test.com/icon.png", creator: "creator123", decimals: 9, supply: 100000 } });
          }
          return prior(endpoint);
        });
      }

      it("an established issuer-run asset (USDG): the API says so, as information, and nothing is held against it", async () => {
        setupGoodTokenMocks();
        goplusSays(goplusFixtures.tokens.USDG.result);

        const body = await scan();

        expect(authorityFlag(body.flags)).toMatchObject({
          severity: "info",
          label: "Authorities still active (established asset): mint, freeze, permanent delegate, transfer fee, transfer hook",
        });
        expect(body.flags.some((f) => f.severity === "warning" && /authorit/i.test(f.label))).toBe(false);
      });

      it("the same asset 3 days old: one warning, never SAFE", async () => {
        setupGoodTokenMocks();
        threeDaysOld();
        goplusSays(goplusFixtures.tokens.USDG.result);

        const body = await scan();

        expect(authorityFlag(body.flags)).toMatchObject({
          severity: "warning",
          label: "Authorities still active: mint, freeze, permanent delegate, transfer fee, transfer hook",
        });
        expect(body.flags.filter((f) => /^Authorities still active/.test(f.label))).toHaveLength(1);
        expect(body.risk).not.toBe("SAFE");
      });

      // The Mint and Freeze marks the overlay and the token page draw, and what the
      // AI summary is told, came from flag labels no layer produced: every token
      // showed both as revoked, and the summary said so.
      it("shows a held mint and freeze authority as held, to the clients and to the AI summary alike (USDG)", async () => {
        setupGoodTokenMocks();
        goplusSays(goplusFixtures.tokens.USDG.result);

        const { shown, told } = await indicators();

        expect(shown).toEqual({ mintAuthority: true, freezeAuthority: true, honeypot: false });
        expect(told).toEqual(shown);
      });

      it("shows revoked authorities as revoked (HAWK)", async () => {
        setupGoodTokenMocks();
        goplusSays(goplusFixtures.tokens.HAWK.result);

        const { shown, told } = await indicators();

        expect(shown).toEqual({ mintAuthority: false, freezeAuthority: false, honeypot: false });
        expect(told).toEqual(shown);
      });

      it("a mint authority alone does not light the freeze mark (ORCA)", async () => {
        setupGoodTokenMocks();
        goplusSays(goplusFixtures.tokens.ORCA.result);

        const { shown } = await indicators();

        expect(shown).toMatchObject({ mintAuthority: true, freezeAuthority: false });
      });

      it("with GoPlus down, nothing is claimed: null for Mint, Freeze and Sell, to the clients and the summary", async () => {
        setupGoodTokenMocks();
        goplusDown();

        const { shown, told } = await indicators();

        expect(shown).toEqual({ mintAuthority: null, freezeAuthority: null, honeypot: null });
        expect(told).toEqual(shown);
      });

      it("a soulbound token (cannot be sold) shows as a honeypot", async () => {
        setupGoodTokenMocks();
        goplusSays({ ...(goplusFixtures.tokens.HAWK.result as object), non_transferable: "1" });

        const { shown } = await indicators();

        expect(shown.honeypot).toBe(true);
      });

      it("a token with every authority revoked has no such flag", async () => {
        setupGoodTokenMocks();
        threeDaysOld();
        goplusSays(goplusFixtures.tokens.HAWK.result);

        const body = await scan();

        expect(authorityFlag(body.flags)).toBeUndefined();
      });
    });

    it("does not call the public Solscan holders endpoint any more (it answers 404)", async () => {
      setupGoodTokenMocks();
      await scan();

      const urls = mockFetch.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("public-api.solscan.io"))).toBe(false);
    });
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
    mockFetchSolscan.mockResolvedValue(null);
    mockFetchDexCandles.mockResolvedValue([]);
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
