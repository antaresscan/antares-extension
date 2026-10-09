// __tests__/lp-burn.test.ts
//
// LP burn read from GoPlus' pools, on REAL pool data (BONK and WIF, captured 2026-10-09/10, see __tests__/fixtures).
//   BONK  has 10 pools. The best single pool is a $5k Raydium pool burned at 94 %, but the big ones are burned at 0-24 %
//         or cannot be measured (Orca concentrated liquidity has no LP token). It used to read "LP Burned 94 % (GoPlus) ✓".
//   WIF   really is burned: 96 % of its measurable liquidity.
// And the real Solana structural fields GoPlus sends (balance_mutable_authority, non_transferable, closable, transfer_hook).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { weightedBurnPct } from "../api/_lib/facts";
import { layerGoPlus } from "../api/_lib/layers";
import { pickGoPlusResult } from "../api/_lib/helpers";
import type { GoPlusTokenResult } from "../api/_lib/types";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/upstream-real/${name}`, import.meta.url), "utf8"));
const bonk = (): GoPlusTokenResult => pickGoPlusResult(fx("goplus-bonk.json"), BONK) as GoPlusTokenResult;
const wif = (): GoPlusTokenResult => pickGoPlusResult(fx("goplus-wif.json"), WIF) as GoPlusTokenResult;

const matureCtx = { holders: 1_000_000, liquidity: 338_000, tokenAgeHours: 33_000, mintAuthority: false, freezeAuthority: false, honeypot: false, lpPctOfSupply: 0.06 };
const labels = (r: { flags: Array<{ severity: string; label: string }> }) => r.flags.map((f) => `${f.severity}:${f.label}`);

describe("weightedBurnPct", () => {
  it("BONK: about 28 % of the measurable liquidity is burned, not the 94 % of its best (tiny) pool", () => {
    const pct = weightedBurnPct(bonk().dex) as number;
    expect(pct).toBeCloseTo(27.83, 1);
    expect(pct).toBeLessThan(50);
  });

  it("WIF: genuinely burned (about 99.5 %: its $6M pool is burned at 99.74 %, the other measurable pools are tiny)", () => {
    expect(weightedBurnPct(wif().dex)).toBeCloseTo(99.51, 1);
  });

  it("weights by TVL: a dust pool cannot dominate a large one", () => {
    expect(weightedBurnPct([{ tvl: "5000", burn_percent: 94 }, { tvl: "218000", burn_percent: 24 }])).toBeCloseTo(25.57, 1);
  });

  it("leaves out the pools GoPlus cannot measure instead of counting them as unburned", () => {
    expect(weightedBurnPct([{ tvl: 384145, burn_percent: null }, { tvl: 100, burn_percent: 100 }])).toBe(100);
  });

  it("counts a measured 0 % pool (it is measured, and unburned)", () => {
    expect(weightedBurnPct([{ tvl: 100, burn_percent: 0 }, { tvl: 100, burn_percent: 100 }])).toBe(50);
  });

  it("null when nothing can be weighed: no pools, no measurable burn, no usable TVL", () => {
    expect(weightedBurnPct(undefined)).toBeNull();
    expect(weightedBurnPct([])).toBeNull();
    expect(weightedBurnPct([{ tvl: 100, burn_percent: null }])).toBeNull();
    expect(weightedBurnPct([{ burn_percent: 100 }, { tvl: "abc", burn_percent: 100 }, { tvl: -5, burn_percent: 100 }, { tvl: 0, burn_percent: 100 }])).toBeNull();
  });
});

describe("layerGoPlus: LP burn", () => {
  it("WIF (really burned): the LP Burned bonus", () => {
    expect(labels(layerGoPlus(wif(), matureCtx))).toContain("bonus:LP Burned 100% (GoPlus) ✓");
  });

  it("BONK: no LP Burned 94 % bonus, and no fixed 'partially burned' warning either (the LP risk matrix decides)", () => {
    const l = layerGoPlus(bonk(), matureCtx);
    expect(l.flags.some((f) => /LP Burned/i.test(f.label))).toBe(false);
    expect(l.flags.some((f) => /partially burned/i.test(f.label))).toBe(false);
    expect(l.flags.some((f) => /LP/.test(f.label))).toBe(true); // the matrix flag: LP holds a negligible share of a mature token's supply
    expect(l.safeBlocked).toBe(false);
  });

  it("a partly burned LP (28 %) on a young token is judged by the matrix, not waved through", () => {
    const young = { holders: 300, liquidity: 20_000, tokenAgeHours: 5, mintAuthority: false, freezeAuthority: false, honeypot: false, lpPctOfSupply: 0.4 };
    const l = layerGoPlus({ dex: [{ tvl: "1000", burn_percent: 28 }] } as GoPlusTokenResult, young);
    expect(l.flags.some((f) => /partially burned/i.test(f.label))).toBe(false);
    expect(l.flags.some((f) => /LP/.test(f.label) && f.severity !== "bonus")).toBe(true);
  });
});

describe("layerGoPlus: the real Solana structural fields", () => {
  const base = { holder_count: "100" } as GoPlusTokenResult;

  it("a clean real token (BONK) raises none of them", () => {
    const l = layerGoPlus(bonk(), matureCtx);
    expect(l.flags.some((f) => /Balances can be changed|Non-transferable|can be closed|Transfer hook/i.test(f.label))).toBe(false);
  });

  it("an authority that can change balances is critical and blocks SAFE", () => {
    const l = layerGoPlus({ ...base, balance_mutable_authority: { status: "1", authority: [{ address: "x" }] } }, matureCtx);
    expect(labels(l)).toContain("critical:Balances can be changed by an authority");
    expect(l.safeBlocked).toBe(true);
  });

  it("a non-transferable token is critical and blocks SAFE", () => {
    const l = layerGoPlus({ ...base, non_transferable: "1" }, matureCtx);
    expect(l.flags.some((f) => f.severity === "critical" && /Non-transferable/i.test(f.label))).toBe(true);
    expect(l.safeBlocked).toBe(true);
  });

  it("closable token accounts and an installed transfer hook are warnings that do not block SAFE by themselves", () => {
    const l = layerGoPlus({ ...base, closable: { status: "1" }, transfer_hook: ["HookProgram1111111111111111111111111111111"] }, matureCtx);
    expect(l.flags.some((f) => f.severity === "warning" && /can be closed/i.test(f.label))).toBe(true);
    expect(l.flags.some((f) => f.severity === "warning" && /Transfer hook/i.test(f.label))).toBe(true);
    expect(l.safeBlocked).toBe(false);
    expect(l.flags.some((f) => f.severity === "critical")).toBe(false);
  });

  it("status 0 and an empty hook list mean nothing", () => {
    const l = layerGoPlus({ ...base, balance_mutable_authority: { status: "0", authority: [] }, closable: { status: "0" }, non_transferable: "0", transfer_hook: [] }, matureCtx);
    expect(l.flags.filter((f) => f.severity !== "bonus" && f.severity !== "info")).toEqual([]);
  });
});
