/* @vitest-environment happy-dom */
// The Full Analysis page (token.html) shows two links under the token's name, its Website and its Twitter / X account, and nothing else (2026-10-15).
// It used to draw one chip per entry DexScreener returned (Shopify, Telegram, TikTok, Instagram, Reddit...), and a token's own website, which is on no
// trusted-host list, was turned into "#": the Website chip opened token.html again in a new tab. js/links.js decides which links are shown and keeps every one of
// them a real address; this file pins it, then loads the real page script on the real markup to check what the visitor gets.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { officialLinks, parseWebUrl, explorerUrl, dexscreenerLink, isSolanaAddress, isSolanaSignature } from "../js/links.js";

describe("parseWebUrl: only a real web address is a link", () => {
  it.each([
    ["https://grok-mascot.xyz", "https://grok-mascot.xyz/"],
    ["https://www.example.com/path?a=1&b=2", "https://www.example.com/path?a=1&b=2"],
    ["http://example.com", "http://example.com/"],
    ["  https://example.com/  ", "https://example.com/"],
    ["example.com", "https://example.com/"],
    ["www.example.com/about", "https://www.example.com/about"],
    ["//example.com", "https://example.com/"],
    ["https://sub.domain.example.co.uk/x", "https://sub.domain.example.co.uk/x"],
    ["https://bücher.example/", "https://xn--bcher-kva.example/"],
    ["https://example.com.", "https://example.com./"],
  ])("%s is a link: %s", (raw, href) => {
    expect(parseWebUrl(raw)?.url.href).toBe(href);
  });

  it.each([
    ["javascript:alert(1)"], ["JaVaScRiPt:alert(1)"], ["data:text/html,<script>alert(1)</script>"], ["vbscript:x"], ["file:///etc/passwd"], ["ftp://example.com"],
    ["mailto:a@b.com"], ["https://user:pass@example.com"], ["https://user@example.com"],
    ["http://localhost:3000"], ["https://localhost"], ["http://127.0.0.1"], ["http://192.168.1.1/admin"], ["http://192.168.1.10/admin"], ["http://10.0.0.25"], ["https://8.8.8.8/"], ["https://[::1]/"], ["https://intranet"], ["https://printer.local"], ["https://x.internal/"],
    ["https://example.123"], ["https://example"],
    [""], ["   "], ["#"], ["/token.html"], ["/example.com"], ["/about/us.com"], ["/"],["./token.html"], ["../token.html"], ["token.html"], ["page.html"], ["index.php"], ["logo.png"], ["https://token.html"], ["https://token.html/?ca=abc"], ["app.js"], ["https://exa mple.com"], ['https://example.com/"onmouseover="x'], ["https://example.com/<script>"], ["https://example.com/\\evil"],
    ["x".repeat(2100)], [null], [undefined], [42], [{}], [["https://example.com"]],
  ])("%j is not a link", (raw) => {
    expect(parseWebUrl(raw as never)).toBeNull();
  });
});

