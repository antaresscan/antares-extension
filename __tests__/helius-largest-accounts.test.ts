import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// heliusGetLargestAccounts / heliusGetLargestAccountsRemembered: Helius answers the tokens with the most holders (TRUMP, RAY, JUP, PENGU, BONK) with
// {"error":{"code":-32603,"message":"account index service overloaded, please try again."}} and an HTTP 200 about nine times in ten (measured 2026-10-18). That
// answer used to be returned as it was; the scan found no accounts in it and the whole Helius layer went missing.

const mocks = vi.hoisted(() => ({
  heliusRpc: vi.fn(),
  remember: vi.fn(async () => undefined),
  lastKnown: vi.fn(async () => null as unknown),
}));
vi.mock("../api/_lib/helius", () => ({ heliusRpc: mocks.heliusRpc, heliusRestUrl: () => "https://helius.test" }));
vi.mock("../api/_lib/holders-memory", () => ({ rememberHolders: mocks.remember, lastKnownHolders: mocks.lastKnown, HOLDERS_FRESH_S: 30 * 60 }));

const {
  heliusGetLargestAccounts, heliusGetLargestAccountsRemembered, isTransientRpcError,
  LARGEST_ACCOUNTS_ATTEMPTS, LARGEST_ACCOUNTS_RETRY_MS,
} = await import("../api/_lib/fetchers");

const MINT = "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN";
const OVERLOADED = { jsonrpc: "2.0", error: { code: -32603, message: "account index service overloaded, please try again." }, id: "holders" };
const GIVEN = { jsonrpc: "2.0", result: { context: { slot: 1 }, value: [{ address: "a1", uiAmount: 718_132_063 }, { address: "a2", uiAmount: 50_958_875 }] }, id: "holders" };

