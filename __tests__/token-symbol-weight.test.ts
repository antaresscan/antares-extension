/* @vitest-environment happy-dom */
// The token's symbol under the verdict word (GROKLET) is set in Bebas Neue, which has a single weight: "font-weight: 700" drew a synthesized, smeared bold that looked
// too thick (2026-10-15). It is a regular weight now. The marketing demo is the same page and must stay exactly as it was, so it keeps the bold, through a marker the
// page script puts on <html> in demo mode only (html.is-demo).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve(process.cwd(), "token.html"), "utf8");
const css = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
const rule = (selector: string): string | null => {
  const at = css.indexOf(selector + "{");
  return at < 0 ? null : css.slice(at + selector.length + 1, css.indexOf("}", at));
};

describe("the symbol's weight, in the page's CSS", () => {
  it("a real token: regular weight (no synthesized bold), the same colour and size as before", () => {
    const r = rule(".tk-line b");
    expect(r, "the .tk-line b rule").not.toBeNull();
    expect(r).toMatch(/font-weight:\s*400\b/);
    expect(r).not.toMatch(/font-weight:\s*(700|bold|600|800|900)/i);
    expect(r).toMatch(/color:#ddd/);
    expect(r).toMatch(/font-size:22px/);
    expect(r).toMatch(/letter-spacing:\.09em/);
  });

  it("the demo keeps its bold: html.is-demo says so", () => {
    expect(rule("html.is-demo .tk-line b")).toMatch(/font-weight:\s*700/);
  });
});

// ─── the marker the page script puts on <html> ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const REAL_CA = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";
const DEMO_CA = "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump";
const body = (() => {
  const inner = html.slice(html.indexOf("<body"), html.lastIndexOf("</body>"));
  return inner.replace(/^<body[^>]*>/, "").replace(/<script[\s\S]*?<\/script>/g, "");
})();
function openPage(query: string) {
  document.documentElement.classList.remove("is-demo");
  document.body.className = "";
  document.body.innerHTML = body;
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(`https://antares-extension.vercel.app/token.html?${query}`);
}
const settle = () => new Promise((r) => setTimeout(r, 150));
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); document.documentElement.classList.remove("is-demo"); });

describe("the demo marker", () => {
  it("the demo page is marked, and still never calls the API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the demo must never call the API"); }));
    openPage(`ca=${DEMO_CA}&demo=1`);
    await import("../js/token-app.js");
    await settle();
    expect(document.documentElement.classList.contains("is-demo")).toBe(true);
    expect(document.querySelector(".tk-line b")?.textContent).toBeTruthy(); // the symbol is drawn, in the demo as before
  });

  it("a real token is not marked, so it gets the regular weight", async () => {
    const answer = { risk: "DANGER", score: 500, flags: [], tokenSymbol: "GROKLET", tokenName: "Grok Mascot", resolvedMint: REAL_CA, tokenDecimals: 6, pair: { info: {} } };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => answer })));
    openPage(`ca=${REAL_CA}`);
    await import("../js/token-app.js");
    await settle();
    expect(document.documentElement.classList.contains("is-demo")).toBe(false);
    expect(document.querySelector(".tk-line b")?.textContent).toBe("GROKLET");
  });

  it("only the exact demo=1 marks the page", async () => {
    const answer = { risk: "DANGER", score: 500, flags: [], tokenSymbol: "GROKLET", tokenName: "Grok Mascot", resolvedMint: REAL_CA, tokenDecimals: 6, pair: { info: {} } };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => answer })));
    for (const q of ["demo=0", "demo=true", "demo="]) {
      vi.resetModules();
      openPage(`ca=${REAL_CA}&${q}`);
      await import("../js/token-app.js");
      await settle();
      expect(document.documentElement.classList.contains("is-demo"), q).toBe(false);
    }
  });
});