describe("officialLinks: a Website and a Twitter, nothing else", () => {
  const SITE = { url: "https://grok-mascot.xyz", label: "Website" };
  const X = { type: "twitter", url: "https://x.com/groklet" };

  it("the token's own website (on no trusted list) is the Website link", () => {
    expect(officialLinks([SITE], [X]).website).toEqual({ href: "https://grok-mascot.xyz/", title: "grok-mascot.xyz" });
  });

  it("the Twitter link is the account, always on https, with its address as the tooltip", () => {
    expect(officialLinks([SITE], [X]).twitter).toEqual({ href: "https://x.com/groklet", title: "x.com/groklet" });
    expect(officialLinks([], [{ type: "twitter", url: "http://twitter.com/groklet" }]).twitter?.href).toBe("https://twitter.com/groklet");
    expect(officialLinks([], [{ type: "twitter", url: "https://mobile.twitter.com/groklet" }]).twitter?.href).toBe("https://mobile.twitter.com/groklet");
    expect(officialLinks([], [{ type: "twitter", url: "https://x.com/i/communities/1234" }]).twitter?.title).toBe("x.com/i/communities/1234");
    expect(officialLinks([], [{ type: "x", url: "https://x.com/groklet" }]).twitter?.href).toBe("https://x.com/groklet");
  });

  it("Telegram, TikTok, Instagram, Reddit, Shopify and every other entry are never shown, however many there are", () => {
    const websites = [{ url: "https://grok-mascot.xyz", label: "Website" }, { url: "https://shop.example.com", label: "Shopify" }, { url: "https://other.example.org", label: "Website" }];
    const socials = [
      { type: "telegram", url: "https://t.me/groklet" }, { type: "tiktok", url: "https://tiktok.com/@groklet" }, X,
      { type: "instagram", url: "https://instagram.com/groklet" }, { type: "reddit", url: "https://reddit.com/r/groklet" }, { type: "discord", url: "https://discord.gg/x" },
    ];
    const links = officialLinks(websites, socials);
    expect(Object.keys(links).sort()).toEqual(["twitter", "website"]);
    expect(links.website?.href).toBe("https://grok-mascot.xyz/"); // the FIRST site, not the others
    expect(links.twitter?.href).toBe("https://x.com/groklet");
  });

  it("an address typed without its scheme is completed, not turned into a link to the page itself", () => {
    expect(officialLinks([{ url: "grok-mascot.xyz" }], []).website?.href).toBe("https://grok-mascot.xyz/");
  });

  it("a Website entry that is really a social account is not the website (and the next real site is)", () => {
    expect(officialLinks([{ url: "https://x.com/groklet" }], []).website).toBeNull();
    expect(officialLinks([{ url: "https://t.me/groklet" }], []).website).toBeNull();
    expect(officialLinks([{ url: "https://www.instagram.com/groklet" }, { url: "https://grok-mascot.xyz" }], []).website?.href).toBe("https://grok-mascot.xyz/");
    // a look-alike of a social host is a different host: it is an ordinary site
    expect(officialLinks([{ url: "https://notx.com" }], []).website?.href).toBe("https://notx.com/");
    expect(officialLinks([{ url: "https://evilx.com/groklet" }], []).website?.href).toBe("https://evilx.com/groklet");
  });

  it("an invalid first site is skipped, the next valid one is shown", () => {
    expect(officialLinks([{ url: "javascript:alert(1)" }, { url: "" }, { url: "https://grok-mascot.xyz" }], []).website?.href).toBe("https://grok-mascot.xyz/");
  });

  it("a 'twitter' entry that does not lead to Twitter is dropped, never shown as a Twitter link", () => {
    expect(officialLinks([], [{ type: "twitter", url: "https://evil.example/groklet" }]).twitter).toBeNull();
    expect(officialLinks([], [{ type: "twitter", url: "https://x.com.evil.example/groklet" }]).twitter).toBeNull();
    expect(officialLinks([], [{ type: "twitter", url: "https://evilx.com/groklet" }]).twitter).toBeNull();
    expect(officialLinks([], [{ type: "twitter", url: "https://nottwitter.com/groklet" }]).twitter).toBeNull();
    expect(officialLinks([], [{ type: "twitter", url: "javascript:alert(1)" }]).twitter).toBeNull();
    expect(officialLinks([], [{ type: "twitter", url: "https://user:pw@x.com/groklet" }]).twitter).toBeNull();
    // and the next Twitter entry is still looked at
    expect(officialLinks([], [{ type: "twitter", url: "https://evil.example/x" }, X]).twitter?.href).toBe("https://x.com/groklet");
  });

  it("x.com alone is not an account: no Twitter chip", () => {
    expect(officialLinks([], [{ type: "twitter", url: "https://x.com" }]).twitter).toBeNull();
    expect(officialLinks([], [{ type: "twitter", url: "https://x.com/" }]).twitter).toBeNull();
  });

  it("a Twitter address under another type is still the Twitter link", () => {
    expect(officialLinks([], [{ type: "other", url: "https://x.com/groklet" }]).twitter?.href).toBe("https://x.com/groklet");
  });

  it("no usable list, no chip: nothing is invented", () => {
    for (const v of [undefined, null, "x", 3, {}, [], [null], [{}], [{ url: 5 }], [{ type: "twitter" }]]) {
      expect(officialLinks(v as never, v as never)).toEqual({ website: null, twitter: null });
    }
  });
});

