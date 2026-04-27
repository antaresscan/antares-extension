import { describe, it, expect } from "vitest";
import { composeOutcomeStats } from "../api/_lib/outcome-stats";
import type { ScanFlag } from "../api/_lib/types";

const flag = (label: string): ScanFlag => ({ label, severity: "critical", impact: 50 });

describe("composeOutcomeStats", () => {
  it("returns null for SAFE verdict (no histogram shown)", () => {
    const out = composeOutcomeStats({
      risk: "SAFE", tokenAgeHours: 720, top10HolderPct: 10,
      liquidity: 1_000_000, volume24h: 500_000, flags: [],
    });
    expect(out).toBeNull();
  });

  it("matches the fast-rug profile when honeypot is detected", () => {
    const out = composeOutcomeStats({
      risk: "RUG", tokenAgeHours: 6, top10HolderPct: 50,
      liquidity: 45_000, volume24h: 1_000_000,
      flags: [flag("Honeypot detected — cannot sell")],
    });
    expect(out).not.toBeNull();
    expect(out!.timeToRugMedianDisp).toBe("4h 12m");
    expect(out!.timeToRugMedianHours).toBe(4.2);
    expect(out!.pctRugged24h).toBe(89);
    expect(out!.distribution).toHaveLength(36);
    expect(out!.mostSimilar).toHaveLength(3);
    expect(out!.mostSimilar[0].symbol).toBe("RUGCOIN");
  });

  it("matches fast-rug for young + concentrated tokens without honeypot", () => {
    const out = composeOutcomeStats({
      risk: "RUG", tokenAgeHours: 6, top10HolderPct: 41,
      liquidity: 45_000, volume24h: 1_500_000,
      flags: [flag("Wash trading detected"), flag("LP not burned or locked")],
    });
    expect(out!.timeToRugMedianDisp).toBe("4h 12m");
  });

  it("matches the high-risk profile for plain DANGER tokens", () => {
    const out = composeOutcomeStats({
      risk: "DANGER", tokenAgeHours: 48, top10HolderPct: 30,
      liquidity: 100_000, volume24h: 200_000,
      flags: [flag("Wash trading detected")],
    });
    expect(out!.timeToRugMedianDisp).toBe("11h");
    expect(out!.pctRugged24h).toBe(76);
    expect(out!.mostSimilar[0].symbol).toBe("PUMPDUMP");
  });

  it("matches the slow-death profile for milder CAUTION tokens", () => {
    const out = composeOutcomeStats({
      risk: "CAUTION", tokenAgeHours: 240, top10HolderPct: 15,
      liquidity: 200_000, volume24h: 100_000, flags: [],
    });
    expect(out!.timeToRugMedianDisp).toBe("2d");
    expect(out!.pctRugged24h).toBe(54);
    expect(out!.mostSimilar[0].symbol).toBe("FORGOTBOY");
  });

  it("histogram is exactly 36 buckets with non-negative weights", () => {
    const out = composeOutcomeStats({
      risk: "RUG", tokenAgeHours: 6, top10HolderPct: 50,
      liquidity: 45_000, volume24h: 1_000_000,
      flags: [flag("Honeypot detected")],
    });
    expect(out!.distribution).toHaveLength(36);
    out!.distribution.forEach(v => expect(v).toBeGreaterThanOrEqual(0));
  });

  it("youBucketIndex sits within the histogram length", () => {
    const out = composeOutcomeStats({
      risk: "DANGER", tokenAgeHours: 48, top10HolderPct: 30,
      liquidity: 100_000, volume24h: 600_000, flags: [],
    });
    expect(out!.youBucketIndex).toBeGreaterThanOrEqual(0);
    expect(out!.youBucketIndex).toBeLessThan(out!.distribution.length);
  });
});
