// __tests__/ath.test.ts
//
// The all-time high of a token (api/_lib/ath.ts): Solscan Pro `token/price` (one price a day) and nothing else. It is a help, never a requirement: whatever goes wrong, the answer is null
// (no relief), never a wrong number.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

const store = new Map<string, unknown>();
const setCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];
let redis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } | null;
vi.mock("../api/_lib/cache", () => ({ getCacheRedis: () => redis }));

// What Solscan answers.
let answer: { body: unknown; status: number };
const fetchJson = vi.fn(async (_url: string, _init: unknown, _ms: number, _retries: number, onStatus?: (s: number) => void) => {
  onStatus?.(answer.status);
  return answer.status >= 200 && answer.status < 300 ? answer.body : null;
});
vi.mock("../api/_lib/http", () => ({ fetchJson: (...a: Parameters<typeof fetchJson>) => fetchJson(...a) }));

import { getAllTimeHigh, judgeHistory, athSideKey, parseSolscanHigh, solscanSpan, athDropPct, athKey, athBackoffKey, solscanPriceEndpoint, ATH_TTL_S, ATH_NOT_LISTED_TTL_S, ATH_BACKOFF_S, ATH_SIDE_TTL_S } from "../api/_lib/ath";
import { _resetSolscanBackoffForTests } from "../api/_lib/fetchers";

const MINT = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";
const OTHER = "OtherMint1111111111111111111111111111111111";
const HIGH = { ath: 0.37, athDate: "2025-09-13" };
/** What Solscan sends for token/price: one row a day. */
const prices = (...rows: Array<[number | string, unknown]>) => ({ success: true, data: rows.map(([date, price]) => ({ date, price })) });

beforeEach(() => {
  store.clear(); setCalls.length = 0; fetchJson.mockClear();
  redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown, opts: unknown) => { setCalls.push({ key: k, value: v, opts }); store.set(k, v); return "OK"; }),
  };
  answer = { body: prices([20250912, 0.2], [20250913, 0.37], [20250914, 0.3], [20251020, 0.02]), status: 200 };
  delete process.env.VERCEL_ENV;
  process.env.SOLSCAN_API_KEY = "test-key-not-real";
  _resetSolscanBackoffForTests();
});
afterEach(() => { delete process.env.VERCEL_ENV; delete process.env.SOLSCAN_API_KEY; _resetSolscanBackoffForTests(); });

describe("parseSolscanHigh: the highest daily price", () => {
  it("is the highest price of the series and its day", () => {
    expect(parseSolscanHigh(prices([20250912, 0.2], [20250913, 0.37], [20250914, 0.3]))).toEqual(HIGH);
  });
  it("reads the day as a number, as 8 digits of text or as an ISO date, and does not depend on the order of the rows", () => {
    expect(parseSolscanHigh(prices([20250914, 3], [20250913, 5], [20250912, 4]))?.athDate).toBe("2025-09-13");
    expect(parseSolscanHigh(prices(["20250913", 5], ["20250912", 4]))?.athDate).toBe("2025-09-13");
    expect(parseSolscanHigh(prices(["2025-09-13", 5], ["2025-09-12", 4]))?.athDate).toBe("2025-09-13");
  });
  it("skips a row whose price is not a positive number or whose day is not a day", () => {
    expect(parseSolscanHigh(prices([20250912, 0.2], [20250913, "9"], [20250914, -1], [20250915, 0], [20250916, null], [20250917, Number.NaN], ["soon", 7]))).toEqual({ ath: 0.2, athDate: "2025-09-12" });
  });
  it.each([[null], [undefined], [{}], [{ success: false, data: [] }], [{ success: true }], [{ success: true, data: "x" }], [{ success: true, data: [] }], [prices([20250912, 0])], ["text"], [42]])("is null for %j", (raw) => {
    expect(parseSolscanHigh(raw)).toBeNull();
  });
  it("does not take a lone spike for a price: a day ten times above BOTH its neighbours counts as the higher neighbour", () => {
    expect(parseSolscanHigh(prices([20250910, 1], [20250911, 1.2], [20250912, 500], [20250913, 1.1]))?.ath).toBe(1.2);
  });
  it("keeps a high that the days around it confirm, however sharp the fall afterwards", () => {
    expect(parseSolscanHigh(prices([20250910, 1], [20250911, 500], [20250912, 480], [20250913, 2]))).toEqual({ ath: 500, athDate: "2025-09-11" });
    expect(parseSolscanHigh(prices([20250910, 1], [20250911, 40], [20250912, 5]))?.ath).toBe(40); // 40 is above its next day by 8 times only
  });
  it("a single row is its own high", () => {
    expect(parseSolscanHigh(prices([20250910, 3]))?.ath).toBe(3);
  });
});

