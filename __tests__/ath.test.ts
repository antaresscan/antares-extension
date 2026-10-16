// __tests__/ath.test.ts
//
// The all-time high of a token (api/_lib/ath.ts). It is a help, never a requirement: whatever goes wrong, the answer is null (no relief), never a wrong number.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

const store = new Map<string, unknown>();
const setCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];
let redis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } | null;
vi.mock("../api/_lib/cache", () => ({ getCacheRedis: () => redis }));

let answer: { body: unknown; status: number } | "throws";
const fetchJson = vi.fn(async (_url: string, _init: unknown, _ms: number, _retries: number, onStatus?: (s: number) => void) => {
  if (answer === "throws") throw new Error("network");
  onStatus?.(answer.status);
  return answer.status >= 200 && answer.status < 300 ? answer.body : null;
});
vi.mock("../api/_lib/http", () => ({ fetchJson: (...a: Parameters<typeof fetchJson>) => fetchJson(...a) }));

import { getAllTimeHigh, judgeHistory, athSideKey, parseAllTimeHigh, athKey, athBackoffKey, athUrl, ATH_TTL_S, ATH_NOT_LISTED_TTL_S, ATH_BACKOFF_S, ATH_SIDE_TTL_S } from "../api/_lib/ath";

const HIGH = { ath: 0.381443, athDate: "2025-09-14T08:27:34.512Z" };

const MINT = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";
const coin = (ath: unknown, date: unknown = "2025-09-14T08:27:34.512Z") => ({ id: "collector-crypt", market_data: { ath: { usd: ath }, ath_date: { usd: date } } });

beforeEach(() => {
  store.clear(); setCalls.length = 0; fetchJson.mockClear();
  redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown, opts: unknown) => { setCalls.push({ key: k, value: v, opts }); store.set(k, v); return "OK"; }),
  };
  answer = { body: coin(0.381443), status: 200 };
  delete process.env.VERCEL_ENV;
});
afterEach(() => { delete process.env.VERCEL_ENV; });

describe("parseAllTimeHigh: only a positive USD price is a high", () => {
  it("reads the high and its date", () => {
    expect(parseAllTimeHigh(coin(0.381443))).toEqual({ ath: 0.381443, athDate: "2025-09-14T08:27:34.512Z" });
  });
  it("keeps the high when the date is missing or not a date", () => {
    expect(parseAllTimeHigh(coin(2, null))).toEqual({ ath: 2, athDate: null });
    expect(parseAllTimeHigh(coin(2, "yesterday"))).toEqual({ ath: 2, athDate: null });
  });
  it.each([[null], [undefined], [{}], [{ market_data: {} }], [coin(0)], [coin(-1)], [coin("2")], [coin(Number.NaN)], [coin(Infinity)], ["text"], [42]])("is null for %j", (raw) => {
    expect(parseAllTimeHigh(raw)).toBeNull();
  });
});

describe("the request", () => {
  it("is the contract endpoint of CoinGecko with everything but the market data left out", () => {
    const u = athUrl(MINT);
    expect(u.startsWith(`https://api.coingecko.com/api/v3/coins/solana/contract/${MINT}?`)).toBe(true);
    for (const off of ["localization", "tickers", "community_data", "developer_data", "sparkline"]) expect(u).toContain(`${off}=false`);
  });
  it("keeps a preview deployment's entries apart from production's", () => {
    expect(athKey(MINT)).toBe(`antares:ath:${MINT}`);
    process.env.VERCEL_ENV = "preview";
    expect(athKey(MINT)).not.toBe(`antares:ath:${MINT}`);
    expect(athKey(MINT).endsWith(MINT)).toBe(true);
  });
});

