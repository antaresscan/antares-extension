/* @vitest-environment happy-dom */
// The scan no longer builds the insider graph (~120 Helius credits per cold scan, for a display-only feature). token.html keeps the
// "Cluster" cards of its Critical Actors section anyway: /api/graph, which the page already calls for the Insider Watch tab, returns the
// cards the scan cannot make, and applyClusterCards puts each one in place of the card of the SAME wallet.
import { describe, it, expect, beforeEach } from "vitest";
import { buildCriticalActorsPreview, renderCriticalActorCard, applyClusterCards } from "../js/views.js";

const insider = (n: number, addr: string, pct: number) => ({
  type: "insider", tag: `Holder #${n}`, pct, addr, repLbl: "Top holder", repWidth: 20, repWarn: false,
  desc: `Holds <b>${pct}%</b> of supply — large enough to move the chart on exit.`,
});
const cluster = (addr: string, pct: number, wallets = 3) => ({
  type: "cluster", tag: "Cluster A", pct, addr, repLbl: "Coordinated", repWidth: 70, repWarn: true,
  desc: `In a cluster of <b>${wallets} wallets</b> that moved tokens between each other — coordinated buy or distribution pattern.`,
});

/** The section the page renders from a scan whose graph was not built: three plain holder cards. */
function mountScanCards(actors: unknown[]) {
  document.body.innerHTML = `<div class="whales-preview" id="whales-preview">${buildCriticalActorsPreview({ criticalActors: actors })}</div>`;
  return document.getElementById("whales-preview") as HTMLElement;
}
const cards = (root: HTMLElement) => Array.from(root.querySelectorAll(".wp-card")).map((el) => ({
  cls: el.className, tag: el.querySelector(".wp-tag")?.textContent, addr: el.querySelector(".wp-addr")?.textContent,
}));

beforeEach(() => { document.body.innerHTML = ""; });

describe("renderCriticalActorCard", () => {
  it("is the card buildCriticalActorsPreview draws: the section is the cards, side by side", () => {
    const actors = [insider(1, "Aa11…Zz11", 4.5), cluster("Bb22…Yy22", 13.5)];
    expect(buildCriticalActorsPreview({ criticalActors: actors })).toBe(actors.map(renderCriticalActorCard).join(""));
  });

  it.each([["dev", "dev"], ["cluster", "coord"], ["insider", "bot"]])("a %s actor gets the class %s", (type, cls) => {
    expect(renderCriticalActorCard({ type, tag: "t", pct: 5, addr: "x…y", repLbl: "", repWidth: 0, desc: "d" })).toContain(`wp-card ${cls}`);
  });

  it("escapes what comes from the API (a tag or an address is never HTML)", () => {
    const html = renderCriticalActorCard({ type: "insider", tag: "<img src=x onerror=alert(1)>", pct: 1, addr: "<script>x</script>", repLbl: "", repWidth: 0, desc: "" });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
  });
});

describe("applyClusterCards", () => {
  it("replaces the card of the same wallet by the cluster card, and leaves the others as the scan made them", () => {
    const root = mountScanCards([insider(1, "Aa11…Zz11", 4.5), insider(2, "Bb22…Yy22", 4.5), insider(3, "Cc33…Xx33", 4.5)]);

    const n = applyClusterCards(root, [cluster("Aa11…Zz11", 4.5), cluster("Bb22…Yy22", 4.5)]);

    expect(n).toBe(2);
    expect(cards(root)).toEqual([
      { cls: "wp-card coord", tag: "Cluster A", addr: "Aa11…Zz11" },
      { cls: "wp-card coord", tag: "Cluster A", addr: "Bb22…Yy22" },
      { cls: "wp-card bot", tag: "Holder #3", addr: "Cc33…Xx33" },
    ]);
    expect(root.textContent).toContain("moved tokens between each other");
  });

  it("keeps the order of the cards", () => {
    const root = mountScanCards([insider(1, "Aa11…Zz11", 4.5), insider(2, "Bb22…Yy22", 4.5), insider(3, "Cc33…Xx33", 4.5)]);
    applyClusterCards(root, [cluster("Bb22…Yy22", 4.5)]);
    expect(cards(root).map((c) => c.addr)).toEqual(["Aa11…Zz11", "Bb22…Yy22", "Cc33…Xx33"]);
  });

  it("never touches a Dev card, even for a wallet the graph also puts in a cluster", () => {
    const dev = { type: "dev", tag: "Dev", pct: 12, addr: "Dd44…Ww44", repLbl: "Creator", repWidth: 40, repWarn: false, desc: "Creator wallet" };
    const root = mountScanCards([dev, insider(2, "Bb22…Yy22", 4.5)]);
    applyClusterCards(root, [cluster("Dd44…Ww44", 12)]);
    expect(cards(root)[0]).toEqual({ cls: "wp-card dev", tag: "Dev", addr: "Dd44…Ww44" });
  });

  it("does not invent a card for a wallet the scan did not show", () => {
    const root = mountScanCards([insider(1, "Aa11…Zz11", 4.5)]);
    expect(applyClusterCards(root, [cluster("Zz99…Qq99", 9)])).toBe(0);
    expect(cards(root)).toHaveLength(1);
  });

  it("does nothing twice: a card that is already a cluster card is left alone", () => {
    const root = mountScanCards([insider(1, "Aa11…Zz11", 4.5)]);
    expect(applyClusterCards(root, [cluster("Aa11…Zz11", 4.5)])).toBe(1);
    expect(applyClusterCards(root, [cluster("Aa11…Zz11", 4.5)])).toBe(0);
    expect(cards(root)).toHaveLength(1);
  });

  it("ignores anything that is not a cluster card", () => {
    const root = mountScanCards([insider(1, "Aa11…Zz11", 4.5)]);
    expect(applyClusterCards(root, [insider(1, "Aa11…Zz11", 9)])).toBe(0);
    expect(root.textContent).toContain("Holder #1");
  });

  it.each([[null], [undefined], ["nope"], [{}], [[]], [[null, 3, "x"]]])("is harmless with %j as the cards", (actors) => {
    const root = mountScanCards([insider(1, "Aa11…Zz11", 4.5)]);
    expect(applyClusterCards(root, actors as never)).toBe(0);
    expect(cards(root)).toHaveLength(1);
  });

  it("is harmless without a section to update", () => {
    expect(applyClusterCards(null, [cluster("Aa11…Zz11", 4.5)])).toBe(0);
    expect(applyClusterCards(document.getElementById("absent"), [cluster("Aa11…Zz11", 4.5)])).toBe(0);
  });

  it("works on the empty-state message too (no cards at all)", () => {
    document.body.innerHTML = `<div id="whales-preview">${buildCriticalActorsPreview({ criticalActors: [] })}</div>`;
    expect(applyClusterCards(document.getElementById("whales-preview"), [cluster("Aa11…Zz11", 4.5)])).toBe(0);
  });
});
