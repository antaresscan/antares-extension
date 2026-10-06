// __tests__/token-compute.test.ts — Coverage for the pure compute
// helpers extracted out of js/token-app.js.
//
// These translate raw /api/scan response fields into the shapes the
// view-builders consume. They are deterministic and DOM-free, so they
// belong in their own module with a real test suite — which the audit
// flagged as a gap because all of these were buried in the giant
// token-app.js script-tag file with no exports and no tests.
import { describe, it, expect } from "vitest";
import {
  computeExitLiquidity,
  parsePctFromFlags,
  visibleFlags,
  isHoldersUnverifiedFlag,
  displayFlagLabel,
  HOLDERS_UNVERIFIED_LABEL,
} from "../js/compute.js";

describe("computeExitLiquidity", () => {
  it("returns null when liquidity is missing or non-positive", () => {
    expect(computeExitLiquidity(null)).toBeNull();
    expect(computeExitLiquidity(0)).toBeNull();
    expect(computeExitLiquidity(-100)).toBeNull();
  });

  it("returns the canonical 5-tier ladder", () => {
    const tiers = computeExitLiquidity(1_000_000);
    expect(tiers).not.toBeNull();
    expect(tiers).toHaveLength(5);
    expect(tiers!.map((t) => t.amount)).toEqual([
      100, 1000, 5000, 10000, 20000,
    ]);
  });

  it("classifies a deep-LP $100 sell as easy-exit ('ok')", () => {
    const tiers = computeExitLiquidity(1_000_000)!;
    const tier = tiers.find((t) => t.amount === 100)!;
    expect(tier.cls).toBe("ok");
    expect(tier.note).toBe("Easy exit");
    // ~ amount/(amount+L/2) = 100/500100 ≈ 0.02% → far under 3%
    expect(parseFloat(tier.slipDisplay)).toBeLessThan(3);
  });

  it("classifies a thin-LP $20K sell as bad", () => {
    const tiers = computeExitLiquidity(10_000)!;
    const tier = tiers.find((t) => t.amount === 20_000)!;
    expect(tier.cls).toBe("bad");
    expect(tier.note).toContain("crash the price");
    // very high slippage replaces percent display with the "DUMPS" label
    expect(tier.slipDisplay).toBe("~ DUMPS");
  });

  it("rises through ok → warn → bad as sell size grows on the same LP", () => {
    const tiers = computeExitLiquidity(50_000)!;
    const classes = tiers.map((t) => t.cls);
    // First tiers cheap, last tiers expensive — strictly non-decreasing severity
    const rank: Record<string, number> = { ok: 0, warn: 1, bad: 2 };
    let prev = 0;
    for (const cls of classes) {
      expect(rank[cls]).toBeGreaterThanOrEqual(prev);
      prev = rank[cls];
    }
  });

  it("caps the visual width bar at 100", () => {
    const tiers = computeExitLiquidity(100)!; // very thin LP
    expect(tiers.every((t) => t.widthPct <= 100)).toBe(true);
    expect(tiers.every((t) => t.widthPct >= 0)).toBe(true);
  });
});

describe("parsePctFromFlags", () => {
  const flags = [
    { label: "LP not burned" },
    { label: "Top 10 wallets hold 82% of supply" },
    { label: "Single wallet holds 18% of supply" },
  ];

  it("returns null when no flag matches the regex", () => {
    expect(parsePctFromFlags(flags, /no-such-pattern (\d+)/)).toBeNull();
  });

  it("extracts the first numeric capture group", () => {
    expect(
      parsePctFromFlags(flags, /top\s*10\b[^%]*?(\d+(?:\.\d+)?)\s*%/i),
    ).toBe(82);
    expect(
      parsePctFromFlags(flags, /single\s+wallet[^%]*?(\d+(?:\.\d+)?)\s*%/i),
    ).toBe(18);
  });

  it("handles labels missing the .label property gracefully", () => {
    const dirtyFlags = [{ label: undefined }, { label: "Top 10 hold 50%" }];
    expect(parsePctFromFlags(dirtyFlags, /(\d+)\s*%/)).toBe(50);
  });

  it("returns null on empty flags array", () => {
    expect(parsePctFromFlags([], /(\d+)/)).toBeNull();
  });

  it("returns null when the regex matches but no numeric capture", () => {
    const noNumber = [{ label: "Top wallets dominate (extreme)" }];
    expect(parsePctFromFlags(noNumber, /Top wallets ([a-z]+)/i)).toBeNull();
  });
});

// ─── Flags shown on the token page ─────────────────────────────────────
// A scan with no holder data carries "Helius unavailable — holder
// concentration unverified" and the API caps the verdict at CAUTION. The page
// hides pipeline-status flags, except this one: it is why the verdict is not
// SAFE. Before, the page read "0 flags detected / All sources agree" next to
// a CAUTION verdict.
describe("visibleFlags", () => {
  const HOLDERS = {
    label: "Helius unavailable — holder concentration unverified",
    severity: "warning",
  };

  it("keeps the unverified-holders flag", () => {
    expect(visibleFlags([HOLDERS])).toEqual([HOLDERS]);
  });

  it("drops bonus and info flags", () => {
    expect(
      visibleFlags([
        { label: "LP Burned ✓", severity: "bonus" },
        { label: "LP holds 2% of supply", severity: "info" },
      ]),
    ).toEqual([]);
  });

  it("control: other pipeline-status flags stay hidden, even at warning severity", () => {
    expect(
      visibleFlags([
        { label: "GoPlus unavailable", severity: "warning" },
        { label: "RugCheck unavailable", severity: "info" },
        { label: "Solscan unavailable", severity: "warning" },
      ]),
    ).toEqual([]);
  });

  it("keeps real warning and critical flags next to it", () => {
    const real = [
      { label: "Mint Authority enabled", severity: "critical" },
      { label: "Top 10 holders > 50%", severity: "warning" },
    ];
    expect(visibleFlags([...real, HOLDERS])).toEqual([...real, HOLDERS]);
  });

  it("tolerates a missing flags array", () => {
    expect(visibleFlags(undefined)).toEqual([]);
    expect(visibleFlags(null)).toEqual([]);
  });
});

describe("isHoldersUnverifiedFlag / displayFlagLabel", () => {
  it("recognises the layer flag and shows it under a neutral label", () => {
    const label = "Helius unavailable — holder concentration unverified";
    expect(isHoldersUnverifiedFlag(label)).toBe(true);
    expect(displayFlagLabel(label)).toBe(HOLDERS_UNVERIFIED_LABEL);
    // The label names the missing check, not the data vendor.
    expect(HOLDERS_UNVERIFIED_LABEL).not.toMatch(/helius/i);
  });

  it("leaves every other label untouched", () => {
    expect(isHoldersUnverifiedFlag("GoPlus unavailable")).toBe(false);
    expect(isHoldersUnverifiedFlag(undefined)).toBe(false);
    expect(displayFlagLabel("Mint Authority enabled")).toBe("Mint Authority enabled");
  });
});
