// __tests__/goplus-cache.test.ts
//
// GoPlus' free tier answers about 30 authenticated calls a minute: a scan costs one call, and a token that is looked at often is scanned cold every
// few minutes. Its answer (the LP burn, the holder count, the structure of the mint) moves slowly once the token is not new, so it is reused for as
// long as the token's AGE allows: never under a day or when the age is unknown (an LP can be burned minutes after a launch), 5 minutes under a week,
// 30 minutes after. Only a complete code-1 answer is kept; Redis failing changes nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetchGoPlus = vi.fn();
vi.mock("../api/_lib/goplus-auth", () => ({ fetchGoPlusSecurity: (...a: unknown[]) => mockFetchGoPlus(...a) }));
let mockRedis: unknown = null;
vi.mock("../api/_lib/cache", () => ({ getCacheRedis: () => mockRedis }));

const { goplusCacheTtlSeconds, fetchGoPlusSecurityCached, goplusCacheKey } = await import("../api/_lib/goplus-cache");

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DAY = 1440;
const complete = { code: 1, message: "OK", result: { [MINT]: { holder_count: "4100", dex: [{ burn_percent: 100, tvl: "500000" }] } } };

/** A Redis with the three calls the cache uses; `store` is what it holds. */
function fakeRedis(over: { get?: (k: string) => unknown; set?: (k: string, v: unknown, o: { ex: number }) => unknown } = {}) {
  const store = new Map<string, unknown>();
  const redis = {
    store,
    get: vi.fn(async (k: string) => (over.get ? over.get(k) : store.get(k) ?? null)),
    set: vi.fn((k: string, v: unknown, o: { ex: number }) => { if (over.set) return over.set(k, v, o); store.set(k, v); return Promise.resolve("OK"); }),
  };
  return redis;
}

