/* @vitest-environment happy-dom */
// __tests__/audit-lot35.test.ts — Lot 35 of the file-by-file audit (2026-10-17): the Full Analysis page script. Fails on the previous code.
//
// 1. The token's logo went into <img src="…"> through safeUrl(), which returned the string it was GIVEN when the host was trusted, unescaped:
//    "https://x.com/a\"onerror=\"…\"" parses as a URL on x.com, and the raw quote closed src and gave the <img> an onerror of the attacker's
//    (the first of two onerror attributes wins), a script on OUR origin with the visitor's session. The logo comes from DexScreener today;
//    with Solscan's metadata switched back on (SOLSCAN_AGE_AND_HOLDERS_ONLY) it comes from what the token's creator wrote.
// 2. No version of the page ever read the "#data=<the whole scan>" the overlay put in the address: dropped.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REAL_CA = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";
const HOSTILE_LOGO = 'https://x.com/a"onerror="window.__lot35=1';

const body = (() => {
  const html = readFileSync(resolve(process.cwd(), "token.html"), "utf8");
  const inner = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>"));
  return inner.replace(/^<body[^>]*>/, "").replace(/<script[\s\S]*?<\/script>/g, "");
})();
const settle = () => new Promise((r) => setTimeout(r, 150));

describe("token page — a hostile logo address cannot add an attribute to the <img>", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the quote of the address stays inside src (it closed it, and the <img> got the attacker's onerror)", async () => {
    const answer = { risk: "SAFE", score: 900, flags: [], tokenSymbol: "TKN", tokenName: "Token", resolvedMint: REAL_CA, tokenLogo: HOSTILE_LOGO, pair: { info: {} } };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => answer })));
    document.body.className = "";
    document.body.innerHTML = body;
    (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(`https://antares-extension.vercel.app/token.html?ca=${REAL_CA}`);
    await import("../js/token-app.js");
    await settle();

    const img = document.querySelector("img.token-logo");
    expect(img, "the logo is drawn").not.toBeNull();
    expect(img!.getAttribute("onerror")).toBe("this.remove()");
    expect(img!.getAttribute("src")).toBe("https://x.com/a%22onerror=%22window.__lot35=1");
    expect([...img!.attributes].map((a) => a.name).sort()).toEqual(["alt", "class", "onerror", "src"]);
  });
});

describe("API — the logo address it sends is the one the URL parser writes back", () => {
  it("a quote in the address is percent-encoded (it was sent as typed), a normal DexScreener address is unchanged", async () => {
    const { sanitizeUrl } = await import("../api/_lib/helpers");
    expect(sanitizeUrl(HOSTILE_LOGO)).toBe("https://x.com/a%22onerror=%22window.__lot35=1");
    const ds = "https://dd.dexscreener.com/ds-data/tokens/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263.png?key=0a1b2c";
    expect(sanitizeUrl(ds)).toBe(ds);
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeUrl("https://" + "a".repeat(3000) + ".com")).toBeNull();
  });
});

describe("overlay — Full Analysis opens the page's address, without the scan in it", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the address has no #data= (the whole scan rode along, 15-40 KB, never read by the page)", async () => {
    vi.resetModules();
    const sendMessage = vi.fn();
    vi.stubGlobal("chrome", { runtime: { lastError: undefined, sendMessage }, storage: { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } } });
    (window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean } } }).happyDOM.settings.disableCSSFileLoading = true;
    const { createHost, buildResultNode, attachAnalysisBtn } = await import("../contents/modules/components");
    const { state, scanCache } = await import("../contents/modules/state");
    const data = { risk: "SAFE", score: 900, flags: [], tokenSymbol: "TKN", tokenName: "Token", resolvedMint: REAL_CA } as never;
    createHost();
    state.boxEl!.replaceChildren(buildResultNode(data, REAL_CA, null));
    scanCache.set(REAL_CA, { data, ts: Date.now(), session: null });
    attachAnalysisBtn(REAL_CA);
    state.shadow!.querySelector("#ant-full-analysis")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const msg = sendMessage.mock.calls[0][0] as { type: string; url: string };
    expect(msg.type).toBe("OPEN_TAB");
    expect(msg.url).toBe(`https://antares-extension.vercel.app/token.html?ca=${REAL_CA}`);
  });
});