describe("solscanSpan: how much history Solscan gave", () => {
  it("counts the rows and names the first and the last day, whatever the order", () => {
    expect(solscanSpan(prices([20250914, 3], [20250912, 4], [20250913, 5]))).toEqual({ rows: 3, firstDay: "2025-09-12", lastDay: "2025-09-14" });
  });
  it.each([[null], [{}], [{ data: "x" }], [{ data: [] }]])("is empty for %j", (raw) => {
    expect(solscanSpan(raw)).toEqual({ rows: 0, firstDay: null, lastDay: null });
  });
});

describe("the request and the fall", () => {
  it("asks for the daily prices of the mint, from 2021 to the given day", () => {
    expect(solscanPriceEndpoint(MINT, "20261016")).toBe(`/token/price?address=${MINT}&from_time=20210101&to_time=20261016`);
  });
  it("keeps a preview deployment's entries apart from production's", () => {
    expect(athKey(MINT)).toBe(`antares:ath:${MINT}`);
    process.env.VERCEL_ENV = "preview";
    expect(athKey(MINT)).not.toBe(`antares:ath:${MINT}`);
    expect(athKey(MINT).endsWith(MINT)).toBe(true);
  });
  it("athDropPct: how far under the high, 0 at or above it, null when a number is not a positive finite number", () => {
    expect(athDropPct(HIGH, 0.037)).toBeCloseTo(90, 6);
    expect(athDropPct(HIGH, 0.5)).toBe(0);
    for (const bad of [null, undefined, 0, -1, Number.NaN, Infinity]) expect(athDropPct(HIGH, bad)).toBeNull();
    expect(athDropPct(null, 1)).toBeNull();
    expect(athDropPct({ ath: 0, athDate: null }, 1)).toBeNull();
  });
});

