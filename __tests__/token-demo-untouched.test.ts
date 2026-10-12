/* @vitest-environment happy-dom */
// The marketing demo (antaresscan.com/demo -> "Full Analysis" -> token.html?ca=<one of 4 tokens>&demo=1) must stay exactly as it is.
// It draws the full analysis from DEMO_DATA, hardcoded in js/token-app.js, and never calls /api/scan: so it does not depend on what the
// API sends, and the Pro/Free line the API now draws on the server (api/_lib/pro-gate.ts) cannot change it.
//
// This test loads the real page script on the real token.html markup and pins both halves:
//   - the demo: full analysis, no Pro message, and not one request to the API (a fetch that throws would fail it);
//   - a real token, answered with the Free view: the Pro message, and none of the analysis.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEMO_CAS = [
  "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", // SAFE
  "Dfh5DzRgSvvCFDoYc2ciTkMrbDfRKybA4SoFbPmApump", // DANGER
  "4GFe6MBDorSy5bLbiUMrgETr6pZcjyfxMDm5ehSgpump", // RUG
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", // CAUTION
];
const REAL_CA = "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82";

/** The markup the page script writes into: the <body> of the real token.html, without its scripts. */
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

describe("the marketing demo is untouched", () => {
  it.each(DEMO_CAS)("%s: full analysis from its own data, no Pro message, no request to the API", async (ca) => {
    const fetchSpy = vi.fn(async () => { throw new Error("the demo must never call the API"); });
    vi.stubGlobal("fetch", fetchSpy);
    openPage(`ca=${ca}&demo=1`);

    await import("../js/token-app.js");
    await settle();

    expect(document.getElementById("pro-gate"), "the demo shows the Pro message").toBeNull();
    expect(document.querySelector(".hero"), "the demo has no analysis").not.toBeNull();
    expect(document.querySelectorAll(".tab-pane").length, "the demo lost its tabs").toBeGreaterThan(0);
    expect(document.getElementById("content")?.textContent).toMatch(/SAFE|CAUTION|DANGER|RUG/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a real token, answered with the Free view", () => {
  it("shows the Pro message and none of the analysis", async () => {
    const freeView = { proLocked: true, risk: "DANGER", score: 410, tokenSymbol: "TKN", tokenName: "Token", flags: [{ label: "Part of Antares Pro", severity: "critical", impact: 0 }] };
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => freeView }));
    vi.stubGlobal("fetch", fetchSpy);
    openPage(`ca=${REAL_CA}`);

    await import("../js/token-app.js");
    await settle();

    expect(document.querySelector("#pro-gate h2")?.textContent).toBe("Full Analysis is part of Antares Pro");
    expect(document.querySelector(".hero")).toBeNull();
    expect(document.querySelectorAll(".tab-pane").length).toBe(0);
    expect(document.getElementById("loading")?.style.display).toBe("none");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
