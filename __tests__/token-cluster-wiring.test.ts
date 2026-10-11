/* @vitest-environment happy-dom */
// The wiring: when /api/graph answers for the Insider Watch tab, loadInsiderActivity puts the Cluster cards it returned in place of the
// plain holder cards at the top of token.html. This is what keeps the cluster information on the page now that the scan no longer
// builds the graph. Whatever it does, it must never stop the activity feed from rendering.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildCriticalActorsPreview } from "../js/views.js";
import { loadInsiderActivity } from "../js/ui-setup.js";

const holder = (n: number, addr: string) => ({ type: "insider", tag: `Holder #${n}`, pct: 4.5, addr, repLbl: "Top holder", repWidth: 20, repWarn: false, desc: "Holds <b>4.5%</b> of supply" });
const clusterCard = (addr: string) => ({ type: "cluster", tag: "Cluster A", pct: 4.5, addr, repLbl: "Coordinated", repWidth: 70, repWarn: true, desc: "In a cluster of <b>2 wallets</b> that moved tokens between each other" });
const WALLET = "WALLETFULLADDRESS1111111111111111111111111111";
const feed = { activity: [{ action: "BOUGHT", wallet: "Aa11…Zz11", walletFull: WALLET, usdValue: 120, amount: 5, ageMinutes: 3, signature: "sig" }], wallets: [{ wallet: "Aa11…Zz11", walletFull: WALLET, pctSupply: 4.5, holdings: 4500, active: true }], totalCheckedWallets: 10 };

function mountPage() {
  document.body.innerHTML = `
    <div id="whales-preview">${buildCriticalActorsPreview({ criticalActors: [holder(1, "Aa11…Zz11"), holder(2, "Bb22…Yy22"), holder(3, "Cc33…Xx33")] })}</div>
    <div class="iw-feed-wrap" data-ca="So11111111111111111111111111111111111111112">
      <div id="ant-insider-meta"></div><div id="ant-insider-feed"></div><div id="ant-insider-foot"></div>
    </div>`;
}
const tags = () => Array.from(document.querySelectorAll("#whales-preview .wp-card .wp-tag")).map((e) => e.textContent);
const answers = (payload: unknown, ok = true) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok, json: async () => payload })));

beforeEach(() => { mountPage(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("loadInsiderActivity puts the cluster cards on the page", () => {
  it("replaces the plain holder cards of the clustered wallets, and renders the activity feed as before", async () => {
    answers({ nodes: [], edges: [], clusters: [], activity: feed, clusterActors: [clusterCard("Aa11…Zz11"), clusterCard("Bb22…Yy22")] });

    await loadInsiderActivity();

    expect(tags()).toEqual(["Cluster A", "Cluster A", "Holder #3"]);
    expect(document.getElementById("ant-insider-feed")?.textContent).not.toBe("");
    expect(document.getElementById("ant-insider-meta")?.textContent).toMatch(/wallets active/);
  });

  it("asks /api/graph with the activity feed, as before", async () => {
    answers({ activity: feed });
    await loadInsiderActivity();
    const url = String((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(url).toMatch(/\/api\/graph\?ca=So1111.*&activity=1/);
  });

  it("an answer with no cluster cards leaves the page as the scan made it", async () => {
    answers({ activity: feed, clusterActors: [] });
    await loadInsiderActivity();
    expect(tags()).toEqual(["Holder #1", "Holder #2", "Holder #3"]);
  });

  it("an answer from an older deployment (no clusterActors field at all) changes nothing", async () => {
    answers({ activity: feed });
    await loadInsiderActivity();
    expect(tags()).toEqual(["Holder #1", "Holder #2", "Holder #3"]);
    expect(document.getElementById("ant-insider-feed")?.textContent).not.toBe("");
  });

  it("malformed cluster cards never stop the feed from rendering", async () => {
    answers({ activity: feed, clusterActors: "not a list" });
    await expect(loadInsiderActivity()).resolves.toBeUndefined();
    expect(tags()).toEqual(["Holder #1", "Holder #2", "Holder #3"]);
    expect(document.getElementById("ant-insider-feed")?.textContent).not.toBe("");
  });

  it("a failing request leaves the cards alone and says the feed is unavailable", async () => {
    answers({}, false);
    await loadInsiderActivity();
    expect(tags()).toEqual(["Holder #1", "Holder #2", "Holder #3"]);
    expect(document.getElementById("ant-insider-feed")?.textContent).toMatch(/unavailable/i);
  });

  it("a page without the top section (no #whales-preview) still renders the feed", async () => {
    document.getElementById("whales-preview")?.remove();
    answers({ activity: feed, clusterActors: [clusterCard("Aa11…Zz11")] });
    await loadInsiderActivity();
    expect(document.getElementById("ant-insider-feed")?.textContent).not.toBe("");
  });
});

describe("the feed comes first", () => {
  it("even if applying the cards throws, the activity feed still renders", async () => {
    const poisoned = { get type(): string { throw new Error("boom"); } };
    answers({ activity: feed, clusterActors: [poisoned] });
    await expect(loadInsiderActivity()).resolves.toBeUndefined();
    expect(tags()).toEqual(["Holder #1", "Holder #2", "Holder #3"]);
    const text = document.getElementById("ant-insider-feed")?.textContent ?? "";
    expect(text).toContain("Aa11…Zz11"); // the activity row itself, not an error message
    expect(text).not.toMatch(/unavailable/i);
  });
});
