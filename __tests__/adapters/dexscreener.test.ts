import { describe, it, expect } from "vitest";
import { DexScreenerAdapter } from "../../contents/modules/adapters/dexscreener.adapter";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function mockDocWithSolscanLink(ca: string): Document {
  const doc = document.implementation.createHTMLDocument("test");
  const a = doc.createElement("a");
  a.href = `https://solscan.io/token/${ca}`;
  doc.body.appendChild(a);
  return doc;
}

describe("DexScreenerAdapter", () => {
  describe("extractCA", () => {
    it("extracts CA from /solana/{CA} path", () => {
      const url = new URL(`https://dexscreener.com/solana/${BONK}`);
      const doc = document.implementation.createHTMLDocument("test");
      expect(DexScreenerAdapter.extractCA(url, doc)).toBe(BONK);
    });

    it("falls back to DOM scoring for non-solana paths", () => {
      const url = new URL("https://dexscreener.com/trending");
      const doc = mockDocWithSolscanLink(BONK);
      expect(DexScreenerAdapter.extractCA(url, doc)).toBe(BONK);
    });

    it("returns empty string when no CA found", () => {
      const url = new URL("https://dexscreener.com/trending");
      const doc = document.implementation.createHTMLDocument("test");
      expect(DexScreenerAdapter.extractCA(url, doc)).toBe("");
    });
  });

  describe("isNewToken", () => {
    it("returns true for different pathnames", () => {
      const prev = new URL(`https://dexscreener.com/solana/${BONK}`);
      const next = new URL("https://dexscreener.com/solana/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(DexScreenerAdapter.isNewToken(prev, next)).toBe(true);
    });

    it("returns false for same pathname", () => {
      const prev = new URL(`https://dexscreener.com/solana/${BONK}`);
      const next = new URL(`https://dexscreener.com/solana/${BONK}`);
      expect(DexScreenerAdapter.isNewToken(prev, next)).toBe(false);
    });

    it("returns false for query param change only", () => {
      const prev = new URL(`https://dexscreener.com/solana/${BONK}`);
      const next = new URL(`https://dexscreener.com/solana/${BONK}?tab=chart`);
      expect(DexScreenerAdapter.isNewToken(prev, next)).toBe(false);
    });
  });

  it("has correct hostname", () => {
    expect(DexScreenerAdapter.hostnames).toContain("dexscreener.com");
  });

  it("has correct name", () => {
    expect(DexScreenerAdapter.name).toBe("DexScreener");
  });
});