// ─── the real page script on the real markup ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const REAL_CA = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";
const DEMO_CA = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const body = (() => {
  const html = readFileSync(resolve(process.cwd(), "token.html"), "utf8");
  const inner = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>"));
  return inner.replace(/^<body[^>]*>/, "").replace(/<script[\s\S]*?<\/script>/g, "");
})();
function openPage(query: string) {
  document.body.className = "";
  document.body.innerHTML = body;
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(`https://antares-extension.vercel.app/token.html?${query}`);
}
const settle = () => new Promise((r) => setTimeout(r, 150));
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

async function pageWith(info: unknown) {
  const answer = { risk: "DANGER", score: 500, flags: [], tokenSymbol: "GROKLET", tokenName: "Grok Mascot", resolvedMint: REAL_CA, tokenDecimals: 6, pair: { info } };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => answer })));
  openPage(`ca=${REAL_CA}`);
  await import("../js/token-app.js");
  await settle();
  return [...document.querySelectorAll(".soc")] as HTMLElement[];
}
const asLinks = (chips: HTMLElement[]) => chips.filter((c) => c.tagName === "A");
/** A button that does nothing: not a link, nothing to click or focus, dimmed, and it says why. */
const expectInert = (c: HTMLElement) => {
  expect(c.tagName).toBe("SPAN");
  expect(c.hasAttribute("href")).toBe(false);
  expect(c.hasAttribute("target")).toBe(false);
  expect(c.hasAttribute("tabindex")).toBe(false);
  expect(c.classList.contains("soc-off")).toBe(true);
  expect(c.getAttribute("aria-disabled")).toBe("true");
  expect((c.getAttribute("title") ?? "").length).toBeGreaterThan(5);
};

