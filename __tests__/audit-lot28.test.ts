// __tests__/audit-lot28.test.ts — Lot 28 of the file-by-file audit (2026-10-17): the site adapters. Fails on the previous code.
//
// Measured on dexscreener.com the same day (built-in browser, read only): after a click from Bonk/SOL to Nubi/SOL the URL changed at
// once (6 ms) and the page kept Bonk/SOL's links until somewhere between 799 and 874 ms. The detector reads the page at 800 ms. With
// the lowercased pair address of the URL not valid base58 (it holds an "l"), the adapter took the first token link of the page still
// on screen, Bonk, the token already shown, so the detector kept Bonk's verdict on Nubi's page.

/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../contents/modules/scanner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../contents/modules/scanner")>()),
  scan: vi.fn().mockResolvedValue(undefined),
}));

import { state } from "../contents/modules/state";
import { scan } from "../contents/modules/scanner";
import { setupNavListeners, cleanupNavListeners } from "../contents/modules/address-detector";
import { DexScreenerAdapter, pageShowsAnotherPair } from "../contents/modules/adapters/dexscreener.adapter";

// The two real pairs of the measurement, with the links their pages show (pair, base token, quote token).
const BONK_PAIR = "5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const NUBI_PAIR = "265GQ6QKcEGwNCWsL8CsJzD3iDDRuzwj7K9Pa7vst73M";
const NUBI = "2e3zQiA8JWeDjjVeuqzv9X1Q3aqRRaPqL8UYEbxVpump";
const WSOL = "So11111111111111111111111111111111111111112";
const pairPage = (pair: string, mint: string) =>
  [`https://solscan.io/account/${pair}`, `https://solscan.io/token/${mint}`, `https://solscan.io/token/${WSOL}`]
    .map((h) => `<a href="${h}">x</a>`).join("");
const NUBI_URL_PATH = `/solana/${NUBI_PAIR.toLowerCase()}`; // what DexScreener puts in the URL: lowercased, holds an "l"

describe("DexScreener adapter — the page of the previous pair is never read as this one's", () => {
  it("lowercased URL that is not base58 + page still showing the previous pair: no token (it returned the previous token)", () => {
    document.body.innerHTML = pairPage(BONK_PAIR, BONK);
    expect(DexScreenerAdapter.extractCA(new URL(`https://dexscreener.com${NUBI_URL_PATH}`), document)).toBe("");
    expect(pageShowsAnotherPair(document, NUBI_PAIR.toLowerCase())).toBe(true);
  });

  it("once the page shows this pair, its token is read (non-regression)", () => {
    document.body.innerHTML = pairPage(NUBI_PAIR, NUBI);
    expect(DexScreenerAdapter.extractCA(new URL(`https://dexscreener.com${NUBI_URL_PATH}`), document)).toBe(NUBI);
    expect(pageShowsAnotherPair(document, NUBI_PAIR.toLowerCase())).toBe(false);
  });
});

describe("detector — after a navigation it looks again until the page shows the new token", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`https://dexscreener.com/solana/${BONK_PAIR.toLowerCase()}`);
    vi.mocked(scan).mockClear();
    state.enabled = true;
    state.lastCA = BONK; // Bonk's verdict is on screen
    state.manuallyDismissed = false;
    document.body.innerHTML = pairPage(BONK_PAIR, BONK);
    setupNavListeners();
  });
  afterEach(() => {
    cleanupNavListeners();
    vi.useRealTimers();
  });

  it("click to Nubi: at 800 ms the page still shows Bonk; Nubi is scanned once the page re-renders (Bonk's verdict stayed before)", () => {
    history.pushState({}, "", NUBI_URL_PATH);
    vi.advanceTimersByTime(800); // the detector reads the page: still Bonk/SOL's
    expect(scan).not.toHaveBeenCalled();
    document.body.innerHTML = pairPage(NUBI_PAIR, NUBI); // the page re-renders (measured: before 874 ms)
    vi.advanceTimersByTime(400);
    expect(scan).toHaveBeenCalledWith(NUBI);
  });

  it("a page that never shows a token: the detector stops looking after 8 more reads (3.2 s)", () => {
    document.body.innerHTML = "";
    history.pushState({}, "", "/solana/trending");
    vi.advanceTimersByTime(800 + 8 * 400);
    expect(state.navDebounce).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(scan).not.toHaveBeenCalled();
  });
});
