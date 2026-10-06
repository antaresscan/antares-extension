import { describe, it, expect, vi } from "vitest";
import {
  asNumber, _mean, _std, _pct, makeFlag, computeCacheTTL,
  apiError, isCorsAllowed, isOriginInList, isValidDexScreenerResponse, isValidRugCheckSummary,
  isHeliusLargestAccountsResponse, isHeliusSupplyResponse,
  isSolscanMarketsResponse, isSolscanMeta, isSolscanTransfersResponse,
  isRugCheckReport, withBudget, pickGoPlusResult,
} from "../api/_lib/helpers";
import { CA_RE } from "../api/_lib/constants";

describe("withBudget", () => {
  it("returns the promise value when it resolves within budget", async () => {
    const p = Promise.resolve("ok");
    expect(await withBudget(p, 1000)).toBe("ok");
  });

  it("returns null when the promise rejects", async () => {
    const p = Promise.reject(new Error("boom"));
    expect(await withBudget(p, 1000)).toBeNull();
  });

  it("returns null when the budget fires before the promise resolves", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
    const start = Date.now();
    const result = await withBudget(slow, 50);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(150);
  });
});

describe("asNumber", () => {
  it("returns number directly", () => {
    expect(asNumber(42)).toBe(42);
  });
  it("parses string float", () => {
    expect(asNumber("3.14")).toBeCloseTo(3.14);
  });
  it("returns 0 for undefined", () => {
    expect(asNumber(undefined)).toBe(0);
  });
  it("returns 0 for NaN", () => {
    expect(asNumber(NaN)).toBe(0);
  });
  it("returns 0 for non-numeric string", () => {
    expect(asNumber("abc")).toBe(0);
  });
});

describe("_mean", () => {
  it("returns 0 for empty array", () => {
    expect(_mean([])).toBe(0);
  });
  it("returns single element", () => {
    expect(_mean([10])).toBe(10);
  });
  it("calculates mean of array", () => {
    expect(_mean([2, 4, 6])).toBe(4);
  });
});

describe("_std", () => {
  it("returns 0 for constant array", () => {
    expect(_std([5, 5, 5])).toBe(0);
  });
});

describe("_pct", () => {
  it("returns 0 when from is 0 (division guard)", () => {
    expect(_pct(0, 100)).toBe(0);
  });
  it("calculates percentage change", () => {
    expect(_pct(100, 150)).toBe(50);
  });
});

describe("makeFlag", () => {
  it("creates flag object", () => {
    expect(makeFlag("test", "warning", 5)).toEqual({
      label: "test",
      severity: "warning",
      impact: 5,
    });
  });
});