describe("getAllTimeHigh", () => {
  it("asks CoinGecko once, keeps the answer for a day, and serves the next ask from Redis", async () => {
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].opts).toEqual({ ex: ATH_TTL_S });
    expect(setCalls[0].value).toEqual({ known: true, ath: 0.381443, athDate: "2025-09-14T08:27:34.512Z" });
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1); // not asked again
  });
  it("asks without a retry and with a short timeout: it must never slow a scan", async () => {
    await getAllTimeHigh(MINT);
    const call = fetchJson.mock.calls[0];
    expect(call[2]).toBeLessThanOrEqual(4000);
    expect(call[3]).toBe(0);
  });
  it("a token CoinGecko does not list (404) is an ANSWER: no high, no failure, remembered for 6 hours and not asked again", async () => {
    answer = { body: { error: "coin not found" }, status: 404 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].opts).toEqual({ ex: ATH_NOT_LISTED_TTL_S });
    expect(setCalls[0].value).toEqual({ known: false, ath: null, athDate: null });
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it("a token CoinGecko lists without a high (200 with no market data) is an answer too", async () => {
    answer = { body: { id: "new-coin", market_data: {} }, status: 200 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
    expect(setCalls[0].opts).toEqual({ ex: ATH_NOT_LISTED_TTL_S });
  });
  it.each([[429], [500], [503]])("a refusal or a failure (%i) is a FAILURE: no high, nothing kept for the token (only the shared pause), and once the pause is over it is asked again", async (status) => {
    answer = { body: null, status };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    expect(setCalls.filter((c) => c.key === athKey(MINT))).toHaveLength(0);
    expect(setCalls.filter((c) => c.key === athBackoffKey())).toHaveLength(1);
    store.delete(athBackoffKey()); // the pause is over
    await getAllTimeHigh(MINT);
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });
  it("a 200 whose body cannot be read (the transport gave nothing) is a failure, not remembered", async () => {
    answer = { body: null, status: 200 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    expect(setCalls).toHaveLength(0);
  });
  it("a high that is not a positive price in a 200 is an answer of no high (remembered 6 hours), not a failure", async () => {
    answer = { body: { market_data: { ath: { usd: "lots" } } }, status: 200 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
  });
  it("a value in Redis that is not what was written is not read: CoinGecko is asked", async () => {
    store.set(athKey(MINT), { known: true, ath: "x" });
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it.each([[429], [503], [0]])("after a refusal or a silence (%i) nobody asks for a minute: one Redis key, shared, and the next scans do not reach CoinGecko", async (status) => {
    answer = { body: null, status };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    const backoff = setCalls.find((c) => c.key === athBackoffKey());
    expect(backoff?.opts).toEqual({ ex: ATH_BACKOFF_S });
    fetchJson.mockClear();
    expect(await getAllTimeHigh("OtherMint1111111111111111111111111111111111")).toEqual({ high: null, failed: true });
    expect(fetchJson).not.toHaveBeenCalled(); // a failure of another token, no request
  });
  it("a token CoinGecko does not know (404) does not stop anybody from asking about the others", async () => {
    answer = { body: { error: "coin not found" }, status: 404 };
    await getAllTimeHigh(MINT);
    expect(setCalls.some((c) => c.key === athBackoffKey())).toBe(false);
    answer = { body: coin(2), status: 200 };
    expect((await getAllTimeHigh("OtherMint1111111111111111111111111111111111")).high).not.toBeNull();
  });
  it("sends the Demo key when the environment has one, and nothing when it has not", async () => {
    await getAllTimeHigh(MINT);
    expect(JSON.stringify(fetchJson.mock.calls[0][1])).not.toContain("x-cg-demo-api-key");
    process.env.COINGECKO_DEMO_API_KEY = "CG-test-key";
    try {
      await getAllTimeHigh("OtherMint1111111111111111111111111111111111");
      expect((fetchJson.mock.calls[1][1] as { headers: Record<string, string> }).headers["x-cg-demo-api-key"]).toBe("CG-test-key");
    } finally { delete process.env.COINGECKO_DEMO_API_KEY; }
  });
  it("Redis missing: the scan goes on (CoinGecko is asked, nothing is kept)", async () => {
    redis = null;
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it("Redis failing on read and on write: the answer is still the high", async () => {
    redis = { get: vi.fn(async () => { throw new Error("redis down"); }), set: vi.fn(async () => { throw new Error("redis down"); }) };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
  });
});

describe("judgeHistory: a line with a memory (in at 90 %, out only below 85 %)", () => {
  it("with no memory it is the plain line: 89.9 % is clean, 90 % is collapsed, an unknown fall is unknown", async () => {
    expect(await judgeHistory(MINT, 89.9)).toBe(false);
    store.clear();
    expect(await judgeHistory(MINT, 90)).toBe(true);
    expect(await judgeHistory(MINT, null)).toBeNull();
    expect(await judgeHistory(MINT, Number.NaN)).toBeNull();
  });
  it("remembers the side for a week", async () => {
    await judgeHistory(MINT, 95);
    expect(store.get(athSideKey(MINT))).toBe("collapsed");
    expect(setCalls.at(-1)?.opts).toEqual({ ex: ATH_SIDE_TTL_S });
    store.clear();
    await judgeHistory(MINT, 40);
    expect(store.get(athSideKey(MINT))).toBe("clean");
  });
  it("a token that was clean stays clean while it flirts with the line from below, and is collapsed the day it crosses it", async () => {
    expect(await judgeHistory(MINT, 89.2)).toBe(false); // RAY today
    expect(await judgeHistory(MINT, 88.0)).toBe(false);
    expect(await judgeHistory(MINT, 90.1)).toBe(true);  // it crossed
  });
  it("a token that has collapsed stays collapsed for every fall down to 85 %: it needs a rally of a third of its price from the line to be clean again", async () => {
    expect(await judgeHistory(MINT, 90.23)).toBe(true); // YZY today
    for (const drop of [89.9, 89.0, 88.0, 86.0, 85.0]) expect(await judgeHistory(MINT, drop), `at ${drop} %`).toBe(true);
    expect(await judgeHistory(MINT, 84.9)).toBe(false);
    expect(await judgeHistory(MINT, 89.9)).toBe(false); // clean again: the line is the plain one from this side
  });
  it("the memory of one token is not the memory of another", async () => {
    await judgeHistory(MINT, 95);
    expect(await judgeHistory("OtherMint1111111111111111111111111111111111", 88)).toBe(false);
  });
  it("Redis missing or failing: the plain line, and the scan goes on", async () => {
    redis = null;
    expect(await judgeHistory(MINT, 89.9)).toBe(false);
    expect(await judgeHistory(MINT, 90)).toBe(true);
    redis = { get: vi.fn(async () => { throw new Error("redis down"); }), set: vi.fn(async () => { throw new Error("redis down"); }) };
    expect(await judgeHistory(MINT, 91)).toBe(true);
    expect(await judgeHistory(MINT, 80)).toBe(false);
  });
});