describe("the page: Website and Twitter, the right ones", () => {
  const SEVEN = {
    websites: [{ url: "https://grok-mascot.xyz", label: "Website" }, { url: "https://shop.grok-mascot.xyz", label: "Shopify" }],
    socials: [
      { type: "twitter", url: "https://x.com/groklet" }, { type: "telegram", url: "https://t.me/groklet" }, { type: "tiktok", url: "https://www.tiktok.com/@groklet" },
      { type: "instagram", url: "https://www.instagram.com/groklet" }, { type: "reddit", url: "https://www.reddit.com/r/groklet" },
    ],
  };

  it("seven entries from DexScreener: two chips, Website then Twitter, real links that open in a new tab, safely", async () => {
    const chips = await pageWith(SEVEN);
    expect(chips.map((c) => (c.textContent ?? "").trim())).toEqual(["Website", "Twitter"]);
    expect(chips.map((c) => c.tagName)).toEqual(["A", "A"]);
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(["https://grok-mascot.xyz/", "https://x.com/groklet"]);
    for (const c of chips) {
      expect(c.getAttribute("target")).toBe("_blank");
      expect(c.getAttribute("rel")).toBe("noopener noreferrer");
      expect(c.classList.contains("soc-inert")).toBe(false);
    }
    // the tooltip says where the link goes
    expect(chips.map((c) => c.getAttribute("title"))).toEqual(["grok-mascot.xyz", "x.com/groklet"]);
  });

  it("the Website chip leads to the site, never to the page itself ('#', token.html, an empty address)", async () => {
    const chips = asLinks(await pageWith({ websites: [{ url: "https://some-brand-new-site.fun/", label: "Website" }], socials: [] }));
    expect(chips).toHaveLength(1);
    const href = chips[0].getAttribute("href") ?? "";
    expect(href).toBe("https://some-brand-new-site.fun/");
    expect(href).not.toMatch(/^#|token\.html|^$/);
  });

  it("a website typed without https:// still leads to the site", async () => {
    const chips = asLinks(await pageWith({ websites: [{ url: "grok-mascot.xyz" }], socials: [] }));
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(["https://grok-mascot.xyz/"]);
  });

  it("no website: the Website button is there and does nothing; the Twitter one works", async () => {
    const chips = await pageWith({ websites: [], socials: [{ type: "twitter", url: "https://x.com/groklet" }] });
    expect(chips.map((c) => (c.textContent ?? "").trim())).toEqual(["Website", "Twitter"]);
    expectInert(chips[0]);
    expect(chips[0].getAttribute("title")).toMatch(/no website/i);
    expect(chips[1].tagName).toBe("A");
    expect(chips[1].getAttribute("href")).toBe("https://x.com/groklet");
  });

  it("no Twitter: the Twitter button is there and does nothing; the Website one works", async () => {
    const chips = await pageWith({ websites: [{ url: "https://grok-mascot.xyz" }], socials: [{ type: "telegram", url: "https://t.me/groklet" }] });
    expect(chips.map((c) => (c.textContent ?? "").trim())).toEqual(["Website", "Twitter"]);
    expect(chips[0].tagName).toBe("A");
    expectInert(chips[1]);
    expect(chips[1].getAttribute("title")).toMatch(/no twitter/i);
  });

  it("neither (or no info at all): both buttons are there and do nothing; no link at random, no '#', nothing that reopens the page", async () => {
    for (const info of [{ websites: [{ url: "javascript:alert(1)" }], socials: [{ type: "telegram", url: "https://t.me/groklet" }] }, {}, undefined]) {
      vi.resetModules();
      const chips = await pageWith(info);
      expect(chips.map((c) => (c.textContent ?? "").trim())).toEqual(["Website", "Twitter"]);
      chips.forEach(expectInert);
      expect(document.querySelectorAll('.soc[href], a.soc')).toHaveLength(0);
      expect(document.querySelectorAll('a[href="#"], a[href=""], a[href*="token.html"]')).toHaveLength(0);
    }
  });

  it("a hostile address is never a link: no javascript:, no data:, no fake Twitter", async () => {
    const chips = await pageWith({
      websites: [{ url: "javascript:alert(document.cookie)" }, { url: "data:text/html,<script>alert(1)</script>" }],
      socials: [{ type: "twitter", url: "https://evil.example/groklet" }],
    });
    expect(asLinks(chips)).toHaveLength(0);
    chips.forEach(expectInert); // both buttons stay, and do nothing
    expect(document.querySelectorAll('a[href^="javascript" i], a[href^="data" i]')).toHaveLength(0);
  });

  it("an address with quotes cannot break out of the attribute", async () => {
    const chips = asLinks(await pageWith({ websites: [{ url: 'https://example.com/" onmouseover="alert(1)' }, { url: "https://safe.example.org/a?x=1&y=2" }], socials: [] }));
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(["https://safe.example.org/a?x=1&y=2"]);
    expect(document.querySelector("[onmouseover]")).toBeNull();
  });

  it("the header links are still right: DexScreener, Solscan and RugCheck of THIS token", async () => {
    await pageWith(SEVEN);
    const hrefs = [...document.querySelectorAll("#nav-actions a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      `https://dexscreener.com/solana/${REAL_CA}`,
      `https://solscan.io/token/${REAL_CA}`,
      `https://rugcheck.xyz/tokens/${REAL_CA}`,
    ]);
  });
});

describe("the header buttons and the creator: a real link, or a button that does nothing", () => {
  async function pageWithAnswer(extra: Record<string, unknown>) {
    const answer = { risk: "DANGER", score: 500, flags: [], tokenSymbol: "GROKLET", tokenName: "Grok Mascot", resolvedMint: REAL_CA, tokenDecimals: 6, pair: { info: {} }, ...extra };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => answer })));
    openPage(`ca=${REAL_CA}`);
    await import("../js/token-app.js");
    await settle();
  }
  const header = () => [...document.querySelectorAll("#nav-actions a, #nav-actions .nav-inert")] as HTMLElement[];

  it("DexScreener: the pair address the API gave, when it is on dexscreener.com", async () => {
    await pageWithAnswer({ pair: { info: {}, url: "https://dexscreener.com/solana/PAIRaddress" } });
    expect(header()[0].getAttribute("href")).toBe("https://dexscreener.com/solana/PAIRaddress");
  });

  it.each([["http://evil.example/x"], ["https://evil.example/dexscreener.com"], ["https://evildexscreener.com/x"], ["javascript:alert(1)"], ["#"], [""], ["token.html"]])(
    "DexScreener: a pair address that is not DexScreener's (%j) is not followed and is not '#': the token's own DexScreener page", async (url) => {
      await pageWithAnswer({ pair: { info: {}, url } });
      expect(header()[0].getAttribute("href")).toBe(`https://dexscreener.com/solana/${REAL_CA}`);
    });

  it("a token id that is not a valid address: the three header buttons are there, dimmed, and do nothing (no link to nothing, no '#')", async () => {
    await pageWithAnswer({ resolvedMint: "not-a-valid-mint<script>", pair: { info: {}, url: "https://evil.example/x" } });
    const buttons = header();
    expect(buttons.map((b) => (b.textContent ?? "").replace(/[↗⚠]/g, "").trim())).toEqual(["DexScreener", "Solscan", "RugCheck"]);
    for (const b of buttons) {
      expect(b.tagName).toBe("SPAN");
      expect(b.hasAttribute("href")).toBe(false);
      expect(b.classList.contains("off")).toBe(true);
      expect(b.getAttribute("aria-disabled")).toBe("true");
    }
    expect(document.querySelectorAll('#nav-actions a')).toHaveLength(0);
  });

  it("every external link the page draws goes to a known place: no '#', no empty address, nothing that reopens the page", async () => {
    await pageWithAnswer({ pair: { info: { websites: [{ url: "https://grok-mascot.xyz" }], socials: [{ type: "twitter", url: "https://x.com/groklet" }] }, url: "https://dexscreener.com/solana/PAIR" }, tokenCreator: REAL_CA });
    const external = [...document.querySelectorAll("a[target=_blank]")] as HTMLAnchorElement[];
    expect(external.length).toBeGreaterThanOrEqual(5);
    for (const a of external) {
      const href = a.getAttribute("href") ?? "";
      expect(href, `"${a.textContent?.trim()}" has no real address`).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i);
      expect(href).not.toMatch(/token\.html|^#/);
    }
  });
});

