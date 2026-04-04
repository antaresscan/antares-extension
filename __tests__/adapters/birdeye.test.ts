import { describe, it, expect } from "vitest";
import { BirdeyeAdapter } from "../../contents/modules/adapters/birdeye.adapter";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const EMPTY_DOC = new Document();

describe("BirdeyeAdapter", () => {
  describe("extractCA", () => {
    it("extracts CA from canonical /solana/token/{CA} path", () => {
      const url = new URL(`https://birdeye.so/solana/token/${BONK}`);
      expect(BirdeyeAdapter.extractCA(url, EMPTY_DOC)).toBe(BONK);
    });

    it("extracts CA from legacy /token/{CA} path", () => {
      const url = new URL(`https://birdeye.so/token/${BONK}`);
      expect(BirdeyeAdapter.extractCA(url, EMPTY_DOC)).toBe(BONK);
    });

    it("returns empty string for non-token pages", () => {
      const url = new URL("https://birdeye.so/trending");
      expect(BirdeyeAdapter.extractCA(url, EMPTY_DOC)).toBe("");
    });

    it("returns empty string for homepage", () => {
      const url = new URL("https://birdeye.so/");
      expect(BirdeyeAdapter.extractCA(url, EMPTY_DOC)).toBe("");
    });
  });

  describe("isNewToken", () => {
    it("returns false for redirect /token/{CA} -> /solana/token/{CA}", () => {
      const prev = new URL(`https://birdeye.so/token/${BONK}`);
      const next = new URL(`https://birdeye.so/solana/token/${BONK}`);
      expect(BirdeyeAdapter.isNewToken(prev, next)).toBe(false);
    });

    it("returns true for different tokens", () => {
      const prev = new URL(`https://birdeye.so/solana/token/${BONK}`);
      const next = new URL("https://birdeye.so/solana/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      expect(BirdeyeAdapter.isNewToken(prev, next)).toBe(true);
    });

    it("returns true when navigating from token to trending", () => {
      const prev = new URL(`https://birdeye.so/solana/token/${BONK}`);
      const next = new URL("https://birdeye.so/trending");
      expect(BirdeyeAdapter.isNewToken(prev, next)).toBe(true);
    });

    it("returns false for same non-token pages", () => {
      const prev = new URL("https://birdeye.so/trending");
      const next = new URL("https://birdeye.so/trending");
      expect(BirdeyeAdapter.isNewToken(prev, next)).toBe(false);
    });
  });

  it("has correct hostname", () => {
    expect(BirdeyeAdapter.hostnames).toContain("birdeye.so");
  });

  it("has correct name", () => {
    expect(BirdeyeAdapter.name).toBe("Birdeye");
  });
});
