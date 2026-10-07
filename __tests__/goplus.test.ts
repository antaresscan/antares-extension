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
import { goplusHazards, goplusHolderAccounts, goplusHolderCount, goplusTotalSupply } from "../api/_lib/goplus";
import { layerGoPlus, layerHelius } from "../api/_lib/layers";
import { determineVerdict } from "../api/_lib/pipeline";
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

// ─── Authorities and Token-2022 hazards ───────────────────────────────────────

describe("goplusHazards on real answers", () => {
  const none = { authorities: [], nonTransferable: false, defaultFrozen: false, transferFeeBps: 0, transferHook: false };

  it("finds nothing on HAWK and BONK: every authority revoked", () => {
    expect(goplusHazards(real("HAWK"))).toEqual(none);
    expect(goplusHazards(real("BONK"))).toEqual(none);
  });

  it("USDG, an issuer-run stablecoin: mint, freeze, permanent delegate, and a changeable fee and hook", () => {
    expect(goplusHazards(real("USDG"))).toEqual({
      ...none,
      authorities: ["mint", "freeze", "permanent delegate", "transfer fee", "transfer hook"],
    });
  });

  it("TSLAx, a tokenized stock: mint, freeze, permanent delegate and a changeable hook (it has no transfer fee extension)", () => {
    expect(goplusHazards(real("TSLAX")).authorities).toEqual(["mint", "freeze", "permanent delegate", "transfer hook"]);
  });

  it("ORCA, a DAO token: the mint authority only", () => {
    expect(goplusHazards(real("ORCA")).authorities).toEqual(["mint"]);
  });
});

describe("goplusHazards on hand-built answers (none of these occur in the 505 corpus tokens)", () => {
  it("a soulbound token cannot be sold", () => {
    expect(goplusHazards({ non_transferable: "1" }).nonTransferable).toBe(true);
    expect(goplusHazards({ non_transferable: "0" }).nonTransferable).toBe(false);
  });

  it("accounts frozen by default are state 2", () => {
    expect(goplusHazards({ default_account_state: "2" }).defaultFrozen).toBe(true);
    expect(goplusHazards({ default_account_state: "1" }).defaultFrozen).toBe(false);
  });

  it("takes the highest fee, current or scheduled, in basis points", () => {
    const fee = {
      current_fee_rate: { fee_rate: "450", maximum_fee: "1000" },
      scheduled_fee_rate: [{ epoch: "800", fee_rate: "1500", maximum_fee: "1000" }, { epoch: "900", fee_rate: "20" }],
    };
    expect(goplusHazards({ transfer_fee: fee }).transferFeeBps).toBe(1500);
  });

  it("a transfer hook is a non-empty list", () => {
    expect(goplusHazards({ transfer_hook: [{ program_id: "Hook1111111111111111111111111111111111111" }] }).transferHook).toBe(true);
    expect(goplusHazards({ transfer_hook: [] }).transferHook).toBe(false);
  });

  it("degrades to nothing found on shapes it does not expect, instead of throwing", () => {
    const weird = {
      mintable: "yes",
      freezable: 1,
      balance_mutable_authority: null,
      transfer_fee: "5%",
      transfer_fee_upgradable: [],
      transfer_hook: "none",
      transfer_hook_upgradable: 7,
      non_transferable: { a: 1 },
      default_account_state: [],
    } as unknown as GoPlusTokenResult;

    expect(goplusHazards(weird)).toEqual({ authorities: [], nonTransferable: false, defaultFrozen: false, transferFeeBps: 0, transferHook: false });
    expect(goplusHazards(null).authorities).toEqual([]);
  });
});