describe("explorerUrl and dexscreenerLink: an id is checked before it becomes a link", () => {
  const WALLET = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";
  const SIGNATURE = "5".repeat(88);
  it("a valid id gives its address", () => {
    expect(explorerUrl("token", WALLET)).toBe(`https://solscan.io/token/${WALLET}`);
    expect(explorerUrl("account", WALLET)).toBe(`https://solscan.io/account/${WALLET}`);
    expect(explorerUrl("tx", SIGNATURE)).toBe(`https://solscan.io/tx/${SIGNATURE}`);
    expect(explorerUrl("rugcheck", WALLET)).toBe(`https://rugcheck.xyz/tokens/${WALLET}`);
    expect(explorerUrl("dexscreener", WALLET)).toBe(`https://dexscreener.com/solana/${WALLET}`);
  });
  it.each([[""], [" "], [null], [undefined], [12], ["short"], ["0OIl" + "1".repeat(40)], [WALLET + "?x=1"], [WALLET + "/../x"], ["../../" + WALLET], [WALLET.slice(0, 31)], [WALLET + "1".repeat(10)], ["<script>"]])(
    "%j is not an address: no link", (id) => {
      for (const kind of ["token", "account", "rugcheck", "dexscreener"]) expect(explorerUrl(kind, id as never)).toBeNull();
    });
  it("a transaction needs a signature, not an address; an address needs an address, not a signature", () => {
    expect(explorerUrl("tx", WALLET)).toBeNull();
    expect(explorerUrl("tx", "")).toBeNull();
    expect(explorerUrl("tx", SIGNATURE + "0")).toBeNull(); // "0" is not a base58 character
    expect(explorerUrl("tx", "5".repeat(91))).toBeNull();
    expect(explorerUrl("account", SIGNATURE)).toBeNull();
    expect(isSolanaAddress(SIGNATURE)).toBe(false);
    expect(isSolanaSignature(WALLET)).toBe(false);
  });
  it("an unknown kind gives nothing", () => { expect(explorerUrl("etherscan", WALLET)).toBeNull(); expect(explorerUrl(undefined as never, WALLET)).toBeNull(); });
  it("dexscreenerLink: DexScreener's own address, else the token's page, else nothing", () => {
    expect(dexscreenerLink("https://dexscreener.com/solana/abc", WALLET)).toBe("https://dexscreener.com/solana/abc");
    expect(dexscreenerLink("https://www.dexscreener.com/solana/abc", WALLET)).toBe("https://www.dexscreener.com/solana/abc");
    expect(dexscreenerLink("http://dexscreener.com/solana/abc", WALLET)).toBe(`https://dexscreener.com/solana/${WALLET}`);
    expect(dexscreenerLink("https://evil.example/", WALLET)).toBe(`https://dexscreener.com/solana/${WALLET}`);
    expect(dexscreenerLink(undefined, WALLET)).toBe(`https://dexscreener.com/solana/${WALLET}`);
    expect(dexscreenerLink("https://evil.example/", "nope")).toBeNull();
    expect(dexscreenerLink(undefined, undefined)).toBeNull();
  });
});

