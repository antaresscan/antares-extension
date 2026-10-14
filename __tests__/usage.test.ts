import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Redis } from "@upstash/redis";

vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

import {
  classify, heliusCredits, outcomeOf, recordCall, recordSkipped, recordScanOutcome, limitedShareAlert, pendingUsage, flushUsage, initUsage, readUsage,
  _resetUsageForTests, CREDIT_BASIS, PROVIDERS, LIMITED_ALERT_MIN_SCANS, LIMITED_ALERT_MAX_SHARE,
} from "../api/_lib/usage";
import { fetchJson, fetchJsonPost, _resetCircuitBreakersForTests } from "../api/_lib/http";

// ─── Upstream usage counters (audit: nothing counted the calls, the refusals, or the credits) ────────────────────────────

beforeEach(() => { _resetUsageForTests(); _resetCircuitBreakersForTests(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("which provider a request belongs to", () => {
  it.each([
    ["https://mainnet.helius-rpc.com/?api-key=SECRET", "helius"],
    ["https://api.helius.xyz/v0/transactions?api-key=SECRET", "helius"],
    ["https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=x", "goplus"],
    ["https://api.rugcheck.xyz/v1/tokens/x/report", "rugcheck"],
    ["https://api.dexscreener.com/latest/dex/tokens/x", "dexscreener"],
    ["https://api.geckoterminal.com/api/v2/networks/solana/pools/x/ohlcv/hour", "geckoterminal"],
    ["https://pro-api.solscan.io/v2.0/token/meta?address=x", "solscan"],
    ["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "gemini"],
    ["https://api.mainnet-beta.solana.com", "publicrpc"],
    ["https://solana-rpc.publicnode.com", "publicrpc"],
    ["https://example.com/anything", "other"],
    ["not an address", "other"],
  ])("%s -> %s", (url, provider) => {
    expect(classify(url).provider).toBe(provider);
  });

  it("a look-alike host is not mistaken for a provider", () => {
    expect(classify("https://helius-rpc.com.evil.example/").provider).toBe("other");
    expect(classify("https://notgopluslabs.io/").provider).toBe("other");
  });
});

describe("Helius credits (the published table: RPC 1, DAS 10, getProgramAccounts 10, Enhanced Transactions 100)", () => {
  it.each([
    ["getAccountInfo", 1], ["getTokenLargestAccounts", 1], ["getMultipleAccounts", 1], ["getTokenSupply", 1], ["getSignaturesForAddress", 1],
    ["getTokenAccounts", 10], ["getAssetsByOwner", 10], ["getProgramAccounts", 10],
  ])("RPC %s costs %i", (method, credits) => {
    expect(heliusCredits("/", method)).toBe(credits);
    expect(classify("https://mainnet.helius-rpc.com/?api-key=k", { jsonrpc: "2.0", method }).credits).toBe(credits);
  });

  it("the Enhanced Transactions REST API costs 100", () => {
    expect(heliusCredits("/v0/transactions", null)).toBe(100);
    expect(classify("https://api.helius.xyz/v0/transactions?api-key=k", { transactions: ["a"] }).credits).toBe(100);
    expect(classify("https://api.helius.xyz/v0/addresses/abc/transactions?limit=200&api-key=k").credits).toBe(100);
  });

  it("a Helius call with no method is counted as a plain RPC call", () => {
    expect(classify("https://mainnet.helius-rpc.com/?api-key=k").credits).toBe(1);
  });

  it("every other provider counts 1 per request", () => {
    for (const url of ["https://api.gopluslabs.io/x", "https://api.rugcheck.xyz/x", "https://api.dexscreener.com/x", "https://api.geckoterminal.com/x"]) {
      expect(classify(url).credits).toBe(1);
    }
  });

  it("each provider says what its unit is", () => {
    for (const p of PROVIDERS) expect(CREDIT_BASIS[p].length).toBeGreaterThan(5);
  });
});

describe("what an HTTP status means", () => {
  it.each([[200, "ok"], [204, "ok"], [404, "ok"], [429, "refused"], [503, "refused"], [401, "denied"], [403, "denied"], [500, "failed"], [502, "failed"], [0, "failed"]])(
    "%i -> %s", (status, outcome) => { expect(outcomeOf(status)).toBe(outcome); },
  );
});

describe("counting", () => {
  it("an answered request counts as a call, an ok and its credits", () => {
    recordCall("https://mainnet.helius-rpc.com/?api-key=SECRET", 200, { method: "getTokenAccounts" });
    expect(pendingUsage()).toEqual({ "helius:calls": 1, "helius:ok": 1, "helius:credits": 10 });
  });

  it("a refused request (429) is a call and a refusal, and is NOT billed", () => {
    recordCall("https://api.geckoterminal.com/api/v2/x", 429);
    recordCall("https://api.geckoterminal.com/api/v2/x", 503);
    expect(pendingUsage()).toEqual({ "geckoterminal:calls": 2, "geckoterminal:refused": 2 });
  });

  it("a rejected key (401/403) and a failure (0, 5xx) are told apart", () => {
    recordCall("https://pro-api.solscan.io/v2.0/token/meta", 401);
    recordCall("https://pro-api.solscan.io/v2.0/token/meta", 403);
    recordCall("https://api.rugcheck.xyz/x", 0);
    recordCall("https://api.rugcheck.xyz/x", 502);
    expect(pendingUsage()).toMatchObject({ "solscan:denied": 2, "rugcheck:failed": 2 });
    expect(pendingUsage()["solscan:credits"]).toBeUndefined();
  });

  it("a request the circuit breaker did not send is 'skipped', not a call", () => {
    recordSkipped("https://api.dexscreener.com/x");
    expect(pendingUsage()).toEqual({ "dexscreener:skipped": 1 });
  });

  it("keeps nothing but counters: no address, no key, no token", () => {
    recordCall("https://mainnet.helius-rpc.com/?api-key=SECRETKEY123", 200, { method: "getAccountInfo", params: ["MINTADDRESS1111"] });
    recordCall("https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=MINTADDRESS1111", 200);
    const dump = JSON.stringify(pendingUsage());
    expect(dump).not.toMatch(/SECRETKEY123|MINTADDRESS1111|http/);
    for (const k of Object.keys(pendingUsage())) expect(k).toMatch(/^[a-z]+:(calls|ok|refused|denied|failed|skipped|credits)$/);
  });

  it("never throws, whatever it is given", () => {
    expect(() => recordCall(undefined as unknown as string, NaN, 12 as unknown)).not.toThrow();
    expect(() => recordSkipped(null as unknown as string)).not.toThrow();
  });
});

describe("writing the counters: ONE Redis command, bounded in time", () => {
  const fakeRedis = (impl?: (...a: unknown[]) => unknown) => {
    const evalMock = vi.fn(impl ?? (async () => 1));
    return { redis: { eval: evalMock } as unknown as Redis, evalMock };
  };

  it("writes every counter with a single eval, under the key of the UTC day, with a 40-day expiry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T23:59:59Z"));
    const { redis, evalMock } = fakeRedis(); initUsage(redis);
    recordCall("https://mainnet.helius-rpc.com/?api-key=k", 200, { method: "getTokenAccounts" });
    recordCall("https://api.geckoterminal.com/x", 429);

    await flushUsage();

    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, keys, args] = evalMock.mock.calls[0] as [string, string[], string[]];
    expect(script).toContain("HINCRBY");
    expect(keys).toEqual(["usage:2026-10-11"]);
    expect(args[0]).toBe(String(40 * 86400));
    const pairs = Object.fromEntries(args.slice(1).reduce<string[][]>((acc, v, i, a) => (i % 2 === 0 ? [...acc, [v, a[i + 1]]] : acc), [])) as Record<string, string>;
    expect(pairs).toEqual({ "helius:calls": "1", "helius:ok": "1", "helius:credits": "10", "geckoterminal:calls": "1", "geckoterminal:refused": "1" });
  });

  it("writes once: a second flush with nothing new sends nothing, and counting goes on from zero", async () => {
    const { redis, evalMock } = fakeRedis(); initUsage(redis);
    recordCall("https://api.rugcheck.xyz/x", 200);
    await flushUsage();
    await flushUsage();
    expect(evalMock).toHaveBeenCalledTimes(1);
    expect(pendingUsage()).toEqual({});
    recordCall("https://api.rugcheck.xyz/x", 200);
    expect(pendingUsage()).toEqual({ "rugcheck:calls": 1, "rugcheck:ok": 1, "rugcheck:credits": 1 });
  });

  it("without Redis it does nothing and keeps the counts", async () => {
    recordCall("https://api.rugcheck.xyz/x", 200);
    await expect(flushUsage()).resolves.toBeUndefined();
    expect(pendingUsage()["rugcheck:calls"]).toBe(1);
  });

  it("a Redis client that throws at once (no `eval`, bad argument) never reaches the caller either: a scan must not fail because of a counter", async () => {
    initUsage({} as unknown as Redis); // no eval at all
    recordCall("https://api.rugcheck.xyz/x", 200);
    await expect(flushUsage()).resolves.toBeUndefined();
    expect(pendingUsage()).toEqual({});
    const { redis } = fakeRedis(() => { throw new Error("sync failure"); }); initUsage(redis);
    recordCall("https://api.rugcheck.xyz/x", 200);
    await expect(flushUsage()).resolves.toBeUndefined();
  });
  it("a Redis error never reaches the caller, and the counts are dropped rather than queued", async () => {
    const { redis } = fakeRedis(async () => { throw new Error("redis down"); }); initUsage(redis);
    recordCall("https://api.rugcheck.xyz/x", 200);
    await expect(flushUsage()).resolves.toBeUndefined();
    expect(pendingUsage()).toEqual({});
  });

  it("a Redis that never answers cannot hold the scan back more than the bound", async () => {
    vi.useFakeTimers();
    const { redis } = fakeRedis(() => new Promise(() => {})); initUsage(redis);
    recordCall("https://api.rugcheck.xyz/x", 200);
    let done = false;
    const p = flushUsage(300).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(299);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(done).toBe(true);
  });
});