beforeEach(() => {
  vi.useFakeTimers();
  mocks.heliusRpc.mockReset();
  mocks.remember.mockClear();
  mocks.lastKnown.mockReset().mockResolvedValue(null);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Runs the call and lets the pauses between attempts go by. */
async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("isTransientRpcError", () => {
  it.each([
    ["Helius's own error", OVERLOADED, true],
    ["an internal error with another text", { error: { code: -32603, message: "boom" } }, true],
    ["a 'try again' without the code", { error: { code: -32000, message: "Node is busy, try again later" } }, true],
    ["an error that asking again does not change (bad params)", { error: { code: -32602, message: "Invalid param: not a Pubkey" } }, false],
    ["an answer that carries a result", { result: { value: [] }, error: { code: -32603, message: "x" } }, false],
    ["a list", GIVEN, false],
    ["nothing", null, false],
    ["a string", "overloaded", false],
  ])("%s", (_name, res, expected) => {
    expect(isTransientRpcError(res)).toBe(expected);
  });
});

describe("heliusGetLargestAccounts", () => {
  it("returns the list at once when Helius gives it (one request, no pause)", async () => {
    mocks.heliusRpc.mockResolvedValueOnce(GIVEN);
    expect(await run(heliusGetLargestAccounts(MINT, "key"))).toBe(GIVEN);
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1);
    expect(mocks.heliusRpc.mock.calls[0][1]).toMatchObject({ method: "getTokenLargestAccounts", params: [MINT] });
  });

  it("asks again after the transient error, and returns the list it then gets", async () => {
    mocks.heliusRpc.mockResolvedValueOnce(OVERLOADED).mockResolvedValueOnce(GIVEN);
    expect(await run(heliusGetLargestAccounts(MINT, "key"))).toBe(GIVEN);
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(LARGEST_ACCOUNTS_ATTEMPTS);
    expect(LARGEST_ACCOUNTS_ATTEMPTS).toBe(2);
  });

  it("waits between two attempts", async () => {
    mocks.heliusRpc.mockResolvedValueOnce(OVERLOADED).mockResolvedValueOnce(GIVEN);
    const p = heliusGetLargestAccounts(MINT, "key");
    await vi.advanceTimersByTimeAsync(LARGEST_ACCOUNTS_RETRY_MS - 1);
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(2);
    expect(await p).toBe(GIVEN);
  });

  it("gives null, not the error answer, when every attempt got the error (the scan then goes on to the next source)", async () => {
    mocks.heliusRpc.mockResolvedValue(OVERLOADED);
    expect(await run(heliusGetLargestAccounts(MINT, "key"))).toBeNull();
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(LARGEST_ACCOUNTS_ATTEMPTS);
  });

  it("does not ask again for an error that asking again does not change", async () => {
    mocks.heliusRpc.mockResolvedValue({ error: { code: -32602, message: "Invalid param: not a Pubkey" } });
    expect(await run(heliusGetLargestAccounts(MINT, "key"))).toBeNull();
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1);
  });

  it("does not ask again when there was no answer at all (http.ts already asked twice)", async () => {
    mocks.heliusRpc.mockResolvedValue(null);
    expect(await run(heliusGetLargestAccounts(MINT, "key"))).toBeNull();
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1);
  });

  it("an answer with an empty list is not a list: it is asked again, then null", async () => {
    mocks.heliusRpc.mockResolvedValue({ result: { value: [] }, error: undefined });
    expect(await run(heliusGetLargestAccounts(MINT, "key"))).toBeNull();
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1); // not an error: nothing to ask again for
  });

  it("starts no new attempt when there is not time for it before the deadline", async () => {
    mocks.heliusRpc.mockResolvedValue(OVERLOADED);
    const deadlineAt = Date.now() + 1_000; // an attempt needs a pause and 2.5 s: no second attempt
    expect(await run(heliusGetLargestAccounts(MINT, "key", { deadlineAt }))).toBeNull();
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1);
  });

  it("never throws: an exception inside is the same as no list (it must not take the scan's other sources down with it)", async () => {
    mocks.heliusRpc.mockRejectedValue(new Error("boom"));
    expect(await run(heliusGetLargestAccounts(MINT, "key"))).toBeNull();
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1);
  });

  it("the remembered version does not throw either, and falls back to the last list", async () => {
    mocks.heliusRpc.mockRejectedValue(new Error("boom"));
    mocks.lastKnown.mockResolvedValue({ holders: [{ address: "old1", uiAmount: 1 }], ageS: 7200 });
    const r = await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440 }));
    expect(r.source).toBe("helius-last");
  });
});

