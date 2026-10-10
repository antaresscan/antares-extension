// __tests__/token-source-breakdown.test.ts
//
// The "Source breakdown" of token.html: one row per upstream source, built from the `layers` of a real /api/scan
// response. GoPlus was missing from it although the API returns the layer (and it carries the authorities, the LP burn
// and the holder count of the verdict). Run on the shape a real scan returns (WIF, captured 2026-10-10).
import { describe, it, expect } from "vitest";
import { buildSourceListRows } from "../js/views.js";

// `layers` as the production API returns it: every layer has `available` and `trust`; `crossvalidation` is not a source.
const REAL_LAYERS = {
  dexscreener: { available: true, trust: 1 },
  rugcheck: { available: true, trust: 1 },
  goplus: { available: true, trust: 1 },
  helius: { available: true, trust: 1 },
  solscan: { available: false, trust: 1 },
  chart: { available: true, trust: 1 },
  crossvalidation: { available: true, trust: 1 },
};

const rows = (html: string) => [...html.matchAll(/<div class="src-row ([a-z]+)">\s*<div class="src-name">([^<]*)<\/div>\s*<div class="src-verdict">([^<]*)<\/div>\s*<div class="src-note">([^<]*)<\/div>/g)]
  .map((m) => ({ cls: m[1], name: m[2], verdict: m[3], note: m[4] }));

describe("buildSourceListRows", () => {
  it("lists GoPlus, right after RugCheck, with the rest of the sources in their order", () => {
    const names = rows(buildSourceListRows({ layers: REAL_LAYERS })).map((r) => r.name);
    expect(names).toEqual(["RugCheck", "GoPlus", "Helius", "Solscan", "Chart Engine", "DexScreener"]);
  });

  it("the cross-validation layer is not a source and gets no row", () => {
    const html = buildSourceListRows({ layers: REAL_LAYERS });
    expect(html).not.toMatch(/cross/i);
  });

  it("GoPlus follows the same trust bands as the other sources: OK, Risk, Flagged", () => {
    const goplus = (trust: number) => rows(buildSourceListRows({ layers: { goplus: { available: true, trust } } }))[0];
    expect(goplus(1)).toMatchObject({ cls: "ok", name: "GoPlus", verdict: "OK", note: "GoPlus reports no critical issues." });
    expect(goplus(0.75)).toMatchObject({ cls: "ok", verdict: "OK" });
    expect(goplus(0.6)).toMatchObject({ cls: "warn", verdict: "Risk", note: "GoPlus flagged moderate concerns." });
    expect(goplus(0.4)).toMatchObject({ cls: "warn", verdict: "Risk" });
    expect(goplus(0.25)).toMatchObject({ cls: "bad", verdict: "Flagged", note: "GoPlus flagged significant concerns." });
  });

  it("an unavailable GoPlus is shown as N/A (the page does not pretend it was consulted)", () => {
    const [row] = rows(buildSourceListRows({ layers: { goplus: { available: false, trust: 1 } } }));
    expect(row).toMatchObject({ cls: "na", name: "GoPlus", verdict: "N/A", note: "Source unavailable for this token." });
  });

  it("no GoPlus layer in the response (an older cached scan): no GoPlus row, and the other rows are unchanged", () => {
    const { goplus: _omitted, ...withoutGoplus } = REAL_LAYERS;
    const names = rows(buildSourceListRows({ layers: withoutGoplus })).map((r) => r.name);
    expect(names).toEqual(["RugCheck", "Helius", "Solscan", "Chart Engine", "DexScreener"]);
  });

  it("no layers at all: an empty list, not an error", () => {
    expect(buildSourceListRows({})).toBe("");
    expect(buildSourceListRows({ layers: {} })).toBe("");
  });
});
