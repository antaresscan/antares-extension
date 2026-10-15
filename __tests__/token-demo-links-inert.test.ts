/* @vitest-environment happy-dom */
// In the marketing demo (token.html?ca=<one of the 4 demo tokens>&demo=1) the website / CMC / CoinGecko / Twitter / Telegram chips under the
// token name are DECORATION: the demo tokens are fictional snapshots, so every one of those links led to a dead page. They are rendered as
// <span>s that nothing can click or focus (and the three explorer links of the header already were). For a REAL token they are the links they
// always were.
//
// Loads the real page script on the real token.html markup, like token-demo-untouched.test.ts, which pins the other half of the demo
// (the data, and not one request to the API).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEMOS: Array<[string, string]> = [
  ["SAFE", "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump"],
  ["DANGER", "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump"],
  ["RUG", "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump"],
  ["CAUTION", "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5"],
];
const REAL_CA = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";

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

describe("the demo's website and social chips are decoration", () => {
  it.each(DEMOS)("%s demo: the chips are there, none can be clicked or focused, nothing opens a page", async (_verdict, ca) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the demo must never call the API"); }));
    openPage(`ca=${ca}&demo=1`);
    await import("../js/token-app.js");
    await settle();

    const chips = [...document.querySelectorAll(".soc")];
    expect(chips.length, "the demo lost its chips").toBeGreaterThanOrEqual(2);
    for (const chip of chips) {
      expect(chip.tagName, `"${chip.textContent}" is clickable`).toBe("SPAN");
      expect(chip.hasAttribute("href")).toBe(false);
      expect(chip.hasAttribute("target")).toBe(false);
      expect(chip.classList.contains("soc-inert")).toBe(true);
      expect(chip.getAttribute("aria-hidden")).toBe("true");
      expect(chip.getAttribute("tabindex")).toBeNull();
      expect((chip.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
    // the labels are still the ones of the demo: a Twitter chip at least
    const labels = chips.map((c) => (c.textContent ?? "").toLowerCase());
    expect(labels.some((l) => /twitter/.test(l))).toBe(true);
  });

  it.each(DEMOS)("%s demo: no link of the page opens another tab (every external link of the demo is dead)", async (_verdict, ca) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the demo must never call the API"); }));
    openPage(`ca=${ca}&demo=1`);
    await import("../js/token-app.js");
    await settle();

    const external = [...document.querySelectorAll("a[href]")].filter((a) => /^https?:/i.test(a.getAttribute("href") ?? "") && a.getAttribute("target") === "_blank");
    expect(external.map((a) => `${a.textContent?.trim()} -> ${a.getAttribute("href")}`)).toEqual([]);
  });
});

describe("a real token keeps its links", () => {
  it("the website and the Twitter chips are real links that open in a new tab, safely (Telegram and the other socials are not shown any more: __tests__/token-links.test.ts)", async () => {
    const answer = {
      risk: "SAFE", score: 900, flags: [], tokenSymbol: "TKN", tokenName: "Token", resolvedMint: REAL_CA, tokenDecimals: 6,
      pair: { info: { websites: [{ url: "https://github.com/example", label: "Website" }], socials: [{ type: "twitter", url: "https://x.com/example" }, { type: "telegram", url: "https://t.me/example" }] } },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => answer })));
    openPage(`ca=${REAL_CA}`);
    await import("../js/token-app.js");
    await settle();

    const chips = [...document.querySelectorAll(".soc")];
    expect(chips.map((c) => c.tagName)).toEqual(["A", "A"]);
    expect(chips.map((c) => c.getAttribute("href"))).toEqual(["https://github.com/example", "https://x.com/example"]);
    for (const chip of chips) {
      expect(chip.getAttribute("target")).toBe("_blank");
      expect(chip.getAttribute("rel")).toBe("noopener noreferrer");
      expect(chip.classList.contains("soc-inert")).toBe(false);
    }
  });
});