describe("the insider watch rows: a link to a wallet or a transaction only when its id is valid", () => {
  const WALLET = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";
  const WALLET2 = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
  const SIGNATURE = "4".repeat(88);
  async function feed(data: unknown) {
    document.body.innerHTML = `<div class="iw-feed-wrap" data-ca="${REAL_CA}"><div id="ant-insider-feed"></div><div id="ant-insider-meta"></div><div id="ant-insider-foot"></div></div>`;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ activity: data }) })));
    const { loadInsiderActivity } = await import("../js/ui-setup.js");
    await loadInsiderActivity();
  }
  const rows = (selector: string) => [...document.querySelectorAll(selector)] as HTMLElement[];

  it("the holders' list: a valid wallet is a link to Solscan, a missing or invalid one is a row that does nothing", async () => {
    await feed({ activity: [], wallets: [{ wallet: "ukHH…J82", walletFull: WALLET, pctSupply: 5, holdings: 1000, active: false }, { wallet: "????", walletFull: "", pctSupply: 4 }, { wallet: "bad", walletFull: "javascript:alert(1)", pctSupply: 3 }] });
    const r = rows(".iw-holder-row");
    expect(r.map((x) => x.tagName)).toEqual(["A", "DIV", "DIV"]);
    expect(document.querySelector(".iw-holder-list")?.children, "the rows are siblings, none is nested in another").toHaveLength(3);
    expect(r[0].getAttribute("href")).toBe(`https://solscan.io/account/${WALLET}`);
    expect(r[0].getAttribute("target")).toBe("_blank");
    for (const x of r.slice(1)) { expect(x.hasAttribute("href")).toBe(false); expect(x.classList.contains("iw-row-off")).toBe(true); }
    expect(document.querySelectorAll('a[href="https://solscan.io/account/"], a[href$="/account/"], a[href^="javascript"]')).toHaveLength(0);
  });

  it("the activity feed: a valid signature is a link to the transaction, a missing or invalid one is a row that does nothing", async () => {
    const event = (signature: unknown) => ({ walletFull: WALLET, wallet: "ukHH…J82", action: "BOUGHT", usdValue: 100, tokenAmount: 5, ageMin: 3, signature });
    await feed({ activity: [event(SIGNATURE), event(""), event(undefined), event("not-a-signature"), event(WALLET)], wallets: [{ wallet: "ukHH…J82", walletFull: WALLET, pctSupply: 5 }], walletsWithActivity: 1, totalCheckedWallets: 1 });
    const r = rows(".iw-row");
    expect(r.map((x) => x.tagName)).toEqual(["A", "DIV", "DIV", "DIV", "DIV"]);
    expect(document.getElementById("ant-insider-feed")?.children, "the rows are siblings, none is nested in another").toHaveLength(5);
    expect(r[0].getAttribute("href")).toBe(`https://solscan.io/tx/${SIGNATURE}`);
    for (const x of r.slice(1)) { expect(x.hasAttribute("href")).toBe(false); expect(x.classList.contains("iw-row-off")).toBe(true); expect(x.querySelector(".iw-row-wallet")).not.toBeNull(); }
    expect(document.querySelectorAll('a[href$="/tx/"], a[href="https://solscan.io/tx/"]')).toHaveLength(0);
  });

  it("a wallet name inside a row opens its Solscan page only for a valid address", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const event = (walletFull: string) => ({ walletFull, wallet: "x", action: "SOLD", usdValue: -5, tokenAmount: 1, ageMin: 1, signature: SIGNATURE });
    await feed({ activity: [event(WALLET2), event("")], wallets: [] });
    const names = rows(".iw-row-wallet");
    names[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    names[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(`https://solscan.io/account/${WALLET2}`);
  });
});

