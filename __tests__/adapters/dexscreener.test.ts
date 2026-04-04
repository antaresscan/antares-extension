import { describe, it, expect } from "vitest";
import { DexScreenerAdapter } from "../../contents/modules/adapters/dexscreener.adapter";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const STUB_DOC = null as unknown as Document;

describe("DexScreenerAdapter", () => {
  describe("extractCA", () => {
    it("extracts CA from /solana/{CA} path", () => {
      const url = new URL(`https://dexscreener.com/solana/${BONK}`);
      expect(DexScreenerAdapter.extractCA(url, STUB_DOC)).toBe(BONK);
    });

    it("returns empty string for non-solana paths with no DOM", () => {
      const url = new URL("https://dexscreener.com/trending");
      expect(DexScreenerAdapter.extractCA(url, STUB_DOC)).toBe("");
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
