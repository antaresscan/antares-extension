import { describe, it, expect } from "vitest";
import { DexScreenerAdapter, mintOfPairFromLinks } from "../../contents/modules/adapters/dexscreener.adapter";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const STUB_DOC = null as unknown as Document;

// A page, as far as the adapter reads it: its links in document order (checked on live DexScreener pages: the pair, the base token,
// the quote token, and the same three again for the other layout).
const PAIR = "5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9"; // Bonk / SOL on Orca
const WSOL = "So11111111111111111111111111111111111111112";
const OTHER_PAIR = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"; // SOL / USDC on Raydium
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const account = (a: string) => `https://solscan.io/account/${a}`;
const token = (a: string) => `https://solscan.io/token/${a}`;
function pageWith(...hrefs: string[]): Document {
  const anchors = hrefs.map((h) => ({ getAttribute: (n: string) => (n === "href" ? h : null) }));
  return { querySelectorAll: () => anchors } as unknown as Document;
}
const bonkPage = () => pageWith(account(PAIR), token(BONK), token(WSOL), account(PAIR), token(BONK), token(WSOL));

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

  // Audit A-07: the URL holds the PAIR's address, lowercased. About one in two is still valid base58 and used to be sent as the token.
  describe("extractCA reads the token, not the pair, from the page", () => {
    const lowercasedPairUrl = new URL(`https://dexscreener.com/solana/${PAIR.toLowerCase()}`);

    it("a lowercased pair address that happens to be valid base58: the page's base token is returned, not that address", () => {
      expect(DexScreenerAdapter.extractCA(lowercasedPairUrl, bonkPage())).toBe(BONK);
    });

    it("the base token, never the quote token, even though both are listed", () => {
      const ca = DexScreenerAdapter.extractCA(lowercasedPairUrl, bonkPage());
      expect(ca).not.toBe(WSOL);
    });

    it("the page is not ready (no links yet): the URL address is used, as before (the API resolves a pair itself)", () => {
      expect(DexScreenerAdapter.extractCA(lowercasedPairUrl, pageWith())).toBe(PAIR.toLowerCase());
    });

    it("the page still shows ANOTHER pair (a navigation that has not re-rendered): its token is NOT taken for this page's", () => {
      const stale = pageWith(account(OTHER_PAIR), token(WSOL), token(USDC));
      expect(DexScreenerAdapter.extractCA(lowercasedPairUrl, stale)).toBe(PAIR.toLowerCase());
    });

    it("an URL that already holds the token's mint is kept as it is", () => {
      const url = new URL(`https://dexscreener.com/solana/${BONK}`);
      expect(DexScreenerAdapter.extractCA(url, bonkPage())).toBe(BONK);
    });

    it("an URL whose lowercased address is NOT valid base58 still falls back to the page's token links, as before", () => {
      const invalid = new URL("https://dexscreener.com/solana/azthnsj6jrsdjferxwk6jbqh4siljxshnqtp4k7vugq5");
      const page = pageWith(token(BONK), token(WSOL));
      expect(DexScreenerAdapter.extractCA(invalid, page)).toBe(BONK);
    });

    it("mintOfPairFromLinks: the pair link must match the URL, whatever the case", () => {
      expect(mintOfPairFromLinks(bonkPage(), PAIR)).toBe(BONK);
      expect(mintOfPairFromLinks(bonkPage(), PAIR.toLowerCase())).toBe(BONK);
      expect(mintOfPairFromLinks(bonkPage(), OTHER_PAIR)).toBe("");
      expect(mintOfPairFromLinks(bonkPage(), "")).toBe("");
      expect(mintOfPairFromLinks(null, PAIR)).toBe("");
    });

    it("links that are not Solscan ones, or an invalid address, are ignored", () => {
      const noisy = pageWith("https://example.com/token/" + BONK, account(PAIR), "https://solscan.io/token/not-an-address", token(BONK));
      expect(mintOfPairFromLinks(noisy, PAIR)).toBe(BONK);
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