describe("layerGoPlus on real answers", () => {
  const establishedCtx = { holders: 20_000, liquidity: 5_000_000, tokenAgeHours: 5_000, mintAuthority: false, freezeAuthority: false, honeypot: false };
  const young = { ...establishedCtx, holders: 800, liquidity: 60_000, tokenAgeHours: 72 };
  const authorityFlags = (r: { flags: Array<{ label: string; severity: string }> }) => r.flags.filter((f) => /^Authorities still active/.test(f.label));

  it("says nothing about authorities on HAWK or BONK", () => {
    for (const key of ["HAWK", "BONK"]) {
      expect(authorityFlags(layerGoPlus(real(key), establishedCtx)), key).toEqual([]);
    }
  });

  it("an issuer-run asset that is established gets information only: USDG stays out of the warnings", () => {
    const r = layerGoPlus(real("USDG"), establishedCtx);
    const [flag] = authorityFlags(r);

    expect(authorityFlags(r)).toHaveLength(1);
    expect(flag.severity).toBe("info");
    expect(flag.label).toBe("Authorities still active (established asset): mint, freeze, permanent delegate, transfer fee, transfer hook");
    expect(r.flags.some((f) => f.severity === "critical" || f.severity === "warning" && /authorit/i.test(f.label))).toBe(false);
  });

  it("the same authorities on a token that is not established are ONE warning, not one per authority", () => {
    const r = layerGoPlus(real("TSLAX"), young);
    const [flag] = authorityFlags(r);

    expect(authorityFlags(r)).toHaveLength(1);
    expect(flag.severity).toBe("warning");
    expect(flag.label).toBe("Authorities still active: mint, freeze, permanent delegate, transfer hook");
    expect(r.flags.some((f) => f.severity === "critical")).toBe(false);
  });

  it("the warning alone does not close the safe gate", () => {
    // A mint-only token with its LP burned (so the LP matrix has nothing to say).
    const r = layerGoPlus({ mintable: { status: "1" }, dex: [{ burn_percent: 100 }] }, young);

    expect(authorityFlags(r)[0].severity).toBe("warning");
    expect(r.safeBlocked).toBe(false);
    expect(r.flags.some((f) => f.severity === "critical")).toBe(false);
  });

  it("no context at all counts as not established", () => {
    expect(authorityFlags(layerGoPlus(real("ORCA")))[0].severity).toBe("warning");
  });

  it("the established bar is 30 days, 5,000 holders and $250,000, all three", () => {
    const at = (over: Partial<typeof establishedCtx>) => authorityFlags(layerGoPlus(real("ORCA"), { ...establishedCtx, ...over }))[0].severity;
    const bar = { tokenAgeHours: 720, holders: 5_000, liquidity: 250_000 };

    expect(at(bar)).toBe("info");
    expect(at({ ...bar, tokenAgeHours: 719 })).toBe("warning");
    expect(at({ ...bar, holders: 4_999 })).toBe("warning");
    expect(at({ ...bar, liquidity: 249_999 })).toBe("warning");
  });
});

describe("layerGoPlus on hand-built Token-2022 hazards", () => {
  it("a non-transferable token is a honeypot: trust 0, RUG, and the label the clients already know", () => {
    const r = layerGoPlus({ non_transferable: "1" });
    expect(r).toMatchObject({ trust: 0, forceRug: true, safeBlocked: true, available: true });
    expect(r.flags[0]).toMatchObject({ label: "Honeypot detected \u2014 cannot sell", severity: "critical" });
  });

  it("accounts frozen by default are critical and close the safe gate", () => {
    const r = layerGoPlus({ default_account_state: "2" });
    expect(r.flags[0]).toMatchObject({ label: "New token accounts are frozen by default", severity: "critical" });
    expect(r.safeBlocked).toBe(true);
  });

  it("a transfer fee of 10% or more is critical, 2% to under 10% a warning, under 2% nothing", () => {
    const fee = (bps: number) => layerGoPlus({ transfer_fee: { current_fee_rate: { fee_rate: String(bps) } } }).flags.find((f) => /transfer fee/i.test(f.label));

    expect(fee(1000)).toMatchObject({ severity: "critical", label: "Transfer fee 10% on every transfer" });
    expect(fee(450)).toMatchObject({ severity: "warning", label: "Transfer fee 4.5% \u2014 suspicious" });
    expect(fee(199)).toBeUndefined();
    expect(fee(0)).toBeUndefined();
  });

  it("a scheduled increase counts as much as the current rate", () => {
    const r = layerGoPlus({ transfer_fee: { current_fee_rate: { fee_rate: "0" }, scheduled_fee_rate: [{ epoch: "900", fee_rate: "2500" }] } });
    expect(r.flags.find((f) => /transfer fee/i.test(f.label))?.severity).toBe("critical");
  });

  it("a transfer hook is a warning", () => {
    const r = layerGoPlus({ transfer_hook: [{ program_id: "Hook1111111111111111111111111111111111111" }] });
    expect(r.flags.find((f) => /transfer hook/i.test(f.label))).toMatchObject({ severity: "warning" });
  });

  it("the fields of GoPlus's EVM answer do nothing: a Solana answer never has them, and the engine no longer pretends", () => {
    const evm = { is_honeypot: "1", mint_authority: "9xQe", sell_tax: "0.9" } as unknown as GoPlusTokenResult;
    const r = layerGoPlus(evm);
    expect(r.flags).toEqual([]);
    expect(r.trust).toBe(1);
  });
});

describe("what the authorities flag does to the verdict", () => {
  const base = { score: 960, forceRug: false, safeBlocked: false, safeBlockedReasons: [] as string[], sourcesUsedCount: 6, criticalFlagsCount: 0 };

  it("an established issuer asset (information only) can still be SAFE", () => {
    expect(determineVerdict({ ...base, warningFlagsCount: 0 })).toBe("SAFE");
  });

  it("a token that is not established is capped at CAUTION by the one warning, never DANGER", () => {
    expect(determineVerdict({ ...base, warningFlagsCount: 1 })).toBe("CAUTION");
  });
});
