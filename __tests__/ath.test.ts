// __tests__/ath.test.ts
//
// The all-time high of a token (api/_lib/ath.ts): Solscan Pro first, CoinGecko when Solscan has nothing. It is a help, never a requirement: whatever goes wrong, the answer is null
// (no relief), never a wrong number.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

const store = new Map<string, unknown>();
const setCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];
let redis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } | null;
vi.mock("../api/_lib/cache", () => ({ getCacheRedis: () => redis }));

// What CoinGecko answers (`answer`) and what Solscan answers (`solscanAnswer`); the mock routes by address.
let answer: { body: unknown; status: number } | "throws";
let solscanAnswer: { body: unknown; status: number };
const fetchJson = vi.fn(async (url: string, _init: unknown, _ms: number, _retries: number, onStatus?: (s: number) => void) => {
  const a = url.includes("pro-api.solscan.io") ? solscanAnswer : answer;
  if (a === "throws") throw new Error("network");
  onStatus?.(a.status);
  return a.status >= 200 && a.status < 300 ? a.body : null;
});
vi.mock("../api/_lib/http", () => ({ fetchJson: (...a: Parameters<typeof fetchJson>) => fetchJson(...a) }));

import { getAllTimeHigh, judgeHistory, athSideKey, parseAllTimeHigh, parseSolscanHigh, solscanSpan, isInDoubt, athKey, athBackoffKey, athSolscanBackoffKey, athUrl, solscanPriceEndpoint, ATH_TTL_S, ATH_NOT_LISTED_TTL_S, ATH_BACKOFF_S, ATH_SIDE_TTL_S } from "../api/_lib/ath";
import { _resetSolscanBackoffForTests } from "../api/_lib/fetchers";

const HIGH = { ath: 0.381443, athDate: "2025-09-14T08:27:34.512Z", source: "coingecko" };
const SOLSCAN_HIGH = { ath: 0.37, athDate: "2025-09-13", source: "solscan" };
/** What Solscan sends for token/price: one row a day. */
const prices = (...rows: Array<[number | string, unknown]>) => ({ success: true, data: rows.map(([date, price]) => ({ date, price })) });

const MINT = "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp";
const coin = (ath: unknown, date: unknown = "2025-09-14T08:27:34.512Z") => ({ id: "collector-crypt", market_data: { ath: { usd: ath }, ath_date: { usd: date } } });

beforeEach(() => {
  store.clear(); setCalls.length = 0; fetchJson.mockClear();
  redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown, opts: unknown) => { setCalls.push({ key: k, value: v, opts }); store.set(k, v); return "OK"; }),
  };
  answer = { body: coin(0.381443), status: 200 };
  solscanAnswer = { body: prices([20250912, 0.2], [20250913, 0.37], [20250914, 0.3], [20251020, 0.02]), status: 200 };
  delete process.env.VERCEL_ENV;
  delete process.env.SOLSCAN_API_KEY; // most of these tests are about CoinGecko alone: Solscan has its own block below
  _resetSolscanBackoffForTests();
});
afterEach(() => { delete process.env.VERCEL_ENV; delete process.env.SOLSCAN_API_KEY; _resetSolscanBackoffForTests(); });

