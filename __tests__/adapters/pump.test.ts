import { describe, it, expect } from "vitest";
import { PumpAdapter } from "../../contents/modules/adapters/pump.adapter";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const STUB_DOC = null as unknown as Document;

describe("PumpAdapter", () => {
  describe("extractCA", () => {
    it("extracts CA from /coin/{CA} path", () => {
      const url = new URL(`https://pump.fun/coin/${BONK}`);
      expect(PumpAdapter.extractCA(url, STUB_DOC)).toBe(BONK);
    });

    it("extracts CA from /{CA} root path", () => {
      const url = new URL(`https://pump.fun/${BONK}`);
      expect(PumpAdapter.extractCA(url, STUB_DOC)).toBe(BONK);
    });

    it("returns empty string for non-token path with no DOM", () => {
      const url = new URL("https://pump.fun/board");
      expect(PumpAdapter.extractCA(url, STUB_DOC)).toBe("");
    });
  });

  describe("isNewToken", () => {
    it("returns true for different pathnames", () => {
      const prev = new URL(`https://pump.fun/coin/${BONK}`);
      const next = new URL("https://pump.fun/coin/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(PumpAdapter.isNewToken(prev, next)).toBe(true);
    });

    it("returns false for same pathname", () => {
      const prev = new URL(`https://pump.fun/coin/${BONK}`);
      const next = new URL(`https://pump.fun/coin/${BONK}`);
      expect(PumpAdapter.isNewToken(prev, next)).toBe(false);
    });
  });

  it("has correct hostname", () => {
    expect(PumpAdapter.hostnames).toContain("pump.fun");
  });

  it("has correct name", () => {
    expect(PumpAdapter.name).toBe("Pump.fun");
  });
});
