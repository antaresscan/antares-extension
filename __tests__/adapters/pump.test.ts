import { describe, it, expect } from "vitest";
import { PumpAdapter } from "../../contents/modules/adapters/pump.adapter";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function mockDocWithSolscanLink(ca: string): Document {
  const doc = document.implementation.createHTMLDocument("test");
  const a = doc.createElement("a");
  a.href = `https://solscan.io/token/${ca}`;
  doc.body.appendChild(a);
  return doc;
}

describe("PumpAdapter", () => {
  describe("extractCA", () => {
    it("extracts CA from /coin/{CA} path", () => {
      const url = new URL(`https://pump.fun/coin/${BONK}`);
      const doc = document.implementation.createHTMLDocument("test");
      expect(PumpAdapter.extractCA(url, doc)).toBe(BONK);
    });

    it("extracts CA from /{CA} root path", () => {
      const url = new URL(`https://pump.fun/${BONK}`);
      const doc = document.implementation.createHTMLDocument("test");
      expect(PumpAdapter.extractCA(url, doc)).toBe(BONK);
    });

    it("falls back to DOM scoring when no CA in path", () => {
      const url = new URL("https://pump.fun/board");
      const doc = mockDocWithSolscanLink(BONK);
      expect(PumpAdapter.extractCA(url, doc)).toBe(BONK);
    });

    it("returns empty string when no CA anywhere", () => {
      const url = new URL("https://pump.fun/board");
      const doc = document.implementation.createHTMLDocument("test");
      expect(PumpAdapter.extractCA(url, doc)).toBe("");
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
