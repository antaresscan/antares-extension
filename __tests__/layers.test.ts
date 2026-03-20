import { describe, it, expect } from "vitest";
import { layerDexScreener, layerGoPlus, layerRugCheck, layerHelius, layerIdentity } from "../api/_lib/layers";

describe("layerDexScreener", () => {
  it("returns unavailable for null pair", () => {
    const result = layerDexScreener(null, null, null);
    expect(result.available).toBe(false);
  });

  it("returns low trust for low liquidity", () => {
    const pair = {
      liquidity: { usd: 500 },
      volume: { h24: 100 },
      priceChange: {},
      txns: { m5: { buys: 1, sells: 1 } },
    };
    const result = layerDexScreener(pair, null, null);
    expect(result.trust).toBeLessThan(0.3);
  });
});

describe("layerGoPlus", () => {
  it("returns unavailable for null", () => {
    const result = layerGoPlus(null);
    expect(result.available).toBe(false);
  });

  it("returns trust=0 and forceRug for honeypot", () => {
    const result = layerGoPlus({ is_honeypot: "1" });
    expect(result.trust).toBe(0);
    expect(result.forceRug).toBe(true);
  });
});

describe("layerRugCheck", () => {
  it("returns unavailable for null rugData", () => {
    const result = layerRugCheck(null, null, "abc");
    expect(result.available).toBe(false);
  });
});

describe("layerHelius", () => {
  it("returns unavailable for empty holders", () => {
    const result = layerHelius([], 0);
    expect(result.available).toBe(false);
  });
});

describe("layerIdentity", () => {
  it("allows official wSOL mint through whitelist", () => {
    const result = layerIdentity("SOL", "Wrapped SOL", "So11111111111111111111111111111111111111112");
    expect(result.trust).toBe(1.0);
    expect(result.flags).toHaveLength(0);
  });

  it("flags copycat with V2 suffix", () => {
    const result = layerIdentity("TRUMPV2", "Trump V2", "SomeFakeMintAddress1234567890123456789012");
    expect(result.trust).toBeLessThan(0.3);
    expect(result.flags.some(f => /copycat/i.test(f.label))).toBe(true);
  });

  it("flags brand imitation for non-official DOGE token", () => {
    const result = layerIdentity("DOGE", "Doge Clone", "FakeMintAddress12345678901234567890123456");
    expect(result.trust).toBeLessThan(0.3);
    expect(result.flags.some(f => /brand imitation/i.test(f.label))).toBe(true);
  });

  it("flags AI copycat suffix", () => {
    const result = layerIdentity("TRUMPAI", "Trump AI", "FakeMintAddress12345678901234567890123456");
    expect(result.trust).toBeLessThan(0.3);
    expect(result.flags.some(f => /copycat/i.test(f.label))).toBe(true);
  });

  it("returns clean for unique non-brand token", () => {
    const result = layerIdentity("MYTOKEN", "My Cool Token", "RealMintAddress123456789012345678901234567");
    expect(result.trust).toBe(1.0);
    expect(result.flags).toHaveLength(0);
  });
});
