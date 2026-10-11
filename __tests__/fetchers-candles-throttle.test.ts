import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── fetchDexCandlesDaily under a GeckoTerminal rate limit (audit M11) ───────────────────────────────────────────────
// A scan used to make up to six GeckoTerminal calls in a row, all refused with 429, which prolonged the throttling for everyone
// sharing the address. Once GeckoTerminal has refused (429/503, the retry included), the rest of the scan's calls are not made.
// fetchJson is faked here: the real one adds a 500 ms backoff per retry and a per-host circuit breaker, neither of which is under test.

const mockFetchJson = vi.fn();
vi.mock("../api/_lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/_lib/http")>()),
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

const { fetchDexCandlesDaily } = await import("../api/_lib/fetchers");

const POOL = "PoolAddressFromDexScreener1111111111111111111";
const MINT = "So11111111111111111111111111111111111111112";

const ohlcv = (n: number) => ({ data: { attributes: { ohlcv_list: Array.from({ length: n }, (_, i) => [1_700_000_000 + i * 14_400, 1, 2, 0.5, 1.5, 100]) } } });
const poolList = (...volumes: number[]) => ({ data: volumes.map((v, i) => ({ attributes: { address: `GtPool${i + 1}`, volume_usd: { h24: String(v) } } })) });

type Reply = { status: number[]; body: unknown };
/** Answers by URL; `status` is what onStatus receives, in order (a 429 followed by a 200 is a retry that worked). */
function answer(routes: Array<[RegExp, Reply]>) {
  mockFetchJson.mockImplementation(async (url: string, _init: unknown, _ms: number, _retries: number, onStatus?: (s: number) => void) => {
    const route = routes.find(([re]) => re.test(url));
    if (!route) throw new Error(`unexpected call: ${url}`);
    for (const s of route[1].status) onStatus?.(s);
    return route[1].body;
  });
}
const urls = () => mockFetchJson.mock.calls.map((c) => String(c[0]));

beforeEach(() => { mockFetchJson.mockReset(); });

describe("fetchDexCandlesDaily: stop asking once GeckoTerminal has refused", () => {
  it.each([429, 503])("a refused first call (%i, and the retry refused too) ends the scan's GeckoTerminal calls: no pool list, no more pools", async (code) => {
    answer([
      [/\/pools\/PoolAddressFromDexScreener.*ohlcv/, { status: [code, code], body: null }],
      [/\/tokens\/.*\/pools/, { status: [200], body: poolList(900, 500, 100) }],
      [/\/pools\/GtPool.*ohlcv/, { status: [200], body: ohlcv(40) }],
    ]);

    const candles = await fetchDexCandlesDaily(POOL, MINT);

    expect(candles).toEqual([]);
    expect(urls()).toHaveLength(1);
  });

  it("a refusal on the first fallback pool stops the loop: the other two pools are not asked", async () => {
    answer([
      [/\/pools\/PoolAddressFromDexScreener.*ohlcv/, { status: [200], body: ohlcv(0) }],
      [/\/tokens\/.*\/pools/, { status: [200], body: poolList(900, 500, 100) }],
      [/\/pools\/GtPool1.*ohlcv/, { status: [429, 429], body: null }],
      [/\/pools\/GtPool[23].*ohlcv/, { status: [200], body: ohlcv(40) }],
    ]);

    const candles = await fetchDexCandlesDaily(POOL, MINT);

    expect(candles).toEqual([]);
    expect(urls()).toHaveLength(3); // the direct pool, the pool list, the first (busiest) pool
    expect(urls().some((u) => /GtPool[23]/.test(u))).toBe(false);
  });

  it("a 429 that the retry recovered is not a refusal: the scan goes on to the fallback", async () => {
    answer([
      [/\/pools\/PoolAddressFromDexScreener.*ohlcv/, { status: [429, 200], body: ohlcv(0) }], // recovered, but the pool has no candles
      [/\/tokens\/.*\/pools/, { status: [200], body: poolList(900) }],
      [/\/pools\/GtPool1.*ohlcv/, { status: [200], body: ohlcv(40) }],
    ]);

    const candles = await fetchDexCandlesDaily(POOL, MINT);

    expect(candles).toHaveLength(40);
    expect(urls()).toHaveLength(3);
  });

  it("witness: with no refusal, an unindexed pool falls back to the busiest pool of the token and uses its candles", async () => {
    answer([
      [/\/pools\/PoolAddressFromDexScreener.*ohlcv/, { status: [200], body: ohlcv(0) }],
      [/\/tokens\/.*\/pools/, { status: [200], body: poolList(100, 900, 500) }],
      [/\/pools\/GtPool2.*ohlcv/, { status: [200], body: ohlcv(40) }],
    ]);

    const candles = await fetchDexCandlesDaily(POOL, MINT);

    expect(candles).toHaveLength(40);
    expect(urls()[2]).toMatch(/GtPool2/); // 900 $ of volume: the busiest
  });

  it("witness: the direct pool answering with candles needs no other call", async () => {
    answer([[/\/pools\/PoolAddressFromDexScreener.*ohlcv/, { status: [200], body: ohlcv(40) }]]);

    const candles = await fetchDexCandlesDaily(POOL, MINT);

    expect(candles).toHaveLength(40);
    expect(urls()).toHaveLength(1);
  });
});