beforeEach(() => { mockFetchGoPlus.mockReset(); mockFetchGoPlus.mockResolvedValue(complete); mockRedis = null; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("goplusCacheTtlSeconds: by the age of the token", () => {
  it("never for a token under a day old, or whose age is not known", () => {
    for (const age of [null, 0, 5, 59, 600, DAY - 1]) expect(goplusCacheTtlSeconds(age), String(age)).toBe(0);
    for (const age of [-1, Number.NaN, Number.POSITIVE_INFINITY * -1]) expect(goplusCacheTtlSeconds(age)).toBe(0);
  });
  it("5 minutes from a day to a week, 30 minutes from a week", () => {
    expect(goplusCacheTtlSeconds(DAY)).toBe(300);
    expect(goplusCacheTtlSeconds(7 * DAY - 1)).toBe(300);
    expect(goplusCacheTtlSeconds(7 * DAY)).toBe(1800);
    expect(goplusCacheTtlSeconds(400 * DAY)).toBe(1800);
  });
});

describe("fetchGoPlusSecurityCached", () => {
  it("an established token: the first call asks GoPlus and keeps the answer 30 minutes, the next one does not ask", async () => {
    const redis = fakeRedis(); mockRedis = redis;
    expect(await fetchGoPlusSecurityCached(MINT, 90 * DAY)).toBe(complete);
    expect(mockFetchGoPlus).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(goplusCacheKey(MINT), complete, { ex: 1800 });
    expect(await fetchGoPlusSecurityCached(MINT, 90 * DAY)).toEqual(complete);
    expect(mockFetchGoPlus).toHaveBeenCalledTimes(1);
  });

  it("a token of a few days is kept 5 minutes", async () => {
    const redis = fakeRedis(); mockRedis = redis;
    await fetchGoPlusSecurityCached(MINT, 3 * DAY);
    expect(redis.set).toHaveBeenCalledWith(goplusCacheKey(MINT), complete, { ex: 300 });
  });

  it("a young token, or one of unknown age: GoPlus is asked every time and Redis is not touched (an LP can be burned minutes after a launch)", async () => {
    const redis = fakeRedis(); mockRedis = redis;
    for (const age of [10, 600, null]) { await fetchGoPlusSecurityCached(MINT, age); await fetchGoPlusSecurityCached(MINT, age); }
    expect(mockFetchGoPlus).toHaveBeenCalledTimes(6);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("another token does not read this one's answer", async () => {
    mockRedis = fakeRedis();
    await fetchGoPlusSecurityCached(MINT, 90 * DAY);
    await fetchGoPlusSecurityCached("So11111111111111111111111111111111111111112", 90 * DAY);
    expect(mockFetchGoPlus).toHaveBeenCalledTimes(2);
  });

  it("only a complete answer is kept: a rate limit (4029), an error, an empty result or nothing are asked again next time", async () => {
    for (const raw of [{ code: 4029, message: "too many requests" }, { code: 1, result: {} }, { code: 0, result: { [MINT]: {} } }, null, "nope", { result: { [MINT]: {} } }]) {
      const redis = fakeRedis(); mockRedis = redis; mockFetchGoPlus.mockReset(); mockFetchGoPlus.mockResolvedValue(raw);
      await fetchGoPlusSecurityCached(MINT, 90 * DAY);
      await fetchGoPlusSecurityCached(MINT, 90 * DAY);
      expect(redis.set, JSON.stringify(raw)).not.toHaveBeenCalled();
      expect(mockFetchGoPlus, JSON.stringify(raw)).toHaveBeenCalledTimes(2);
    }
  });

  it("a kept entry that is not a complete answer (corrupted, or an old shape) is ignored: GoPlus is asked", async () => {
    const redis = fakeRedis(); mockRedis = redis;
    redis.store.set(goplusCacheKey(MINT), { code: 4029 });
    expect(await fetchGoPlusSecurityCached(MINT, 90 * DAY)).toBe(complete);
    expect(mockFetchGoPlus).toHaveBeenCalledTimes(1);
  });

  it("the manual refresh (fresh) skips the read and still keeps the new answer", async () => {
    const redis = fakeRedis(); mockRedis = redis;
    redis.store.set(goplusCacheKey(MINT), { code: 1, result: { [MINT]: { holder_count: "1" } } });
    const newer = { code: 1, result: { [MINT]: { holder_count: "9999" } } };
    mockFetchGoPlus.mockResolvedValue(newer);
    expect(await fetchGoPlusSecurityCached(MINT, 90 * DAY, { fresh: true })).toBe(newer);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(goplusCacheKey(MINT), newer, { ex: 1800 });
  });

  it("Redis failing (read, write, or both) changes nothing: the answer comes from GoPlus and nothing throws", async () => {
    mockRedis = fakeRedis({ get: () => { throw new Error("redis down"); }, set: () => { throw new Error("redis down"); } });
    expect(await fetchGoPlusSecurityCached(MINT, 90 * DAY)).toBe(complete);
    mockRedis = fakeRedis({ set: () => Promise.reject(new Error("write refused")) });
    expect(await fetchGoPlusSecurityCached(MINT, 90 * DAY)).toBe(complete);
    mockRedis = { get: vi.fn().mockRejectedValue(new Error("timeout")) }; // no set at all
    expect(await fetchGoPlusSecurityCached(MINT, 90 * DAY)).toBe(complete);
  });

  it("no Redis configured: GoPlus is asked every time", async () => {
    mockRedis = null;
    await fetchGoPlusSecurityCached(MINT, 90 * DAY);
    await fetchGoPlusSecurityCached(MINT, 90 * DAY);
    expect(mockFetchGoPlus).toHaveBeenCalledTimes(2);
  });

  it("a preview deployment keeps its own entries (the key is namespaced), production's key is plain", () => {
    expect(goplusCacheKey(MINT)).toBe(`antares:goplus:${MINT}`);
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_abc123");
    expect(goplusCacheKey(MINT)).toBe(`antares:goplus:pv:dpl_abc123:${MINT}`);
  });
});
