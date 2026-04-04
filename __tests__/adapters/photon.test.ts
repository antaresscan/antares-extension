import { describe, it, expect } from "vitest";
import { PhotonAdapter } from "../../contents/modules/adapters/photon.adapter";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/** Create a minimal DOM with a solscan link containing the CA */
function mockDocWithSolscanLink(ca: string): Document {
  const doc = document.implementation.createHTMLDocument("test");
  const a = doc.createElement("a");
  a.href = `https://solscan.io/token/${ca}`;
  doc.body.appendChild(a);
  return doc;
}

describe("PhotonAdapter", () => {
  describe("extractCA", () => {
    it("returns empty string for memescope page", () => {
      const url = new URL("https://photon-sol.tinyastro.io/en/memescope");
      const doc = document.implementation.createHTMLDocument("test");
      expect(PhotonAdapter.extractCA(url, doc)).toBe("");
    });

    it("returns empty string for trending page", () => {
      const url = new URL("https://photon-sol.tinyastro.io/en/trending");
      const doc = document.implementation.createHTMLDocument("test");
      expect(PhotonAdapter.extractCA(url, doc)).toBe("");
    });

    it("returns empty string for non-lp path", () => {
      const url = new URL("https://photon-sol.tinyastro.io/en/portfolio");
      const doc = document.implementation.createHTMLDocument("test");
      expect(PhotonAdapter.extractCA(url, doc)).toBe("");
    });

    it("extracts CA from DOM on /en/lp/ page with solscan link", () => {
      const url = new URL("https://photon-sol.tinyastro.io/en/lp/SomePoolAddress123");
      const doc = mockDocWithSolscanLink(BONK);
      expect(PhotonAdapter.extractCA(url, doc)).toBe(BONK);
    });
  });

  describe("isNewToken", () => {
    it("returns true for different pathnames", () => {
      const prev = new URL("https://photon-sol.tinyastro.io/en/lp/poolA");
      const next = new URL("https://photon-sol.tinyastro.io/en/lp/poolB");
      expect(PhotonAdapter.isNewToken(prev, next)).toBe(true);
    });

    it("returns false for same pathname", () => {
      const prev = new URL("https://photon-sol.tinyastro.io/en/lp/poolA");
      const next = new URL("https://photon-sol.tinyastro.io/en/lp/poolA");
      expect(PhotonAdapter.isNewToken(prev, next)).toBe(false);
    });
  });

  it("has correct hostname", () => {
    expect(PhotonAdapter.hostnames).toContain("photon-sol.tinyastro.io");
  });

  it("has correct name", () => {
    expect(PhotonAdapter.name).toBe("Photon");
  });
});