describe("reading the counters", () => {
  const NOW = new Date("2026-10-11T12:00:00Z");
  const withRows = (rows: Record<string, Record<string, number | string>>) => {
    const hgetall = vi.fn(async (key: string) => rows[key] ?? null);
    initUsage({ hgetall } as unknown as Redis);
    return hgetall;
  };

  it("returns the requested days oldest first, per provider, with totals", async () => {
    withRows({
      "usage:2026-10-10": { "helius:calls": 10, "helius:ok": 9, "helius:refused": 1, "helius:credits": 95 },
      "usage:2026-10-11": { "helius:calls": "5", "helius:ok": "5", "helius:credits": "50", "geckoterminal:calls": 4, "geckoterminal:refused": 2 },
    });
    const r = await readUsage(2, NOW);
    expect(r.days.map((d) => d.date)).toEqual(["2026-10-10", "2026-10-11"]);
    expect(r.days[1].providers.helius?.credits).toBe(50);
    expect(r.totals.helius).toMatchObject({ calls: 15, ok: 14, refused: 1, credits: 145 });
    expect(r.totals.geckoterminal).toMatchObject({ calls: 4, refused: 2 });
    expect(r.basis.helius).toMatch(/credits/i);
  });

  it("clamps the window to 1..31 days and ignores unknown or malformed fields", async () => {
    const hgetall = withRows({ "usage:2026-10-11": { "helius:calls": 1, "mystery:calls": 7, "helius:bogus": 3, "nonsense": 9 } });
    expect((await readUsage(0, NOW)).days).toHaveLength(1);
    expect((await readUsage(999, NOW)).days).toHaveLength(31);
    expect(hgetall).toHaveBeenCalledTimes(1 + 31);
    const r = await readUsage(1, NOW);
    expect(r.totals).toEqual({ helius: { calls: 1, ok: 0, refused: 0, denied: 0, failed: 0, skipped: 0, credits: 0 } });
  });

  it("without Redis it reports empty days instead of failing", async () => {
    const r = await readUsage(3, NOW);
    expect(r.days).toHaveLength(3);
    expect(r.totals).toEqual({});
  });
});

