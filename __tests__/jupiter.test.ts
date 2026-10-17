// __tests__/jupiter.test.ts
//
// Is the market of a token alive? Jupiter's organic score (api/_lib/jupiter.ts). Same discipline as the all-time high: a help, never a requirement. Whatever goes wrong the answer is
// "unknown", which is no relief (the verdict of before), never a wrong score.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

const store = new Map<string, unknown>();
const setCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];
let redis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } | null;
vi.mock("../api/_lib/cache", () => ({ getCacheRedis: () => redis }));

let answer: { body: unknown; status: number };
const fetchJson = vi.fn(async (_url: string, _init: unknown, _ms: number, _retries: number, onStatus?: (s: number) => void) => {
  onStatus?.(answer.status);
  return answer.status >= 200 && answer.status < 300 ? answer.body : null;
});
vi.mock("../api/_lib/http", () => ({ fetchJson: (...a: Parameters<typeof fetchJson>) => fetchJson(...a) }));

import { getOrganicScore, parseOrganicScore, jupiterSearchUrl, organicKey, organicLastKey, organicBackoffKey, ORGANIC_TTL_S, ORGANIC_STALE_S, ORGANIC_NOT_LISTED_TTL_S, ORGANIC_BACKOFF_S } from "../api/_lib/jupiter";
import { isLivingMarket } from "../api/_lib/layers";
import { LIVING_MARKET_MIN_ORGANIC_SCORE } from "../api/_lib/constants";

const MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const OTHER = "OtherMint1111111111111111111111111111111111";
const found = (score: unknown) => [{ id: "CloneOfJup111111111111111111111111111111111", organicScore: 99 }, { id: MINT, organicScore: score }];

beforeEach(() => {
  store.clear(); setCalls.length = 0; fetchJson.mockClear();
  redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown, opts: unknown) => { setCalls.push({ key: k, value: v, opts }); store.set(k, v); return "OK"; }),
  };
  answer = { body: found(95.4), status: 200 };
  delete process.env.VERCEL_ENV;
  delete process.env.JUPITER_API_KEY;
});

describe("parseOrganicScore: the score of THIS mint", () => {
  it("reads the entry whose id is the mint, not a clone that shares its name", () => {
    expect(parseOrganicScore(found(95.4), MINT)).toBe(95.4);
    expect(parseOrganicScore(found(0), MINT)).toBe(0);
  });
  it.each([[null], [undefined], [{}], ["x"], [[]], [[{ id: OTHER, organicScore: 50 }]], [found(null)], [found("80")], [found(-1)], [found(101)], [found(Number.NaN)]])("is null for %j", (raw) => {
    expect(parseOrganicScore(raw, MINT)).toBeNull();
  });
});

describe("the request", () => {
  it("is Jupiter's token search by mint, on the hostname of its documentation", () => {
    expect(jupiterSearchUrl(MINT)).toBe(`https://api.jup.ag/tokens/v2/search?query=${MINT}`);
  });
  it("keeps a preview deployment's entries apart from production's", () => {
    expect(organicKey(MINT)).toBe(`antares:organic:${MINT}`);
    process.env.VERCEL_ENV = "preview";
    expect(organicKey(MINT)).not.toBe(`antares:organic:${MINT}`);
    expect(organicKey(MINT).endsWith(MINT)).toBe(true);
  });
});