describe("computeCacheTTL", () => {
  // ─── Age-based TTL (no verdict supplied) ──────────────────────────
  it("returns 60 for null age", () => {
    expect(computeCacheTTL(null)).toBe(60);
  });
  it("returns 45 for age < 60", () => {
    expect(computeCacheTTL(30)).toBe(45);
  });
  it("returns 120 for age 60-1440", () => {
    expect(computeCacheTTL(120)).toBe(120);
  });
  it("returns 300 for age > 1440", () => {
    expect(computeCacheTTL(2000)).toBe(300);
  });

  // ─── Verdict-aware TTL (PR #298) ──────────────────────────────────
  // Bad verdicts get a long TTL irrespective of age — stale-RUG is safe,
  // stale-SAFE is dangerous. This is the asymmetry that protects users
  // from buying tokens on stale "safe" verdicts after a rug event.
  describe("verdict-aware TTL", () => {
    it("RUG verdict caches 30 min regardless of token age", () => {
      expect(computeCacheTTL(5, "RUG")).toBe(1800);
      expect(computeCacheTTL(2000, "RUG")).toBe(1800);
      expect(computeCacheTTL(null, "RUG")).toBe(1800);
    });

    it("DANGER verdict caches 10 min regardless of token age", () => {
      expect(computeCacheTTL(5, "DANGER")).toBe(600);
      expect(computeCacheTTL(2000, "DANGER")).toBe(600);
      expect(computeCacheTTL(null, "DANGER")).toBe(600);
    });

    it("SAFE verdict on YOUNG token still gets short age-based TTL", () => {
      // Critical safety property: if the engine says SAFE on a 10-minute
      // token and the token rugs 30s later, we must not serve that stale
      // SAFE for 30 min. Age-based 20s applies.
      expect(computeCacheTTL(10, "SAFE")).toBe(20);
    });

    it("CAUTION verdict on YOUNG token still gets short age-based TTL", () => {
      expect(computeCacheTTL(10, "CAUTION")).toBe(20);
    });

    it("SAFE verdict on ESTABLISHED token gets long age-based TTL", () => {
      // Established + safe is the only case where a long TTL on a "good"
      // verdict is acceptable: state is empirically stable.
      expect(computeCacheTTL(20000, "SAFE")).toBe(600);
    });

    it("never returns less than 20s — protects upstream from thundering herd", () => {
      // Spot-check the floor on the lowest-bucket case.
      expect(computeCacheTTL(1, "SAFE")).toBeGreaterThanOrEqual(20);
      expect(computeCacheTTL(1, "CAUTION")).toBeGreaterThanOrEqual(20);
    });
  });
});