describe("fetchJson / fetchJsonPost count what they send", () => {
  const response = (status: number, json: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

  it("an answered POST to Helius counts its method's credits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, { result: 1 })));
    await fetchJsonPost("https://mainnet.helius-rpc.com/?api-key=k", { jsonrpc: "2.0", method: "getTokenAccounts", params: {} }, 1000, 0);
    expect(pendingUsage()).toEqual({ "helius:calls": 1, "helius:ok": 1, "helius:credits": 10 });
  });

  it("a GET counts a call and a credit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(200, { pairs: [] })));
    await fetchJson("https://api.dexscreener.com/latest/dex/tokens/x", {}, 1000, 0);
    expect(pendingUsage()).toEqual({ "dexscreener:calls": 1, "dexscreener:ok": 1, "dexscreener:credits": 1 });
  });

  it("a 429 and its retry are two refused requests", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => response(429)));
    const p = fetchJson("https://api.geckoterminal.com/api/v2/x", {}, 1000, 1);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(pendingUsage()).toEqual({ "geckoterminal:calls": 2, "geckoterminal:refused": 2 });
  });

  it("a rejected key is counted as denied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(401)));
    await fetchJson("https://pro-api.solscan.io/v2.0/token/meta", {}, 1000, 0);
    expect(pendingUsage()).toEqual({ "solscan:calls": 1, "solscan:denied": 1 });
  });

  it("no answer at all (network error) is a failed request, counted once", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    await fetchJsonPost("https://api.rugcheck.xyz/x", {}, 1000, 0);
    expect(pendingUsage()).toEqual({ "rugcheck:calls": 1, "rugcheck:failed": 1 });
  });

  it("an answer whose body cannot be read is one ok request, not also a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })));
    await fetchJson("https://api.rugcheck.xyz/x", {}, 1000, 0);
    expect(pendingUsage()).toMatchObject({ "rugcheck:calls": 1, "rugcheck:ok": 1 });
    expect(pendingUsage()["rugcheck:failed"]).toBeUndefined();
  });

  it("when the circuit breaker is open nothing is sent, and the skip is counted", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("down"); });
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 5; i++) await fetchJson("https://api.dexscreener.com/x", {}, 1000, 0); // 5 failures open the breaker
    fetchMock.mockClear(); _resetUsageForTests();

    await fetchJson("https://api.dexscreener.com/x", {}, 1000, 0);
    await fetchJsonPost("https://api.dexscreener.com/x", {}, 1000, 0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pendingUsage()).toEqual({ "dexscreener:skipped": 2 });
  });
});

