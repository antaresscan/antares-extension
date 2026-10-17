// __tests__/audit-lot11.test.ts — Lot 11 of the file-by-file audit (2026-10-17): api/_lib/fetchers.ts, helius.ts.
// Each test fails on the previous code.
import { vi, describe, it, expect, afterEach } from "vitest";
import * as fetchers from "../api/_lib/fetchers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchers — the creator address never steers a Helius URL that carries our key", () => {
  it("a creator that is not a Solana address is not sent (it went into the URL path as it was)", async () => {
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await fetchers.heliusGetCreatorReputation("../../v0/token-metadata?mintAccounts=x#", "helius-test-key");
    expect(r).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a real address is still looked up", async () => {
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    await fetchers.heliusGetCreatorReputation("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", "helius-test-key");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("fetchers — no dead holder count", () => {
  it("heliusGetProgramAccountHolderCount is gone (nothing called it, and it read every Token-2022 mint as 0 holders)", () => {
    expect("heliusGetProgramAccountHolderCount" in fetchers).toBe(false);
  });
});