describe("apiError", () => {
  function mockRes() {
    const jsonFn = vi.fn();
    const statusFn = vi.fn(() => ({ json: jsonFn }));
    return { status: statusFn, json: jsonFn } as unknown as import("@vercel/node").VercelResponse;
  }

  it("returns correct status and error message", () => {
    const res = mockRes();
    apiError(res, 400, "Bad request");
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("includes details when provided", () => {
    const res = mockRes();
    apiError(res, 500, "Server error", { code: "INTERNAL" });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("omits details key when details is undefined", () => {
    const jsonFn = vi.fn();
    const statusFn = vi.fn(() => ({ json: jsonFn }));
    const res = { status: statusFn, json: jsonFn } as unknown as import("@vercel/node").VercelResponse;
    apiError(res, 404, "Not found");
    expect(jsonFn).toHaveBeenCalledWith({ error: "Not found" });
  });
});

describe("isCorsAllowed", () => {
  const origins = ["https://dexscreener.com", "https://birdeye.so"];

  it("allowed origin -> true", () => {
    expect(isCorsAllowed("https://dexscreener.com", origins)).toBe(true);
  });

  it("allowed origin with path -> true (startsWith)", () => {
    expect(isCorsAllowed("https://dexscreener.com/solana/abc", origins)).toBe(true);
  });

      it("chrome-extension://abc123 -> false (wildcard removed)", () => {
          expect(isCorsAllowed("chrome-extension://abc123", origins)).toBe(false);
  });

  it("evil.com -> false", () => {
    expect(isCorsAllowed("https://evil.com", origins)).toBe(false);
  });

  it("empty string -> false", () => {
    expect(isCorsAllowed("", origins)).toBe(false);
  });

      it("chrome-extension:// exactly -> false (wildcard removed)", () => {
          expect(isCorsAllowed("chrome-extension://", origins)).toBe(false);
  });

  it("dexscreener.org (different TLD) -> false", () => {
    expect(isCorsAllowed("https://dexscreener.org", origins)).toBe(false);
  });

  // Vercel preview hostnames for the antares-website project follow a
  // predictable pattern. We allow them so QA can hit the API from PR
  // previews without rotating the explicit allowlist for every PR.
  it("antares-website-git-<branch>-<team>.vercel.app -> true", () => {
    expect(
      isCorsAllowed(
        "https://antares-website-git-claude-da10fb-comealamaisongroupes-projects.vercel.app",
        origins,
      ),
    ).toBe(true);
  });

  it("antares-website-<deploy-hash>-<team>.vercel.app -> true", () => {
    expect(
      isCorsAllowed(
        "https://antares-website-abc123def-comealamaisongroupes-projects.vercel.app",
        origins,
      ),
    ).toBe(true);
  });

  it("antares-website.vercel.app exact (no preview suffix) -> false unless in allowlist", () => {
    // Production needs the explicit allowlist entry — preview pattern
    // requires a separator after `antares-website-`.
    expect(isCorsAllowed("https://antares-website.vercel.app", origins)).toBe(false);
  });

  it("rogue-project-deploy.vercel.app -> false (only antares-website previews)", () => {
    expect(
      isCorsAllowed(
        "https://malicious-project-git-abc-projects.vercel.app",
        origins,
      ),
    ).toBe(false);
  });

  it("antares-website.evil.app (TLD-shadowing attempt) -> false", () => {
    expect(isCorsAllowed("https://antares-website-x.evil.app", origins)).toBe(false);
  });

  // Origins are compared exactly (scheme + host + port). Matching on the
  // hostname alone let a downgraded http:// page, or another port, through.
  it("http:// variant of an allowed https origin -> false", () => {
    expect(isCorsAllowed("http://dexscreener.com", origins)).toBe(false);
  });

  it("allowed host on another port -> false", () => {
    expect(isCorsAllowed("https://dexscreener.com:8443", origins)).toBe(false);
  });

  it("opaque 'null' origin -> false", () => {
    expect(isCorsAllowed("null", origins)).toBe(false);
  });

  it("http:// preview-shaped origin -> false (previews are https only)", () => {
    expect(
      isCorsAllowed("http://antares-website-abc123-comealamaisongroupes-projects.vercel.app", origins),
    ).toBe(false);
  });
});

describe("isOriginInList", () => {
  const list = ["https://antaresscan.com", "https://www.antaresscan.com"];

  it("exact origin -> true", () => {
    expect(isOriginInList("https://antaresscan.com", list)).toBe(true);
    expect(isOriginInList("https://www.antaresscan.com", list)).toBe(true);
  });

  it("same host over http -> false", () => {
    expect(isOriginInList("http://antaresscan.com", list)).toBe(false);
  });

  it("same host on another port -> false", () => {
    expect(isOriginInList("https://antaresscan.com:8443", list)).toBe(false);
  });

  it("unlisted subdomain -> false", () => {
    expect(isOriginInList("https://evil.antaresscan.com", list)).toBe(false);
  });

  it("a preview-shaped *.vercel.app host is not an exact match -> false", () => {
    expect(isOriginInList("https://antares-website-x.vercel.app", list)).toBe(false);
  });

  it("opaque origins never match, even against an opaque list entry", () => {
    expect(isOriginInList("null", ["null"])).toBe(false);
    expect(isOriginInList("chrome-extension://abc", ["chrome-extension://abc"])).toBe(false);
  });

  it("empty or malformed input -> false", () => {
    expect(isOriginInList("", list)).toBe(false);
    expect(isOriginInList("not a url", list)).toBe(false);
  });
});

describe("isValidDexScreenerResponse", () => {
  it("{ pairs: [] } -> true (valid with empty pairs array)", () => {
    expect(isValidDexScreenerResponse({ pairs: [] })).toBe(true);
  });

  it("{ pairs: [{ pairAddress: 'abc' }] } -> true", () => {
    expect(isValidDexScreenerResponse({ pairs: [{ pairAddress: "abc" }] })).toBe(true);
  });

  it("{ pair: { pairAddress: 'abc' } } -> true (single pair)", () => {
    expect(isValidDexScreenerResponse({ pair: { pairAddress: "abc" } })).toBe(true);
  });

  it("null -> false", () => {
    expect(isValidDexScreenerResponse(null)).toBe(false);
  });

  it("string -> false", () => {
    expect(isValidDexScreenerResponse("string")).toBe(false);
  });

  it("42 -> false", () => {
    expect(isValidDexScreenerResponse(42)).toBe(false);
  });

  it("{} -> false (no pairs or pair key)", () => {
    expect(isValidDexScreenerResponse({})).toBe(false);
  });

  it("{ pairs: 'not-array' } -> false (pairs must be array)", () => {
    expect(isValidDexScreenerResponse({ pairs: "not-array" })).toBe(false);
  });
});

describe("isValidRugCheckSummary", () => {
  it("{ lpBurned: true } -> true", () => {
    expect(isValidRugCheckSummary({ lpBurned: true })).toBe(true);
  });

  it("{ risks: [] } -> true", () => {
    expect(isValidRugCheckSummary({ risks: [] })).toBe(true);
  });

  it("{ error: 'not found' } -> true", () => {
    expect(isValidRugCheckSummary({ error: "not found" })).toBe(true);
  });

  it("{ lpBurned: false, risks: [], mintAuthorityEnabled: true } -> true", () => {
    expect(isValidRugCheckSummary({ lpBurned: false, risks: [], mintAuthorityEnabled: true })).toBe(true);
  });

  it("null -> false", () => {
    expect(isValidRugCheckSummary(null)).toBe(false);
  });

  it("string -> false", () => {
    expect(isValidRugCheckSummary("string")).toBe(false);
  });

  it("{} -> false (no recognizable fields)", () => {
    expect(isValidRugCheckSummary({})).toBe(false);
  });

  it("{ randomField: true } -> false", () => {
    expect(isValidRugCheckSummary({ randomField: true })).toBe(false);
  });
});

// ─── Runtime Type Guards (Session 6) ─────────────────────────────────────────
describe("isHeliusLargestAccountsResponse", () => {
  it("accepts valid response", () => {
    expect(isHeliusLargestAccountsResponse({ result: { value: [] } })).toBe(true);
  });
  it("rejects null", () => {
    expect(isHeliusLargestAccountsResponse(null)).toBe(false);
  });
  it("rejects missing result", () => {
    expect(isHeliusLargestAccountsResponse({ foo: "bar" })).toBe(false);
  });
});

describe("isHeliusSupplyResponse", () => {
  it("accepts valid response", () => {
    expect(isHeliusSupplyResponse({ result: { value: { uiAmount: 1000 } } })).toBe(true);
  });
  it("rejects null", () => {
    expect(isHeliusSupplyResponse(null)).toBe(false);
  });
});

describe("isSolscanMarketsResponse", () => {
  it("accepts valid response", () => {
    expect(isSolscanMarketsResponse({ data: [] })).toBe(true);
  });
  it("rejects non-array data", () => {
    expect(isSolscanMarketsResponse({ data: "nope" })).toBe(false);
  });
});

describe("isSolscanMeta", () => {
  it("accepts valid meta", () => {
    expect(isSolscanMeta({ data: { created_time: 123 } })).toBe(true);
  });
  it("rejects non-object data", () => {
    expect(isSolscanMeta({ data: 42 })).toBe(false);
  });
});

describe("isSolscanTransfersResponse", () => {
  it("accepts valid response", () => {
    expect(isSolscanTransfersResponse({ data: [{ from: "a", to: "b" }] })).toBe(true);
  });
  it("rejects null", () => {
    expect(isSolscanTransfersResponse(null)).toBe(false);
  });
});

describe("isRugCheckReport", () => {
  it("accepts report with risks", () => {
    expect(isRugCheckReport({ risks: [] })).toBe(true);
  });
  it("accepts report with topHolders", () => {
    expect(isRugCheckReport({ topHolders: {} })).toBe(true);
  });
  it("rejects empty object", () => {
    expect(isRugCheckReport({})).toBe(false);
  });
});

describe("CA_RE consistency", () => {
  it("should match valid Solana addresses", () => {
    expect(CA_RE.test("So11111111111111111111111111111111111111112")).toBe(true);
    expect(CA_RE.test("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263")).toBe(true);
  });
  it("should reject invalid addresses", () => {
    expect(CA_RE.test("short")).toBe(false);
    expect(CA_RE.test("")).toBe(false);
    expect(CA_RE.test("invalid!@#$%^&*()characters1234567890ab")).toBe(false);
  });
});

// ─── Zod runtime validation (PR #4) ──────────────────────────────────────────
// These tests prove the upstream schemas catch wrong-type fields that the
// previous shallow type guards would silently accept. Each test represents
// a real failure mode: an API changing a field's type without telling us.
describe("upstream schema enforcement", () => {
  describe("isValidRugCheckSummary", () => {
    it("rejects lpBurned as a string (wrong type)", () => {
      expect(isValidRugCheckSummary({ lpBurned: "true", risks: [] })).toBe(false);
    });
    it("rejects risks as an object (wrong type)", () => {
      expect(isValidRugCheckSummary({ risks: { not: "an array" } })).toBe(false);
    });
    it("rejects risks[0].score as a string (wrong type)", () => {
      expect(isValidRugCheckSummary({ risks: [{ name: "x", score: "10" }] })).toBe(false);
    });
    it("still accepts a well-formed summary with unknown extra fields", () => {
      expect(
        isValidRugCheckSummary({ lpBurned: true, risks: [], someNewFieldUpstreamAdded: 42 }),
      ).toBe(true);
    });
  });

  describe("isHeliusLargestAccountsResponse", () => {
    it("rejects when holder uiAmount is a string (wrong type)", () => {
      expect(
        isHeliusLargestAccountsResponse({
          result: { value: [{ address: "a", owner: "b", uiAmount: "100" }] },
        }),
      ).toBe(false);
    });
    it("rejects when holder is missing address", () => {
      expect(
        isHeliusLargestAccountsResponse({
          result: { value: [{ owner: "b", uiAmount: 100 }] },
        }),
      ).toBe(false);
    });
  });

  describe("pickGoPlusResult", () => {
    it("returns the token result when fields are well-typed", () => {
      const raw = {
        result: {
          So11111111111111111111111111111111111111112: {
            is_honeypot: "0",
            buy_tax: "0.05",
            mint_authority: "",
          },
        },
      };
      const r = pickGoPlusResult(raw, "So11111111111111111111111111111111111111112");
      expect(r).not.toBeNull();
      expect(r?.is_honeypot).toBe("0");
    });
    it("keeps the token result when a dex pool reports burn_percent: null", () => {
      // Live GoPlus shape since ~2026-09 (BONK/WIF/HAWK/USDC): unmeasured
      // pools come back with `burn_percent: null`. Rejecting that dropped
      // the whole result and the goplus layer read as unavailable.
      const raw = {
        result: {
          So11111111111111111111111111111111111111112: {
            is_honeypot: "0",
            dex: [
              { dex_name: "Raydium", type: "Standard", tvl: "12345.6", burn_percent: null },
              { dex_name: "Orca", type: "Whirlpool", tvl: 999, burn_percent: 100 },
            ],
          },
        },
      };
      const r = pickGoPlusResult(raw, "So11111111111111111111111111111111111111112");
      expect(r).not.toBeNull();
      expect(r?.dex).toHaveLength(2);
      expect(r?.dex?.[0].burn_percent).toBeNull();
      expect(r?.dex?.[1].burn_percent).toBe(100);
    });
    it("returns null when the token result has a wrong-type field", () => {
      const raw = {
        result: {
          So11111111111111111111111111111111111111112: {
            // buy_tax must be string | number, not an object
            buy_tax: { nested: true },
          },
        },
      };
      expect(pickGoPlusResult(raw, "So11111111111111111111111111111111111111112")).toBeNull();
    });
  });
});
