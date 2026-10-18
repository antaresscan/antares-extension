import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// holders-memory.ts: the biggest holders of a token when Helius gives none (measured 2026-10-18: Helius answers the tokens with the most holders with
// "account index service overloaded" and an HTTP 200, about nine scans in ten). Its last list, kept about a day, and RugCheck's list.

const mocks = vi.hoisted(() => ({ redis: null as null | { store: Map<string, unknown>; get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } }));
vi.mock("../api/_lib/cache", () => ({ getCacheRedis: () => mocks.redis }));

const {
  rememberHolders, lastKnownHolders, holdersFromRugCheck, holdersLastKey, rugCheckListMayStandIn,
  HOLDERS_KEEP_S, HOLDERS_STALE_MAX_S, HOLDERS_STALE_MIN_AGE_MIN, HOLDERS_FRESH_S,
} = await import("../api/_lib/holders-memory");

const MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
const DAY = 1440;
const holder = (n: number, uiAmount: number) => ({ address: `acct${n}`, owner: `owner${n}`, uiAmount });
const LIST = [holder(1, 718_132_063), holder(2, 50_958_875), holder(3, 12_000_000)];

function fakeRedis() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k) : null)),
    set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); return "OK"; }),
  };
}

beforeEach(() => { mocks.redis = fakeRedis(); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("the last list Helius gave", () => {
  it("is kept with its time, for three days, under a key of its own", async () => {
    await rememberHolders(MINT, LIST);
    const redis = mocks.redis!;
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, value, opts] = redis.set.mock.calls[0] as [string, { holders: unknown[]; at: number }, { ex: number }];
    expect(key).toBe(holdersLastKey(MINT));
    expect(key).toBe(`antares:holders-last:${MINT}`);
    expect(value.holders).toHaveLength(3);
    expect(typeof value.at).toBe("number");
    expect(opts).toEqual({ ex: HOLDERS_KEEP_S });
    expect(HOLDERS_KEEP_S).toBeGreaterThan(HOLDERS_STALE_MAX_S);
  });

  it("is served for a token that is not new, while it is less than a day old", async () => {
    await rememberHolders(MINT, LIST);
    const kept = mocks.redis!.store.get(holdersLastKey(MINT)) as { at: number };
    const got = await lastKnownHolders(MINT, 400 * DAY, kept.at + 3 * 3600 * 1000);
    expect(got!.holders).toHaveLength(3);
    expect(got!.holders[0].uiAmount).toBe(718_132_063);
    expect(got!.ageS).toBe(3 * 3600);
  });

  it("says how old it is, so that a list under half an hour old can be used without asking Helius again", async () => {
    await rememberHolders(MINT, LIST);
    const kept = mocks.redis!.store.get(holdersLastKey(MINT)) as { at: number };
    expect((await lastKnownHolders(MINT, 400 * DAY, kept.at + 90_000))!.ageS).toBe(90);
    expect(HOLDERS_FRESH_S).toBe(30 * 60);
    expect(HOLDERS_FRESH_S).toBeLessThan(HOLDERS_STALE_MAX_S);
  });

  it("is not served past a day (an old list is no longer a picture of today)", async () => {
    await rememberHolders(MINT, LIST);
    const kept = mocks.redis!.store.get(holdersLastKey(MINT)) as { at: number };
    expect(await lastKnownHolders(MINT, 400 * DAY, kept.at + (HOLDERS_STALE_MAX_S + 1) * 1000)).toBeNull();
    expect(await lastKnownHolders(MINT, 400 * DAY, kept.at + HOLDERS_STALE_MAX_S * 1000)).not.toBeNull();
  });

  it.each([
    ["a token of a few hours", 5 * 60],
    ["a token just under three days", HOLDERS_STALE_MIN_AGE_MIN - 1],
    ["a token whose age is unknown", null],
    ["a token whose age is not a number", Number.NaN],
  ])("is never served for %s (its holders change in minutes: the layer saying 'unverified' is the honest answer)", async (_name, age) => {
    await rememberHolders(MINT, LIST);
    expect(await lastKnownHolders(MINT, age as number | null)).toBeNull();
  });

  it("is served for a token of exactly three days", async () => {
    await rememberHolders(MINT, LIST);
    expect(await lastKnownHolders(MINT, HOLDERS_STALE_MIN_AGE_MIN)).not.toBeNull();
  });

  it("an empty list is not kept, and a list with an unusable entry loses that entry only when read", async () => {
    await rememberHolders(MINT, []);
    expect(mocks.redis!.set).not.toHaveBeenCalled();
    mocks.redis!.store.set(holdersLastKey(MINT), { at: Date.now(), holders: [holder(1, 5), { address: "", uiAmount: 3 }, { address: "x", uiAmount: -1 }, null] });
    const got = await lastKnownHolders(MINT, 400 * DAY);
    expect(got!.holders).toEqual([holder(1, 5)]);
  });

  it.each([
    ["nothing kept", null],
    ["something that is not an object", "oops"],
    ["no time", { holders: [holder(1, 1)] }],
    ["no list", { at: Date.now() }],
    ["a list with nothing usable", { at: Date.now(), holders: [{ address: "" }] }],
    ["a time in the future (a clock that is wrong: not trusted)", { at: Date.now() + 3_600_000, holders: [holder(1, 1)] }],
  ])("reads %s as no list", async (_name, kept) => {
    mocks.redis!.store.set(holdersLastKey(MINT), kept);
    expect(await lastKnownHolders(MINT, 400 * DAY)).toBeNull();
  });

  it("never stops a scan: Redis missing, or failing, is no list and no exception", async () => {
    mocks.redis = null;
    await expect(rememberHolders(MINT, LIST)).resolves.toBeUndefined();
    expect(await lastKnownHolders(MINT, 400 * DAY)).toBeNull();
    mocks.redis = { store: new Map(), get: vi.fn(async () => { throw new Error("ECONNRESET"); }), set: vi.fn(async () => { throw new Error("ECONNRESET"); }) };
    await expect(rememberHolders(MINT, LIST)).resolves.toBeUndefined();
    expect(await lastKnownHolders(MINT, 400 * DAY)).toBeNull();
  });

  it("a preview deployment keeps its own entries (never the production's)", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_abc123");
    expect(holdersLastKey(MINT)).toBe(`antares:holders-last:pv:dpl_abc123:${MINT}`);
  });
});