describe("parseAllTimeHigh: only a positive USD price is a high", () => {
  it("reads the high and its date", () => {
    expect(parseAllTimeHigh(coin(0.381443))).toEqual({ ath: 0.381443, athDate: "2025-09-14T08:27:34.512Z", source: "coingecko" });
  });
  it("keeps the high when the date is missing or not a date", () => {
    expect(parseAllTimeHigh(coin(2, null))).toEqual({ ath: 2, athDate: null, source: "coingecko" });
    expect(parseAllTimeHigh(coin(2, "yesterday"))).toEqual({ ath: 2, athDate: null, source: "coingecko" });
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
    expect(setCalls[0].value).toEqual({ known: true, ath: 0.381443, athDate: "2025-09-14T08:27:34.512Z", source: "coingecko", checked: true });
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

describe("parseSolscanHigh: the highest daily price", () => {
  it("is the highest price of the series and its day", () => {
    expect(parseSolscanHigh(prices([20250912, 0.2], [20250913, 0.37], [20250914, 0.3]))).toEqual(SOLSCAN_HIGH);
  });
  it("reads the day as a number, as 8 digits of text or as an ISO date, and does not depend on the order of the rows", () => {
    expect(parseSolscanHigh(prices([20250914, 3], [20250913, 5], [20250912, 4]))?.athDate).toBe("2025-09-13");
    expect(parseSolscanHigh(prices(["20250913", 5], ["20250912", 4]))?.athDate).toBe("2025-09-13");
    expect(parseSolscanHigh(prices(["2025-09-13", 5], ["2025-09-12", 4]))?.athDate).toBe("2025-09-13");
  });
  it("skips a row whose price is not a positive number or whose day is not a day", () => {
    expect(parseSolscanHigh(prices([20250912, 0.2], [20250913, "9"], [20250914, -1], [20250915, 0], [20250916, null], [20250917, Number.NaN], ["soon", 7]))).toEqual({ ath: 0.2, athDate: "2025-09-12", source: "solscan" });
  });
  it.each([[null], [undefined], [{}], [{ success: false, data: [] }], [{ success: true }], [{ success: true, data: "x" }], [{ success: true, data: [] }], [prices([20250912, 0])], ["text"], [42]])("is null for %j", (raw) => {
    expect(parseSolscanHigh(raw)).toBeNull();
  });
  it("does not take a lone spike for a price: a day ten times above BOTH its neighbours counts as the higher neighbour", () => {
    expect(parseSolscanHigh(prices([20250910, 1], [20250911, 1.2], [20250912, 500], [20250913, 1.1]))?.ath).toBe(1.2);
  });
  it("keeps a high that the days around it confirm, however sharp the fall afterwards", () => {
    expect(parseSolscanHigh(prices([20250910, 1], [20250911, 500], [20250912, 480], [20250913, 2]))).toEqual({ ath: 500, athDate: "2025-09-11", source: "solscan" });
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

describe("the Solscan request", () => {
  it("asks for the daily prices of the mint, from 2021 to the given day", () => {
    expect(solscanPriceEndpoint(MINT, "20261016")).toBe(`/token/price?address=${MINT}&from_time=20210101&to_time=20261016`);
  });
});

describe("getAllTimeHigh: Solscan first, CoinGecko when Solscan has nothing", () => {
  const solscanCalls = () => fetchJson.mock.calls.filter((c) => c[0].includes("pro-api.solscan.io"));
  const coingeckoCalls = () => fetchJson.mock.calls.filter((c) => c[0].includes("coingecko.com"));
  beforeEach(() => { process.env.SOLSCAN_API_KEY = "test-key-not-real"; });

  it("takes the high from Solscan, never asks CoinGecko, and remembers who gave it", async () => {
    expect(await getAllTimeHigh(MINT)).toEqual({ high: SOLSCAN_HIGH, failed: false });
    expect(solscanCalls()).toHaveLength(1);
    expect(coingeckoCalls()).toHaveLength(0);
    expect(setCalls[0].value).toEqual({ known: true, ath: 0.37, athDate: "2025-09-13", source: "solscan", checked: false });
    expect(setCalls[0].opts).toEqual({ ex: ATH_TTL_S });
  });
  it("sends the key in the header Solscan wants, asks without a retry and with a short timeout: it must never slow a scan", async () => {
    await getAllTimeHigh(MINT);
    const [url, init, ms, retries] = solscanCalls()[0];
    expect(url).toMatch(/^https:\/\/pro-api\.solscan\.io\/v2\.0\/token\/price\?address=CARDS/);
    expect(url).toContain("from_time=20210101");
    expect(url).toMatch(/to_time=\d{8}$/);
    expect((init as { headers: Record<string, string> }).headers.token).toBe("test-key-not-real");
    expect(ms).toBeLessThanOrEqual(3000);
    expect(retries).toBe(0);
  });
  it("serves the next ask from Redis with the source it was kept with; what was kept before Solscan was asked is CoinGecko's", async () => {
    await getAllTimeHigh(MINT);
    fetchJson.mockClear();
    expect(await getAllTimeHigh(MINT)).toEqual({ high: SOLSCAN_HIGH, failed: false });
    expect(fetchJson).not.toHaveBeenCalled();
    store.set(athKey("Older111111111111111111111111111111111111111"), { known: true, ath: 5, athDate: "2024-03-01T00:00:00.000Z" });
    expect(await getAllTimeHigh("Older111111111111111111111111111111111111111")).toEqual({ high: { ath: 5, athDate: "2024-03-01T00:00:00.000Z", source: "coingecko" }, failed: false });
  });
  it.each([
    ["no price for this token (200 without a row)", { body: { success: true, data: [] }, status: 200 }],
    ["a token it does not know (404)", { body: { success: false }, status: 404 }],
    ["a request it refuses (400)", { body: { success: false }, status: 400 }],
  ])("%s: Solscan ANSWERED, CoinGecko is asked and gives the high", async (_name, a) => {
    solscanAnswer = a;
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(coingeckoCalls()).toHaveLength(1);
    expect(setCalls.some((c) => c.key === athSolscanBackoffKey())).toBe(false); // an answer is not a reason to stop asking
    expect((setCalls.find((c) => c.key === athKey(MINT))?.value as { source: string }).source).toBe("coingecko");
  });
  it.each([[500], [503], [429], [0]])("Solscan failing (%i): CoinGecko gives the high, and nobody asks Solscan for a minute", async (status) => {
    solscanAnswer = { body: null, status };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(setCalls.find((c) => c.key === athSolscanBackoffKey())?.opts).toEqual({ ex: ATH_BACKOFF_S });
    expect(setCalls.some((c) => c.key === athBackoffKey())).toBe(false); // CoinGecko did answer: it is not paused
    fetchJson.mockClear();
    await getAllTimeHigh("OtherMint1111111111111111111111111111111111");
    expect(solscanCalls()).toHaveLength(0);
    expect(coingeckoCalls()).toHaveLength(1);
  });
  it.each([[401], [403]])("a key Solscan refuses (%i) is CoinGecko's job from then on, and fetchSolscan stops asking for ten minutes", async (status) => {
    solscanAnswer = { body: null, status };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(setCalls.some((c) => c.key === athSolscanBackoffKey())).toBe(false);
    fetchJson.mockClear();
    await getAllTimeHigh("OtherMint1111111111111111111111111111111111");
    expect(solscanCalls()).toHaveLength(0);
  });
  it("Solscan answered nothing AND CoinGecko does not know the token: an answer, remembered for 6 hours, not a failure", async () => {
    solscanAnswer = { body: { success: true, data: [] }, status: 200 };
    answer = { body: { error: "coin not found" }, status: 404 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
    expect(setCalls[0].opts).toEqual({ ex: ATH_NOT_LISTED_TTL_S });
    fetchJson.mockClear();
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: false });
    expect(fetchJson).not.toHaveBeenCalled();
  });
  it("Solscan SILENT and CoinGecko not knowing the token is NOT an answer: Solscan may know it. A failure, and nothing is remembered about the token", async () => {
    solscanAnswer = { body: null, status: 503 };
    answer = { body: { error: "coin not found" }, status: 404 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    expect(setCalls.some((c) => c.key === athKey(MINT))).toBe(false);
  });
  it("Solscan answering nothing and CoinGecko failing: a failure, with CoinGecko's own pause", async () => {
    solscanAnswer = { body: { success: true, data: [] }, status: 200 };
    answer = { body: null, status: 429 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    expect(setCalls.some((c) => c.key === athBackoffKey())).toBe(true);
    expect(setCalls.some((c) => c.key === athKey(MINT))).toBe(false);
  });
  it("both silent: no high, a failure, both pauses set, and the next token reaches neither", async () => {
    solscanAnswer = { body: null, status: 503 };
    answer = { body: null, status: 503 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: null, failed: true });
    fetchJson.mockClear();
    expect(await getAllTimeHigh("OtherMint1111111111111111111111111111111111")).toEqual({ high: null, failed: true });
    expect(fetchJson).not.toHaveBeenCalled();
  });
  it("a Solscan answer that is not what it should be (a body with no list) is an answer of nothing: CoinGecko is asked", async () => {
    solscanAnswer = { body: { success: true, data: { price: 1 } }, status: 200 };
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
  });
  it("no key in this environment: Solscan is not asked at all, and the result is what CoinGecko alone gave", async () => {
    delete process.env.SOLSCAN_API_KEY;
    expect(await getAllTimeHigh(MINT)).toEqual({ high: HIGH, failed: false });
    expect(solscanCalls()).toHaveLength(0);
  });
  it("Redis missing: Solscan still gives the high", async () => {
    redis = null;
    expect(await getAllTimeHigh(MINT)).toEqual({ high: SOLSCAN_HIGH, failed: false });
  });

  describe("a daily high cannot place a token within reach of the line: CoinGecko's intraday high is asked too", () => {
    // Solscan's high is 0.37: a price of 0.0481 is 87 % under it, 0.185 is 50 % under, 0.0333 is 91 % under.
    const IN_DOUBT = 0.0481, FAR_ABOVE = 0.185, FAR_BELOW = 0.0333;
    const stored = () => store.get(athKey(MINT)) as { ath: number; source: string; checked?: boolean };
    it("between 80 % and the line, CoinGecko is asked and its higher high is the high (the intraday side of the line, where the rule is written)", async () => {
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: HIGH, failed: false });
      expect(solscanCalls()).toHaveLength(1);
      expect(coingeckoCalls()).toHaveLength(1);
      expect(stored()).toMatchObject({ ath: 0.381443, source: "coingecko", checked: true });
    });
    it("when CoinGecko's high is NOT higher, the daily high stays, and the check is remembered: nobody asks again", async () => {
      answer = { body: coin(0.3), status: 200 };
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: SOLSCAN_HIGH, failed: false });
      expect(stored()).toMatchObject({ ath: 0.37, source: "solscan", checked: true });
      fetchJson.mockClear();
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: SOLSCAN_HIGH, failed: false });
      expect(fetchJson).not.toHaveBeenCalled();
    });
    it.each([[FAR_ABOVE, "50 % under its high"], [FAR_BELOW, "91 % under its high (over the line: an intraday high can only make it more so)"], [0.37, "at its high"]])("outside the band (%s: %s) CoinGecko is not asked", async (price) => {
      expect(await getAllTimeHigh(MINT, price)).toEqual({ high: SOLSCAN_HIGH, failed: false });
      expect(coingeckoCalls()).toHaveLength(0);
    });
    it("the band is [80 %, 90 %): 80 is in, 79.9 and 90 are out", async () => {
      expect(isInDoubt(80)).toBe(true);
      expect(isInDoubt(89.99)).toBe(true);
      for (const out of [79.9, 90, 99, 0, null, undefined, Number.NaN]) expect(isInDoubt(out), String(out)).toBe(false);
    });
    it("no price, no check", async () => {
      expect(await getAllTimeHigh(MINT)).toEqual({ high: SOLSCAN_HIGH, failed: false });
      expect(await getAllTimeHigh("OtherMint1111111111111111111111111111111111", null)).toEqual({ high: SOLSCAN_HIGH, failed: false });
      expect(coingeckoCalls()).toHaveLength(0);
    });
    it("CoinGecko does not know the token (404): the daily high is all there is, it is not a failure, and it is not asked again", async () => {
      answer = { body: { error: "coin not found" }, status: 404 };
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: SOLSCAN_HIGH, failed: false });
      expect(stored()).toMatchObject({ source: "solscan", checked: true });
      fetchJson.mockClear();
      await getAllTimeHigh(MINT, IN_DOUBT);
      expect(fetchJson).not.toHaveBeenCalled();
    });
    it("CoinGecko cannot be had: the daily high is returned with `failed` (the side of the line is not certain), it is not checked, and it is checked the next time CoinGecko answers", async () => {
      answer = { body: null, status: 503 };
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: SOLSCAN_HIGH, failed: true });
      expect(stored()).toMatchObject({ source: "solscan", checked: false });
      answer = { body: coin(0.381443), status: 200 };
      store.delete(athBackoffKey()); // the pause is over
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: HIGH, failed: false });
      expect(stored()).toMatchObject({ source: "coingecko", checked: true });
      expect(solscanCalls()).toHaveLength(1); // the daily high was kept: Solscan is not asked again
    });
    it("a daily high kept before the token came near the line is checked the day it does, and not before", async () => {
      await getAllTimeHigh(MINT, FAR_ABOVE);
      expect(stored().checked).toBe(false);
      expect(coingeckoCalls()).toHaveLength(0);
      expect(await getAllTimeHigh(MINT, FAR_ABOVE)).toEqual({ high: SOLSCAN_HIGH, failed: false });
      expect(coingeckoCalls()).toHaveLength(0);
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: HIGH, failed: false });
      expect(coingeckoCalls()).toHaveLength(1);
      expect(solscanCalls()).toHaveLength(1);
      expect(stored()).toMatchObject({ source: "coingecko", checked: true });
    });
    it("a number that is CoinGecko's own is never checked again", async () => {
      store.set(athKey(MINT), { known: true, ath: 0.381443, athDate: "2025-09-14T08:27:34.512Z", source: "coingecko" });
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: HIGH, failed: false });
      expect(fetchJson).not.toHaveBeenCalled();
    });
    it("with no Solscan key the number is CoinGecko's and it is never asked twice", async () => {
      delete process.env.SOLSCAN_API_KEY;
      expect(await getAllTimeHigh(MINT, IN_DOUBT)).toEqual({ high: HIGH, failed: false });
      expect(coingeckoCalls()).toHaveLength(1);
    });

    describe("when the high DECIDES the verdict (a relief, a softening): a daily number can say 'collapsed', never 'clean'", () => {
      // A launch that spiked and dumped within hours (YZY: -90.2 % by the intraday high) can have a daily high far under it, and so stand 50 % under its daily high.
      it("a token that does not stand over the line by the daily high is checked with CoinGecko wherever it stands, and the intraday high is the high", async () => {
        expect(await getAllTimeHigh(MINT, FAR_ABOVE, true)).toEqual({ high: HIGH, failed: false });
        expect(coingeckoCalls()).toHaveLength(1);
        expect(stored()).toMatchObject({ source: "coingecko", checked: true });
      });
      it("a daily high that is not under the intraday one stays, and the check is made once", async () => {
        answer = { body: coin(0.2), status: 200 };
        expect(await getAllTimeHigh(MINT, FAR_ABOVE, true)).toEqual({ high: SOLSCAN_HIGH, failed: false });
        fetchJson.mockClear();
        expect(await getAllTimeHigh(MINT, FAR_ABOVE, true)).toEqual({ high: SOLSCAN_HIGH, failed: false });
        expect(fetchJson).not.toHaveBeenCalled();
      });
      it("over the line by the daily high it is collapsed whatever CoinGecko says (an intraday high is higher still): CoinGecko is not asked", async () => {
        expect(await getAllTimeHigh(MINT, FAR_BELOW, true)).toEqual({ high: SOLSCAN_HIGH, failed: false });
        expect(coingeckoCalls()).toHaveLength(0);
      });
      it("CoinGecko cannot be had: the daily high is WITHHELD (a relief is never granted on it), the scan says it is missing data, and the daily number is kept for the next check", async () => {
        answer = { body: null, status: 429 };
        expect(await getAllTimeHigh(MINT, FAR_ABOVE, true)).toEqual({ high: null, failed: true });
        expect(stored()).toMatchObject({ source: "solscan", checked: false });
        // the same token, over the line by its daily high, is not concerned: it is still given
        expect(await getAllTimeHigh("OtherMint1111111111111111111111111111111111", FAR_BELOW, true)).toEqual({ high: SOLSCAN_HIGH, failed: false });
        answer = { body: coin(0.381443), status: 200 };
        store.delete(athBackoffKey()); // the pause is over
        expect(await getAllTimeHigh(MINT, FAR_ABOVE, true)).toEqual({ high: HIGH, failed: false });
        expect(solscanCalls()).toHaveLength(2); // MINT once, the other token once: the kept daily high of MINT was not asked for again
      });
      it("CoinGecko does not know the token (404): the daily high is all there is, it is given", async () => {
        answer = { body: { error: "coin not found" }, status: 404 };
        expect(await getAllTimeHigh(MINT, FAR_ABOVE, true)).toEqual({ high: SOLSCAN_HIGH, failed: false });
      });
      it("without a price there is no fall to judge, so nothing to check", async () => {
        expect(await getAllTimeHigh(MINT, null, true)).toEqual({ high: SOLSCAN_HIGH, failed: false });
        expect(coingeckoCalls()).toHaveLength(0);
      });
      it("a high that only adds a flag keeps the narrow rule: far from the line, CoinGecko is not asked", async () => {
        expect(await getAllTimeHigh(MINT, FAR_ABOVE, false)).toEqual({ high: SOLSCAN_HIGH, failed: false });
        expect(coingeckoCalls()).toHaveLength(0);
      });
    });
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
