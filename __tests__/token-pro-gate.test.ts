/* @vitest-environment happy-dom */
// token.html for a Free visitor. /api/scan sends a Free caller only the Free view and marks it `proLocked` (api/_lib/pro-gate.ts), so the
// page has no analysis to draw: it says that Full Analysis is part of Pro, shows the verdict a Free user already sees in the overlay,
// and points to the plans and to the sign-in. Nothing of the analysis is in the markup, and nothing from the answer is trusted as HTML.
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildProGate, PRO_GATE_PRICING_URL, PRO_GATE_SIGNIN_URL } from "../js/views.js";
import { fetchWithRetry } from "../js/api-client.js";

const freeView = {
  proLocked: true,
  risk: "DANGER",
  score: 410,
  tokenSymbol: "TKN",
  tokenName: "Token",
  flags: [{ label: "Part of Antares Pro", severity: "critical", impact: 0 }],
};

function mount(d: unknown) {
  document.body.innerHTML = buildProGate(d);
  return document.getElementById("pro-gate") as HTMLElement;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("buildProGate", () => {
  it("says Full Analysis is part of Pro, with the verdict and the token", () => {
    const gate = mount(freeView);
    expect(gate.querySelector("h2")?.textContent).toBe("Full Analysis is part of Antares Pro");
    expect(gate.querySelector(".pg-verdict")?.textContent).toBe("DANGER");
    expect(gate.querySelector(".pg-token")?.textContent).toBe("Token · $TKN");
  });

  it("points to the plans and to the sign-in, in a new tab and without leaking the opener", () => {
    const links = Array.from(mount(freeView).querySelectorAll("a")) as HTMLAnchorElement[];
    expect(links.map((a) => a.href)).toEqual([PRO_GATE_PRICING_URL, PRO_GATE_SIGNIN_URL]);
    for (const a of links) {
      expect(a.target).toBe("_blank");
      expect(a.rel).toContain("noopener");
    }
  });

  it("prints a RUG the way the rest of the page does: RUG RISK, or RUG CONFIRMED when the answer says an event happened", () => {
    expect(mount({ ...freeView, risk: "RUG" }).querySelector(".pg-verdict")?.textContent).toBe("RUG RISK");
    expect(mount({ ...freeView, risk: "RUG", rugKind: "risk" }).querySelector(".pg-verdict")?.textContent).toBe("RUG RISK");
    expect(mount({ ...freeView, risk: "RUG", rugKind: "confirmed" }).querySelector(".pg-verdict")?.textContent).toBe("RUG CONFIRMED");
  });

  it("keeps the word of the other verdicts, and prints nothing when there is no verdict", () => {
    expect(mount({ ...freeView, risk: "DANGER", rugKind: "confirmed" }).querySelector(".pg-verdict")?.textContent).toBe("DANGER");
    expect(mount({ ...freeView, risk: "" }).querySelector(".pg-verdict")).toBeNull();
  });

  it("holds none of the analysis: no flag text, no score, no sources", () => {
    const html = mount({ ...freeView, layers: { rugcheck: {} }, aiSummary: "SECRET SUMMARY", flags: [{ label: "SECRET FLAG", severity: "critical" }] }).outerHTML;
    expect(html).not.toContain("SECRET");
    expect(html).not.toMatch(/rugcheck/i);
  });

  it("escapes what the answer says: a name is data, never HTML", () => {
    const gate = mount({ ...freeView, tokenName: '<img src=x onerror="alert(1)">', tokenSymbol: "<b>X</b>" });
    expect(gate.querySelector("img")).toBeNull();
    expect(gate.querySelector("b")).toBeNull();
    expect(gate.querySelector(".pg-token")?.textContent).toContain("<img");
  });

  it("copes with a Free view that has no name and no verdict", () => {
    const gate = mount({ proLocked: true });
    expect(gate.querySelector("h2")).not.toBeNull();
    expect(gate.querySelector(".pg-verdict")).toBeNull();
    expect(gate.querySelector(".pg-token")).toBeNull();
  });

  it("takes the name from the DexScreener pair when the scan has none of its own", () => {
    const gate = mount({ proLocked: true, risk: "SAFE", pair: { baseToken: { name: "Pair Name", symbol: "PRN" } } });
    expect(gate.querySelector(".pg-token")?.textContent).toBe("Pair Name · $PRN");
  });
});

describe("the page asks with its session", () => {
  it("fetchWithRetry sends the cookie (credentials: include), so a Pro account is recognised even from an embedded page", async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ risk: "SAFE" }) }));
    vi.stubGlobal("fetch", f);
    await fetchWithRetry("https://antares-extension.vercel.app/api/scan?ca=x");
    expect(f).toHaveBeenCalledWith("https://antares-extension.vercel.app/api/scan?ca=x", { credentials: "include" });
  });
});
