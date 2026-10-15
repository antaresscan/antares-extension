/* @vitest-environment happy-dom */
// The Full Analysis page (token.html) shows two links under the token's name, its Website and its Twitter / X account, and nothing else (2026-10-15).
// It used to draw one chip per entry DexScreener returned (Shopify, Telegram, TikTok, Instagram, Reddit...), and a token's own website, which is on no
// trusted-host list, was turned into "#": the Website chip opened token.html again in a new tab. js/links.js decides which links are shown and keeps every one of
// them a real address; this file pins it, then loads the real page script on the real markup to check what the visitor gets.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { officialLinks, parseWebUrl } from "../js/links.js";

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
  return [...document.querySelectorAll("#socials-row .soc, .soc")] as HTMLElement[];
}

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
    const chips = await pageWith({ websites: [{ url: "https://some-brand-new-site.fun/", label: "Website" }], socials: [] });
    expect(chips).toHaveLength(1);
    const href = chips[0].getAttribute("href") ?? "";
    expect(href).toBe("https://some-brand-new-site.fun/");
    expect(href).not.toMatch(/^#|token\.html|^$/);
  });

  it("a website typed without https:// still leads to the site", async () => {
    const chips = await pageWith({ websites: [{ url: "grok-mascot.xyz" }], socials: [] });
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(["https://grok-mascot.xyz/"]);
  });

  it("no website: only Twitter; no Twitter: only the website; neither: no chip (and no '#' link anywhere)", async () => {
    expect((await pageWith({ websites: [], socials: [{ type: "twitter", url: "https://x.com/groklet" }] })).map((c) => c.textContent?.trim())).toEqual(["Twitter"]);
    vi.resetModules();
    expect((await pageWith({ websites: [{ url: "https://grok-mascot.xyz" }], socials: [{ type: "telegram", url: "https://t.me/groklet" }] })).map((c) => c.textContent?.trim())).toEqual(["Website"]);
    vi.resetModules();
    const none = await pageWith({ websites: [{ url: "javascript:alert(1)" }], socials: [{ type: "telegram", url: "https://t.me/groklet" }] });
    expect(none).toHaveLength(0);
    expect(document.querySelectorAll('#socials-row a[href="#"]')).toHaveLength(0);
  });

  it("a hostile address is never a link: no javascript:, no data:, no fake Twitter", async () => {
    const chips = await pageWith({
      websites: [{ url: "javascript:alert(document.cookie)" }, { url: "data:text/html,<script>alert(1)</script>" }],
      socials: [{ type: "twitter", url: "https://evil.example/groklet" }],
    });
    expect(chips).toHaveLength(0);
    expect(document.body.innerHTML).not.toMatch(/javascript:alert|data:text\/html,<script/i);
  });

  it("an address with quotes cannot break out of the attribute", async () => {
    const chips = await pageWith({ websites: [{ url: 'https://example.com/" onmouseover="alert(1)' }, { url: "https://safe.example.org/a?x=1&y=2" }], socials: [] });
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(["https://safe.example.org/a?x=1&y=2"]);
    expect(document.querySelector("#socials-row [onmouseover]")).toBeNull();
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
