// __tests__/goplus.test.ts
//
// GoPlus's Solana answer, read the way GoPlus actually sends it. The engine used to
// take from it only `dex[].burn_percent` and `holder_count`; its `holders` list is a
// holder source the engine ignored while Helius, the only one, could be down for
// months. Fixtures are real answers (fixtures/goplus-solana.json, captured from
// api.gopluslabs.io; only the `dex` entries are reduced).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { goplusHolderAccounts, goplusHolderCount, goplusTotalSupply } from "../api/_lib/goplus";
import { layerHelius } from "../api/_lib/layers";
import { GoPlusTokenResultSchema } from "../api/_lib/upstream-schemas";
import type { GoPlusTokenResult } from "../api/_lib/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "goplus-solana.json"), "utf8"),
) as { tokens: Record<string, { mint: string; result: GoPlusTokenResult }> };

const real = (key: string): GoPlusTokenResult => {
  const entry = FIXTURES.tokens[key];
  if (!entry) throw new Error(`no fixture ${key}`);
  return entry.result;
};

describe("fixtures", () => {
  it("are real GoPlus Solana answers: they have the Solana fields and none of the EVM ones", () => {
    for (const [key, { result }] of Object.entries(FIXTURES.tokens)) {
      expect(Array.isArray(result.holders), key).toBe(true);
      expect(result, key).toHaveProperty("mintable");
      expect(result, key).toHaveProperty("freezable");
      for (const evm of ["is_honeypot", "mint_authority", "freeze_authority", "sell_tax", "buy_tax", "is_proxy", "hidden_owner"]) {
        expect(result, `${key} must not have ${evm}`).not.toHaveProperty(evm);
      }
    }
  });

  it("still pass the engine's own validator (holders and total_supply are kept, not stripped)", () => {
    for (const [key, { result }] of Object.entries(FIXTURES.tokens)) {
      const parsed = GoPlusTokenResultSchema.safeParse(result);
      expect(parsed.success, key).toBe(true);
      expect(parsed.success && parsed.data.holders?.length, key).toBe(result.holders?.length);
      expect(parsed.success && parsed.data.total_supply, key).toBe(result.total_supply);
    }
  });
});

describe("goplusHolderAccounts", () => {
  it("turns HAWK's list into the shape the holder layer reads: owner wallet, token account, balance", () => {
    const accounts = goplusHolderAccounts(real("HAWK"));

    expect(accounts).toHaveLength(10);
    expect(accounts[0]).toEqual({
      address: "A3fymtJYhK6i3dM5t5MwqxpGwyMYK1uKqGWNVz37YiwS",
      owner: "HsXpiFuxoDKgNjcoQaQf4c8GwX7DMsqGSWYcuN3DwG31",
      uiAmount: 401979190.842724,
    });
  });

  it("lists the largest first", () => {
    const amounts = goplusHolderAccounts(real("BONK")).map((h) => h.uiAmount);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    expect(amounts).toHaveLength(10);
  });

  it("keeps a short list as it is: a token with 2 holders has 2", () => {
    expect(goplusHolderAccounts(real("BEAR"))).toHaveLength(2);
  });

  it("drops a list that cannot be right: NFLXX's balances add up to ten times its total supply", () => {
    // Real answer: top balance 1,491,535 against a total supply of 155,056.
    expect(goplusHolderAccounts(real("NFLXX"))).toEqual([]);
  });

  it("gives nothing when there is no list", () => {
    expect(goplusHolderAccounts(null)).toEqual([]);
    expect(goplusHolderAccounts(undefined)).toEqual([]);
    expect(goplusHolderAccounts({})).toEqual([]);
    expect(goplusHolderAccounts({ holders: [] })).toEqual([]);
  });

  it("skips entries it cannot use and sorts what is left", () => {
    const out = goplusHolderAccounts({
      holders: [
        { account: "small", balance: "5" },
        { account: "", balance: "100" }, // no wallet
        { account: "zero", balance: "0" },
        { account: "negative", balance: "-3" },
        { account: "garbage", balance: "abc" },
        { account: "big", token_account: "bigTokenAccount", balance: 70 },
      ],
    });

    expect(out).toEqual([
      { address: "bigTokenAccount", owner: "big", uiAmount: 70 },
      { address: "small", owner: "small", uiAmount: 5 }, // no token account: the wallet stands in
    ]);
  });
});

describe("goplusTotalSupply and goplusHolderCount", () => {
  it("reads the total supply as a UI amount", () => {
    expect(goplusTotalSupply(real("HAWK"))).toBeCloseTo(913988565.299819, 3);
    expect(goplusTotalSupply({ total_supply: 1000 })).toBe(1000);
  });

  it("is 0 when GoPlus gave no usable supply", () => {
    for (const v of [undefined, "", "0", "-5", "abc"]) {
      expect(goplusTotalSupply({ total_supply: v }), String(v)).toBe(0);
    }
    expect(goplusTotalSupply(null)).toBe(0);
  });

  it("reads the holder count whether GoPlus sends a string or a number", () => {
    expect(goplusHolderCount(real("HAWK"))).toBe(7007);
    expect(goplusHolderCount({ holder_count: 5 })).toBe(5);
  });

  it("is null for a missing or non-positive count", () => {
    for (const v of [undefined, "0", 0, "abc", "-4"]) {
      expect(goplusHolderCount({ holder_count: v }), String(v)).toBeNull();
    }
    expect(goplusHolderCount(null)).toBeNull();
  });
});

describe("GoPlus's list through the holder layer (what a scan does when Helius gave nothing)", () => {
  it("HAWK, a rug: the 44% wallet is critical, and the Raydium authority in the list is not counted as a holder", () => {
    const goplus = real("HAWK");
    const layer = layerHelius(goplusHolderAccounts(goplus), goplusTotalSupply(goplus));

    expect(layer.available).toBe(true);
    const flag = layer.flags.find((f) => /single wallet holds/i.test(f.label));
    expect(flag?.severity).toBe("critical");
    expect(flag?.label).toMatch(/44%/);
    // The second entry of the real list (24.8%) is Raydium's pool authority. Counting it
    // would make the top 10 77% instead of 52%, the figure Helius gave for HAWK too.
    expect(layer.flags.map((f) => f.label)).toContain("Top 10 hold 52% — elevated concentration · cluster risk");
  });

  it("BONK, an established token: nothing critical", () => {
    const goplus = real("BONK");
    const layer = layerHelius(goplusHolderAccounts(goplus), goplusTotalSupply(goplus));

    expect(layer.available).toBe(true);
    expect(layer.flags.some((f) => f.severity === "critical")).toBe(false);
  });

  it("an empty list leaves the layer unavailable, as before", () => {
    const layer = layerHelius(goplusHolderAccounts(real("NFLXX")), goplusTotalSupply(real("NFLXX")));
    expect(layer.available).toBe(false);
    expect(layer.safeBlocked).toBe(true);
  });
});