// ─── How many cold scans were answered "Limited data" (a source was silent), and which source ──────────────────────────────────────────────

describe("counting the scans and their causes", () => {
  it("a complete scan counts once in total; an incomplete one counts in total, in limited, and once per cause", () => {
    recordScanOutcome([]);
    recordScanOutcome(["helius"]);
    recordScanOutcome(["helius", "goplus"]);
    expect(pendingUsage()).toEqual({ "scans:total": 3, "scans:limited": 2, "scans:cause.helius": 2, "scans:cause.goplus": 1 });
  });

  it("goes out in the same single eval as the upstream counters", async () => {
    const evalMock = vi.fn(async () => 1);
    initUsage({ eval: evalMock } as unknown as Redis);
    recordCall("https://api.rugcheck.xyz/x", 200);
    recordScanOutcome(["rugcheck"]);
    await flushUsage();
    expect(evalMock).toHaveBeenCalledTimes(1);
    const args = (evalMock.mock.calls[0] as unknown as [string, string[], string[]])[2];
    expect(args).toEqual(expect.arrayContaining(["scans:total", "1", "scans:limited", "1", "scans:cause.rugcheck", "1"]));
  });

  it("never throws (counting must not break a scan)", () => {
    expect(() => recordScanOutcome(undefined as unknown as string[])).not.toThrow();
  });
});

describe("reading the share of Limited data scans", () => {
  const NOW = new Date("2026-10-11T12:00:00Z");
  const withRows = (rows: Record<string, Record<string, number | string>>) => initUsage({ hgetall: vi.fn(async (key: string) => rows[key] ?? null) } as unknown as Redis);

  it("per day and in total, with the causes", async () => {
    withRows({
      "usage:2026-10-10": { "scans:total": 100, "scans:limited": 4, "scans:cause.helius": 3, "scans:cause.goplus": 1, "helius:calls": 5 },
      "usage:2026-10-11": { "scans:total": "50", "scans:limited": "1", "scans:cause.chart": "1" },
    });
    const r = await readUsage(2, NOW);
    expect(r.days[0].scans).toEqual({ total: 100, limited: 4, share: 0.04, causes: { helius: 3, goplus: 1 } });
    expect(r.days[1].scans).toEqual({ total: 50, limited: 1, share: 0.02, causes: { chart: 1 } });
    expect(r.scans).toEqual({ total: 150, limited: 5, share: 5 / 150, causes: { helius: 3, goplus: 1, chart: 1 } });
    // the upstream counters are untouched by the new fields
    expect(r.totals).toEqual({ helius: { calls: 5, ok: 0, refused: 0, denied: 0, failed: 0, skipped: 0, credits: 0 } });
  });

  it("a day with no scan has share 0, not NaN; without Redis the report is empty", async () => {
    withRows({});
    expect((await readUsage(1, NOW)).days[0].scans).toEqual({ total: 0, limited: 0, share: 0, causes: {} });
    _resetUsageForTests();
    expect((await readUsage(1, NOW)).scans).toEqual({ total: 0, limited: 0, share: 0, causes: {} });
  });
});

describe("limitedShareAlert: when is the share worth a warning", () => {
  const day = (total: number, limited: number, causes: Record<string, number> = {}) => ({ total, limited, share: total ? limited / total : 0, causes });

  it("the thresholds are 3 % of at least 50 cold scans", () => {
    expect(LIMITED_ALERT_MAX_SHARE).toBe(0.03);
    expect(LIMITED_ALERT_MIN_SCANS).toBe(50);
  });

  it.each([
    [1000, 30, false], // exactly 3 %: not above
    [1000, 31, true],
    [100, 3, false],
    [100, 4, true],
    [50, 2, true], // the smallest day that can be judged
    [49, 49, false], // too few scans
    [0, 0, false],
    [500, 0, false],
  ])("%i cold scans, %i Limited data: alert %s", (total, limited, alert) => {
    expect(limitedShareAlert(day(total, limited)).alert).toBe(alert);
  });

  it("the message gives the share and the causes, biggest first", () => {
    const v = limitedShareAlert(day(200, 20, { goplus: 4, helius: 17 }));
    expect(v.alert).toBe(true);
    expect(v.message).toContain("10.0 % of 200 cold scans answered Limited data");
    expect(v.message).toContain("helius 17, goplus 4");
  });
});