describe("may RugCheck's list stand in for Helius's?", () => {
  it("yes for a token that is not new whose pools DEXScreener gave", () => {
    expect(rugCheckListMayStandIn(400 * DAY, 3)).toBe(true);
    expect(rugCheckListMayStandIn(HOLDERS_STALE_MIN_AGE_MIN, 1)).toBe(true);
  });
  it.each([
    ["a new token (a launch's bonding curve is not a pool DEXScreener gives: its vault would be read as a whale)", HOLDERS_STALE_MIN_AGE_MIN - 1, 3],
    ["a token whose age is unknown", null, 3],
    ["a token whose age is not a number", Number.NaN, 3],
    ["a token whose pools are not known (DEXScreener did not answer: the vault of a pool would be read as a whale)", 400 * DAY, 0],
  ])("no for %s", (_name, age, pairs) => {
    expect(rugCheckListMayStandIn(age as number | null, pairs)).toBe(false);
  });
});

describe("the 20 biggest holders of the RugCheck report", () => {
  const rc = (n: number, uiAmount: unknown, owner: unknown = `owner${n}`) => ({ address: `acct${n}`, owner, uiAmount, pct: 1, amount: 1, decimals: 6, insider: false });

  it("become the list the Helius layer reads: token account, owner, amount, the biggest first", () => {
    const got = holdersFromRugCheck([rc(2, 50_958_875.834), rc(1, 718_132_063.712366), rc(3, 12_000_000)]);
    expect(got).toEqual([
      { address: "acct1", owner: "owner1", uiAmount: 718_132_063.712366 },
      { address: "acct2", owner: "owner2", uiAmount: 50_958_875.834 },
      { address: "acct3", owner: "owner3", uiAmount: 12_000_000 },
    ]);
  });

  it("an owner that is missing is the account itself, as the scan reads a list that has no owner", () => {
    expect(holdersFromRugCheck([rc(1, 5, null), rc(2, 4, "")])).toEqual([
      { address: "acct1", owner: "acct1", uiAmount: 5 },
      { address: "acct2", owner: "acct2", uiAmount: 4 },
    ]);
  });

  it("an amount that comes as a string is read as the number it is", () => {
    expect(holdersFromRugCheck([rc(1, "718132063.712366")])[0].uiAmount).toBe(718_132_063.712366);
  });

  it.each([
    ["absent", undefined],
    ["null (9 of the 1 117 recorded reports)", null],
    ["an empty list", []],
    ["not a list", { 0: rc(1, 1) }],
  ])("%s is no list", (_name, topHolders) => {
    expect(holdersFromRugCheck(topHolders)).toEqual([]);
  });

  it.each([
    ["an entry without an address", [rc(1, 5), { owner: "o", uiAmount: 4 }]],
    ["an entry whose amount is not a number", [rc(1, 5), rc(2, "lots")]],
    ["an entry whose amount is negative", [rc(1, 5), rc(2, -1)]],
    ["an entry that is null", [rc(1, 5), null]],
  ])("%s makes the whole list unusable: an incomplete list would be a wrong concentration", (_name, topHolders) => {
    expect(holdersFromRugCheck(topHolders)).toEqual([]);
  });
});
