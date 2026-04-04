import { describe, it, expect } from "vitest";
import { PhotonAdapter } from "../../contents/modules/adapters/photon.adapter";

const STUB_DOC = null as unknown as Document;

describe("PhotonAdapter", () => {
  describe("extractCA", () => {
    it("returns empty string for memescope page", () => {
      const url = new URL("https://photon-sol.tinyastro.io/en/memescope");
      expect(PhotonAdapter.extractCA(url, STUB_DOC)).toBe("");
    });

    it("returns empty string for trending page", () => {
      const url = new URL("https://photon-sol.tinyastro.io/en/trending");
      expect(PhotonAdapter.extractCA(url, STUB_DOC)).toBe("");
    });

    it("returns empty string for non-lp path", () => {
      const url = new URL("https://photon-sol.tinyastro.io/en/portfolio");
      expect(PhotonAdapter.extractCA(url, STUB_DOC)).toBe("");
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