describe("heliusGetLargestAccountsRemembered", () => {
  it("a list from Helius is returned as 'helius' and kept for the next time", async () => {
    mocks.heliusRpc.mockResolvedValueOnce(GIVEN);
    const r = await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440 }));
    expect(r).toEqual({ response: GIVEN, source: "helius" });
    expect(mocks.remember).toHaveBeenCalledWith(MINT, GIVEN.result.value);
    expect(mocks.lastKnown).toHaveBeenCalledTimes(1); // asked first (a recent list is served without asking Helius), here there is none
  });

  it("when Helius gives none, the last list is served, in the shape of an answer, as 'helius-last'", async () => {
    mocks.heliusRpc.mockResolvedValue(OVERLOADED);
    const last = [{ address: "old1", uiAmount: 700_000_000 }];
    mocks.lastKnown.mockResolvedValue({ holders: last, ageS: 5 * 3600 });
    const r = await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440 }));
    expect(r).toEqual({ response: { result: { value: last } }, source: "helius-last" });
    expect(mocks.lastKnown).toHaveBeenCalledWith(MINT, 400 * 1440);
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(LARGEST_ACCOUNTS_ATTEMPTS); // it was asked first: the list was not recent
    expect(mocks.remember).not.toHaveBeenCalled(); // an old list is never kept as a new one
  });

  it("a list that arrives after the deadline does not leave the scan with nothing when a last list is in hand: the last list is served AT the deadline, and the late one is kept", async () => {
    const last = [{ address: "old1", uiAmount: 700_000_000 }];
    mocks.lastKnown.mockResolvedValue({ holders: last, ageS: 2 * 3600 });
    mocks.heliusRpc.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(GIVEN), 10_000)));
    const p = heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440, deadlineAt: Date.now() + 4_600 });
    await vi.advanceTimersByTimeAsync(4_600);
    expect(await p).toEqual({ response: { result: { value: last } }, source: "helius-last" });
    expect(mocks.remember).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000); // the list Helius finally gave
    expect(mocks.remember).toHaveBeenCalledWith(MINT, GIVEN.result.value);
  });

  it("at the deadline with no last list: nothing, and no hanging", async () => {
    mocks.heliusRpc.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(GIVEN), 10_000)));
    const p = heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440, deadlineAt: Date.now() + 4_600 });
    await vi.advanceTimersByTimeAsync(4_600);
    expect(await p).toEqual({ response: null, source: null });
  });

  it("a list that arrives before the deadline is the answer (no last list is read over it)", async () => {
    mocks.lastKnown.mockResolvedValue({ holders: [{ address: "old1", uiAmount: 1 }], ageS: 2 * 3600 });
    mocks.heliusRpc.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(GIVEN), 2_000)));
    const p = heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440, deadlineAt: Date.now() + 4_600 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await p).toEqual({ response: GIVEN, source: "helius" });
  });

  it("a list under half an hour old is served at once: Helius is not asked at all (a list takes 2 to 6 s on these tokens)", async () => {
    const last = [{ address: "recent1", uiAmount: 700_000_000 }];
    mocks.lastKnown.mockResolvedValue({ holders: last, ageS: 10 * 60 });
    const r = await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440 }));
    expect(r).toEqual({ response: { result: { value: last } }, source: "helius-last" });
    expect(mocks.heliusRpc).not.toHaveBeenCalled();
  });

  it("but not for a scan that was asked to be fresh (the refresh button): Helius is asked first, the list stays the fallback", async () => {
    const last = [{ address: "recent1", uiAmount: 700_000_000 }];
    mocks.lastKnown.mockResolvedValue({ holders: last, ageS: 10 * 60 });
    mocks.heliusRpc.mockResolvedValueOnce(GIVEN);
    const fresh = await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440, fresh: true }));
    expect(fresh).toEqual({ response: GIVEN, source: "helius" });
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1);
    mocks.heliusRpc.mockReset().mockResolvedValue(OVERLOADED);
    const failed = await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440, fresh: true }));
    expect(failed.source).toBe("helius-last");
  });

  it("a list exactly half an hour old is still recent; a minute older is not", async () => {
    const last = [{ address: "x", uiAmount: 1 }];
    mocks.lastKnown.mockResolvedValue({ holders: last, ageS: 30 * 60 });
    mocks.heliusRpc.mockResolvedValue(GIVEN);
    await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440 }));
    expect(mocks.heliusRpc).not.toHaveBeenCalled();
    mocks.lastKnown.mockResolvedValue({ holders: last, ageS: 30 * 60 + 1 });
    const r = await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440 }));
    expect(r.source).toBe("helius");
    expect(mocks.heliusRpc).toHaveBeenCalledTimes(1);
  });

  it("when Helius gives none and there is no last list: no answer, no source", async () => {
    mocks.heliusRpc.mockResolvedValue(OVERLOADED);
    const r = await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 5 }));
    expect(r).toEqual({ response: null, source: null });
    expect(mocks.lastKnown).toHaveBeenCalledWith(MINT, 5);
  });

  it("a list is not kept when Helius gave no accounts", async () => {
    mocks.heliusRpc.mockResolvedValue(OVERLOADED);
    await run(heliusGetLargestAccountsRemembered(MINT, "key", { tokenAgeMinutes: 400 * 1440 }));
    expect(mocks.remember).not.toHaveBeenCalled();
  });
});