describe("getOrganicScore", () => {
  it("asks Jupiter once, keeps the score for a day, and serves the next ask from Redis; no key is needed", async () => {
    expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchJson.mock.calls[0][1])).not.toMatch(/key|token|authorization/i);
    expect(setCalls[0]).toMatchObject({ key: organicKey(MINT), value: { known: true, score: 95.4 }, opts: { ex: ORGANIC_TTL_S } });
    expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it("asks without a retry and with a short timeout: it must never slow a scan", async () => {
    await getOrganicScore(MINT);
    expect(fetchJson.mock.calls[0][2]).toBeLessThanOrEqual(3000);
    expect(fetchJson.mock.calls[0][3]).toBe(0);
  });
  it("a score of 0 is a score (a dead market is an answer), kept for a day", async () => {
    answer = { body: found(0), status: 200 };
    expect(await getOrganicScore(MINT)).toEqual({ score: 0, failed: false });
    expect(setCalls[0].value).toEqual({ known: true, score: 0 });
  });
  it("a token Jupiter does not list (a list without it) is an ANSWER: no score, no failure, remembered for 6 hours and not asked again", async () => {
    answer = { body: [{ id: OTHER, organicScore: 70 }], status: 200 };
    expect(await getOrganicScore(MINT)).toEqual({ score: null, failed: false });
    expect(setCalls[0]).toMatchObject({ value: { known: false, score: null }, opts: { ex: ORGANIC_NOT_LISTED_TTL_S } });
    expect(await getOrganicScore(MINT)).toEqual({ score: null, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it.each([[429], [500], [503], [0]])("a refusal or a silence (%i) is a FAILURE: no score, nothing kept for the token, a one-minute pause for everybody", async (status) => {
    answer = { body: null, status };
    expect(await getOrganicScore(MINT)).toEqual({ score: null, failed: true });
    expect(setCalls.filter((c) => c.key === organicKey(MINT))).toHaveLength(0);
    expect(setCalls.find((c) => c.key === organicBackoffKey())?.opts).toEqual({ ex: ORGANIC_BACKOFF_S });
    fetchJson.mockClear();
    expect(await getOrganicScore(OTHER)).toEqual({ score: null, failed: true });
    expect(fetchJson).not.toHaveBeenCalled();
    store.delete(organicBackoffKey());
    await getOrganicScore(MINT);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it("an answer that is not a list is a failure without a pause (the transport gave something else)", async () => {
    answer = { body: { error: "x" }, status: 200 };
    expect(await getOrganicScore(MINT)).toEqual({ score: null, failed: true });
    expect(setCalls.some((c) => c.key === organicBackoffKey())).toBe(false);
  });
  it("a value in Redis that is not what was written is not read: Jupiter is asked", async () => {
    store.set(organicKey(MINT), { known: true, score: "x" });
    expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
  });
  it("Redis missing, or failing: the scan goes on", async () => {
    redis = null;
    expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
    redis = { get: vi.fn(async () => { throw new Error("redis down"); }), set: vi.fn(async () => { throw new Error("redis down"); }) };
    expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
  });
});

describe("the optional API key (JUPITER_API_KEY): more headroom, never a requirement", () => {
  const headerOf = (call: number) => (fetchJson.mock.calls[call][1] as { headers: Record<string, string> }).headers;
  it("without a key nothing is sent but the accept header", async () => {
    await getOrganicScore(MINT);
    expect(headerOf(0)).toEqual({ accept: "application/json" });
  });
  it("with a key it is sent as x-api-key, and kept nowhere (Redis holds scores only)", async () => {
    process.env.JUPITER_API_KEY = "test-key-not-real";
    try {
      await getOrganicScore(MINT);
      expect(headerOf(0)["x-api-key"]).toBe("test-key-not-real");
      expect(JSON.stringify([...store.entries()])).not.toContain("test-key-not-real");
    } finally { delete process.env.JUPITER_API_KEY; }
  });
  it("a key that Jupiter refuses (401, 403) costs nothing: the same request is asked again WITHOUT it and gives the score", async () => {
    process.env.JUPITER_API_KEY = "refused-key-not-real";
    try {
      for (const refused of [401, 403]) {
        fetchJson.mockClear(); store.clear();
        let calls = 0;
        fetchJson.mockImplementationOnce(async (_u, _i, _m, _r, onStatus) => { calls++; onStatus?.(refused); return null; });
        expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
        expect(calls).toBe(1);
        expect(fetchJson).toHaveBeenCalledTimes(2);
        expect(headerOf(0)["x-api-key"]).toBe("refused-key-not-real");
        expect(headerOf(1)["x-api-key"]).toBeUndefined();
      }
    } finally { delete process.env.JUPITER_API_KEY; }
  });
});

describe("getOrganicScore: when Jupiter does not answer, a score read less than two days ago is served", () => {
  const LAST = { known: true, score: 95.4 };
  it("keeps the last score for two days next to the answer for one", async () => {
    await getOrganicScore(MINT);
    expect(setCalls[0]).toMatchObject({ key: organicKey(MINT), opts: { ex: ORGANIC_TTL_S } });
    expect(setCalls[1]).toMatchObject({ key: organicLastKey(MINT), value: { known: true, score: 95.4 }, opts: { ex: ORGANIC_STALE_S } });
    expect(ORGANIC_STALE_S).toBe(48 * 3600);
  });
  it.each([[429], [500], [503], [0]])("a refusal or a silence (%i) with a score kept: it is served, not a failure", async (status) => {
    store.set(organicLastKey(MINT), LAST);
    answer = { body: null, status };
    expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
  });
  it("during the pause, and when the answer is not a list: served too", async () => {
    store.set(organicLastKey(MINT), LAST);
    store.set(organicBackoffKey(), 1);
    expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
    expect(fetchJson).not.toHaveBeenCalled();
    store.delete(organicBackoffKey());
    answer = { body: { error: "x" }, status: 200 };
    expect(await getOrganicScore(MINT)).toEqual({ score: 95.4, failed: false });
  });
  it("nothing kept: a failure; a score kept for another token, or a value that is not what was written: a failure", async () => {
    answer = { body: null, status: 503 };
    expect(await getOrganicScore(MINT)).toEqual({ score: null, failed: true });
    store.delete(organicBackoffKey());
    store.set(organicLastKey(OTHER), LAST);
    expect(await getOrganicScore(MINT)).toEqual({ score: null, failed: true });
    store.delete(organicBackoffKey());
    store.set(organicLastKey(MINT), { known: true, score: "x" });
    expect(await getOrganicScore(MINT)).toEqual({ score: null, failed: true });
  });
  it("when Jupiter ANSWERS that it does not list the token, the old score is not served (an answer is not a silence)", async () => {
    store.set(organicLastKey(MINT), LAST);
    answer = { body: [{ id: OTHER, organicScore: 70 }], status: 200 };
    expect(await getOrganicScore(MINT)).toEqual({ score: null, failed: false });
  });
});

describe("isLivingMarket: the line sits in the empty gap between the dead (0) and the serious (49 and more)", () => {
  it("is alive from LIVING_MARKET_MIN_ORGANIC_SCORE up, and unknown is not alive", () => {
    expect(LIVING_MARKET_MIN_ORGANIC_SCORE).toBe(30);
    expect(isLivingMarket(30)).toBe(true);
    expect(isLivingMarket(49)).toBe(true);   // BC, the least active token the engine relieves
    expect(isLivingMarket(95)).toBe(true);   // JUP
    expect(isLivingMarket(29.9)).toBe(false);
    expect(isLivingMarket(0)).toBe(false);   // BAN, JELLYJELLY, ALCH, NST, MELANIA, YZY, LUNA, TRUNK
    for (const unknown of [null, undefined, Number.NaN]) expect(isLivingMarket(unknown)).toBe(false);
  });
});
