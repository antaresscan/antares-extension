// __tests__/token-source-breakdown.test.ts
//
// The "Source breakdown" of token.html: one row per upstream source, built from the `layers` of a real /api/scan
// response. GoPlus was missing from it although the API returns the layer (and it carries the authorities, the LP burn
// and the holder count of the verdict). Run on the shape a real scan returns (WIF, captured 2026-10-10).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildSourceListRows, usedSourceNames } from "../js/views.js";

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

// The sources marquee at the bottom of token.html used to tick a FIXED list of five sources (Solscan, a paid source the
// API cannot use, among them) on every token, whatever the scan really used. It now shows the sources of THIS scan.
describe("usedSourceNames", () => {
  it("names the sources the engine counted, in its order, with the display labels", () => {
    expect(usedSourceNames({ sources_used: ["dexscreener", "rugcheck", "goplus", "helius", "chart"] }))
      .toEqual(["DexScreener", "RugCheck", "GoPlus", "Helius", "Chart Engine"]);
  });

  it("never invents a source: Solscan is absent when the engine did not use it", () => {
    expect(usedSourceNames({ sources_used: ["dexscreener", "goplus"] })).toEqual(["DexScreener", "GoPlus"]);
  });

  it("a scan that used no source shows none", () => {
    expect(usedSourceNames({ sources_used: [] })).toEqual([]);
    expect(usedSourceNames({})).toEqual([]);
    expect(usedSourceNames(null)).toEqual([]);
    expect(usedSourceNames({ sources_used: "dexscreener" })).toEqual([]);
  });

  it("deduplicates, ignores the case, and keeps an unknown source under its own name", () => {
    expect(usedSourceNames({ sources_used: ["DexScreener", "dexscreener", "newsource"] })).toEqual(["DexScreener", "newsource"]);
  });
});

// token-app.js builds the page from strings and cannot be imported by a unit test; these two guards read its source so the two
// lies cannot come back: a Sell tick on every token that is not RUG, and a fixed list of sources.
describe("token.html does not show what it did not verify", () => {
  const app = readFileSync(new URL("../js/token-app.js", import.meta.url), "utf8");

  it("the Sell cell is tri-state like Mint and Freeze, read from the engine's own field", () => {
    expect(app).toMatch(/siBool\("Sell", sellBlocked, true\)/);
    expect(app).toMatch(/const sellBlocked = d\.honeypot \?\? null;/);
    expect(app).not.toMatch(/d\.risk !== "RUG"/); // "not RUG" is not "can be sold"
    expect(app).not.toMatch(/sellOk/);
  });

  it("the sources marquee is built from the sources of the scan, not from a fixed list", () => {
    expect(app).not.toMatch(/FIXED_SOURCES/);
    expect(app).toMatch(/usedSourceNames\(d\)/);
  });
});
