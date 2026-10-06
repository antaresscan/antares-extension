// __tests__/token-critical-actors.test.ts — Critical Actors section of the
// token page (js/views.js buildCriticalActorsPreview).
//
// Why this exists: until 2026-10 the function fell back to a hardcoded
// "v5 mock" whenever the backend sent no `criticalActors`. Real token
// pages then showed invented wallets ("8dxX…abc4"), "4 / 5 prior rugs",
// "Same funder as HenryRug · TrollV2" and "Pattern matches BunnyRug" —
// fabricated evidence on a scam scanner, seen live on HAWK (a SAFE verdict
// at the time) while Helius was down. These tests pin that the section
// only ever renders backend data, and says so when there is none.
import { describe, it, expect } from "vitest";
import { buildCriticalActorsPreview } from "../js/views.js";

const FABRICATED = /HenryRug|TrollV2|BunnyRug|prior rugs|prior pump\.fun snipes|8dxX…abc4|7Hg2…zX9q|sibling wallets|Coordination score/;

describe("buildCriticalActorsPreview", () => {
  it("renders the backend's critical actors when present", () => {
    const html = buildCriticalActorsPreview({
      criticalActors: [
        { type: "dev", tag: "Dev", pct: 12.5, addr: "AbCd…WxYz", repLbl: "Creator wallet", repWidth: 40, desc: "Holds <b>12.5%</b> of supply." },
      ],
    });
    expect(html).toContain("wp-card dev");
    expect(html).toContain("AbCd…WxYz");
    expect(html).toContain("12.5%");
  });

  it("never fabricates wallets when the backend sent no actors (Helius down)", () => {
    const html = buildCriticalActorsPreview({
      topHolderPct: 44,
      top10HolderPct: 70,
      tokenCreator: "7Hg2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaazX9q",
      layers: { helius: { available: false } },
    });
    expect(html).not.toMatch(FABRICATED);
    expect(html).not.toContain("wp-card");
    expect(html).toContain("unavailable for this scan");
    expect(html).toContain("<b>No wallets were checked</b>");
  });

  it("states that no actors were found when holder data was available", () => {
    const html = buildCriticalActorsPreview({ criticalActors: [], layers: { helius: { available: true } } });
    expect(html).not.toMatch(FABRICATED);
    expect(html).not.toContain("wp-card");
    expect(html).toContain("No critical actors identified");
  });

  it("treats a missing criticalActors field like an empty one", () => {
    const html = buildCriticalActorsPreview({});
    expect(html).not.toMatch(FABRICATED);
    expect(html).not.toContain("wp-card");
  });
});