describe("getAllTimeHigh", () => {
  it("asks Solscan once, keeps the answer for a day, and serves the next ask from Redis", async () => {
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].opts).toEqual({ ex: ATH_TTL_S });
    expect(setCalls[0].value).toEqual({ known: true, ath: 0.37, athDate: "2025-09-13" });
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1); // not asked again
  });
  it("sends the key in the header Solscan wants, asks without a retry and with a short timeout: it must never slow a scan", async () => {
    await getAllTimeHigh(MINT);
    const [url, init, ms, retries] = fetchJson.mock.calls[0];
    expect(url).toMatch(/^https:\/\/pro-api\.solscan\.io\/v2\.0\/token\/price\?address=CARDS/);
    expect(url).toContain("from_time=20210101");
    expect(url).toMatch(/to_time=\d{8}$/);
    expect((init as { headers: Record<string, string> }).headers.token).toBe("test-key-not-real");
    expect(ms).toBeLessThanOrEqual(3000);
    expect(retries).toBe(0);
  });
  it.each([
    ["no price for this token (200 without a row)", { body: { success: true, data: [] }, status: 200 }],
    ["a token it does not know (404)", { body: { success: false }, status: 404 }],
    ["a request it refuses (400)", { body: { success: false }, status: 400 }],
  ])("%s: an ANSWER, no high, no failure, remembered for 6 hours and not asked again", async (_name, a) => {
    answer = a;
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
    expect(setCalls[0].opts).toEqual({ ex: ATH_NOT_LISTED_TTL_S });
    expect(setCalls[0].value).toEqual({ known: false, ath: null, athDate: null });
    expect(setCalls.some((c) => c.key === athBackoffKey())).toBe(false); // an answer is not a reason to stop asking
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it.each([[429], [500], [503], [0]])("a refusal or a failure (%i) is a FAILURE: no high, nothing kept for the token, a one-minute pause for everybody, and once it is over it is asked again", async (status) => {
    answer = { body: null, status };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    expect(setCalls.filter((c) => c.key === athKey(MINT))).toHaveLength(0);
    expect(setCalls.find((c) => c.key === athBackoffKey())?.opts).toEqual({ ex: ATH_BACKOFF_S });
    fetchJson.mockClear();
    expect(await getAllTimeHigh(OTHER)).toEqual({ high: null, failed: true }); // another token during the pause: no request
    expect(fetchJson).not.toHaveBeenCalled();
    store.delete(athBackoffKey()); // the pause is over
    await getAllTimeHigh(MINT);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it.each([[401], [403]])("a key Solscan refuses (%i) is a failure with no pause of ours: fetchSolscan stops asking for ten minutes by itself", async (status) => {
    answer = { body: null, status };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    expect(setCalls.some((c) => c.key === athBackoffKey())).toBe(false);
    fetchJson.mockClear();
    expect(await getAllTimeHigh(OTHER)).toEqual({ high: null, failed: true });
    expect(fetchJson).not.toHaveBeenCalled();
  });
  it("no key in this environment: nobody to ask, no request, a failure (the verdict is the one of before)", async () => {
    delete process.env.SOLSCAN_API_KEY;
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    expect(fetchJson).not.toHaveBeenCalled();
  });
  it("a 200 whose body cannot be read (the transport gave nothing) is an answer without a price, not a failure", async () => {
    answer = { body: null, status: 200 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
  });
  it("a value in Redis that is not what was written is not read: Solscan is asked", async () => {
    store.set(athKey(MINT), { known: true, ath: "x" });
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it("Redis missing: the scan goes on (Solscan is asked, nothing is kept)", async () => {
    redis = null;
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
  it("Redis failing on read and on write: the answer is still the high", async () => {
    redis = { get: vi.fn(async () => { throw new Error("redis down"); }), set: vi.fn(async () => { throw new Error("redis down"); }) };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
  });
});

describe("judgeHistory: a line with a memory (in at 89 %, out only below 84 %)", () => {
  it("with no memory it is the plain line: 88.9 % is clean, 89 % is collapsed, an unknown fall is unknown", async () => {
    expect(await judgeHistory(MINT, 88.9)).toBe(false);
    store.clear();
    expect(await judgeHistory(MINT, 89)).toBe(true);
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
    expect(await judgeHistory(MINT, 88.2)).toBe(false); // RAY today (-89.2 by an intraday high, about -88.2 by a daily one)
    expect(await judgeHistory(MINT, 87.0)).toBe(false);
    expect(await judgeHistory(MINT, 89.1)).toBe(true);  // it crossed
  });
  it("a token that has collapsed stays collapsed for every fall down to 84 %: it needs a rally of a third of its price from the line to be clean again", async () => {
    expect(await judgeHistory(MINT, 89.4)).toBe(true); // YZY today
    for (const drop of [88.9, 88.0, 86.0, 85.0, 84.0]) expect(await judgeHistory(MINT, drop), `at ${drop} %`).toBe(true);
    expect(await judgeHistory(MINT, 83.9)).toBe(false);
    expect(await judgeHistory(MINT, 88.9)).toBe(false); // clean again: the line is the plain one from this side
  });
  it("the memory of one token is not the memory of another", async () => {
    await judgeHistory(MINT, 95);
    expect(await judgeHistory(OTHER, 88)).toBe(false);
  });
  it("Redis missing or failing: the plain line, and the scan goes on", async () => {
    redis = null;
    expect(await judgeHistory(MINT, 88.9)).toBe(false);
    expect(await judgeHistory(MINT, 89)).toBe(true);
    redis = { get: vi.fn(async () => { throw new Error("redis down"); }), set: vi.fn(async () => { throw new Error("redis down"); }) };
    expect(await judgeHistory(MINT, 91)).toBe(true);
    expect(await judgeHistory(MINT, 80)).toBe(false);
  });
});