describe("the demo is untouched: its chips are still decoration, the same ones as before", () => {
  it("the demo still draws one inert chip per entry of its own data, none clickable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the demo must never call the API"); }));
    openPage(`ca=${DEMO_CA}&demo=1`);
    await import("../js/token-app.js");
    await settle();
    const chips = [...document.querySelectorAll(".soc")];
    expect(chips.length).toBeGreaterThanOrEqual(2);
    for (const c of chips) { expect(c.tagName).toBe("SPAN"); expect(c.hasAttribute("href")).toBe(false); }
  });
});

describe("a button that does nothing looks like it (CSS)", () => {
  const css = (() => { const h = readFileSync(resolve(process.cwd(), "token.html"), "utf8"); return h.slice(h.indexOf("<style"), h.indexOf("</style>")); })();
  const rule = (selector: string) => { const at = css.indexOf(selector + "{"); return at < 0 ? null : css.slice(at + selector.length + 1, css.indexOf("}", at)); };
  it.each([[".soc.soc-off"], ["nav .actions .nav-inert.off"]])("%s is dimmed", (selector) => {
    expect(rule(selector), selector).toMatch(/opacity:\.\d+/);
  });
  it("the Website and Twitter chip with no address cannot be clicked, hovered or selected", () => {
    expect(rule(".soc.soc-off")).toMatch(/pointer-events:none/);
    expect(rule(".soc.soc-off")).toMatch(/cursor:default/);
  });
  it("a row with no valid address has no hover highlight and no pointer cursor", () => {
    expect(rule(".iw-row-off")).toMatch(/cursor:default/);
    expect(rule(".iw-row-off:hover")).toMatch(/background:transparent/);
  });
});
