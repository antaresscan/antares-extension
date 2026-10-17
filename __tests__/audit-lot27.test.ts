// __tests__/audit-lot27.test.ts — Lot 27 of the file-by-file audit (2026-10-17): the content-script entry, its state and the address
// finder's constants. The first test fails on the previous code.
import { describe, expect, it } from "vitest";
import { IGNORE } from "../contents/modules/constants";
import { isValid } from "../contents/modules/scanner";
import { extractCAFromPathname } from "../contents/modules/adapters/base-adapter";
import { DexScreenerAdapter } from "../contents/modules/adapters/dexscreener.adapter";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // as in the real RugCheck answers of __tests__/fixtures/upstream-real
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_USDC_PAIR = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2"; // SOL / USDC on Raydium

describe("address finder — the ids it ignores", () => {
  it("every ignored id is a real base58 address, so it can match; the Token-2022 program is never taken for a page's token", () => {
    for (const id of IGNORE) expect(id, id).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(isValid(TOKEN_2022)).toBe(false);
  });

  it("wrapped SOL stays a token: SOL's own page is scanned (non-regression)", () => {
    expect(isValid(WSOL)).toBe(true);
    expect(extractCAFromPathname(new URL(`https://birdeye.so/token/${WSOL}?chain=solana`))).toBe(WSOL);
  });

  it("DexScreener's SOL/USDC page: the base token is SOL, never the quote token USDC (non-regression)", () => {
    const links = [`https://solscan.io/account/${SOL_USDC_PAIR}`, `https://solscan.io/token/${WSOL}`, `https://solscan.io/token/${USDC}`];
    const anchors = links.map((h) => ({ getAttribute: (n: string) => (n === "href" ? h : null) }));
    const page = { querySelectorAll: () => anchors } as unknown as Document;
    const url = new URL(`https://dexscreener.com/solana/${SOL_USDC_PAIR.toLowerCase()}`);
    expect(DexScreenerAdapter.extractCA(url, page)).toBe(WSOL);
  });
});
