import { vi, describe, it, expect, beforeEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";

// ─── GET /api/graph ──────────────────────────────────────────────────────────────────────────────────────────────────
// The scan no longer builds the insider graph (~120 Helius credits per cold scan for a display-only feature): token.html gets it here,
// when its Insider Watch tab opens. This endpoint therefore has to be right on its own:
//  - the graph must be built from OWNER wallets, not from token accounts (a token account never appears in a parsed transfer, so the
//    graph found no cluster at all: audit M9);
//  - it returns the Cluster cards of the top of the page (`clusterActors`), for the same wallets the scan showed.

const mockLargest = vi.fn();
const mockSupply = vi.fn();
const mockOwners = vi.fn();
const mockBuildGraph = vi.fn();
const mockBuildActivity = vi.fn();

vi.mock("../api/_lib/middleware", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/middleware")>("../api/_lib/middleware");
  return { ...actual, initRateLimiters: vi.fn(), checkRateLimit: vi.fn().mockResolvedValue(true) };
});
vi.mock("../api/_lib/fetchers", () => ({
  heliusGetLargestAccounts: (...a: unknown[]) => mockLargest(...a),
  heliusGetTokenSupply: (...a: unknown[]) => mockSupply(...a),
  heliusResolveAccountOwners: (...a: unknown[]) => mockOwners(...a),
}));
vi.mock("../api/_lib/insider-graph", () => ({ buildInsiderGraph: (...a: unknown[]) => mockBuildGraph(...a), initGraphCache: vi.fn() }));
vi.mock("../api/_lib/insider-activity", () => ({ buildInsiderActivity: (...a: unknown[]) => mockBuildActivity(...a), initActivityCache: vi.fn() }));

process.env.HELIUS_API_KEY = "0123abcd-0123-4abc-8def-0123456789ab";
const { default: handler } = await import("../api/graph");

const MINT = "So11111111111111111111111111111111111111112";
const LP_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"; // a known LP program: must never count as a holder
const SUPPLY = 100_000;

function req(query: Record<string, string> = { ca: MINT }): VercelRequest {
  return { method: "GET", query, headers: { origin: "https://dexscreener.com", "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "1.2.3.4" } } as unknown as VercelRequest;
}
function mkRes() {
  const r = { code: 200, body: null as unknown, headers: {} as Record<string, string> } as {
    code: number; body: unknown; headers: Record<string, string>; setHeader: (k: string, v: string) => unknown; status: (c: number) => unknown; json: (b: unknown) => unknown; end: () => unknown;
  };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const run = async (query?: Record<string, string>) => { const res = mkRes(); await handler(req(query), res as unknown as VercelResponse); return res; };

/** The token accounts getTokenLargestAccounts returns, and the owner wallets they belong to. */
const accounts = Array.from({ length: 6 }, (_, i) => ({ address: `tokenAcct${i + 1}`, uiAmount: 5000 - i * 100 }));
const ownerOf = (a: string) => (a === "tokenAcct6" ? LP_PROGRAM : a.replace("tokenAcct", "ownerWallet"));

const emptyGraph = { nodes: [], edges: [], clusters: [], stats: { totalHolders: 6, analyzedWallets: 6, clusterCount: 0, insiderPct: 0 }, cachedAt: 1 };
const clusteredGraph = { ...emptyGraph, clusters: [{ wallets: ["ownerWallet1", "ownerWallet2"], totalPct: 9.9, label: "Cluster A" }], stats: { ...emptyGraph.stats, clusterCount: 1, insiderPct: 9.9 } };

beforeEach(() => {
  vi.clearAllMocks();
  mockLargest.mockResolvedValue({ result: { value: accounts } });
  mockSupply.mockResolvedValue({ result: { value: { uiAmount: SUPPLY } } });
  mockOwners.mockImplementation(async (holders: Array<{ address: string }>) => holders.map((h) => ({ ...h, owner: ownerOf(h.address) })));
  mockBuildGraph.mockResolvedValue(emptyGraph);
  mockBuildActivity.mockResolvedValue({ activity: [], wallets: [] });
});

describe("the graph is built from owner wallets", () => {
  it("not from the token accounts getTokenLargestAccounts returns (audit M9)", async () => {
    await run();
    const holders = mockBuildGraph.mock.calls[0][1] as Array<{ address: string; uiAmount: number }>;
    expect(holders.map((h) => h.address)).toEqual(["ownerWallet1", "ownerWallet2", "ownerWallet3", "ownerWallet4", "ownerWallet5"]);
    expect(holders.some((h) => h.address.startsWith("tokenAcct"))).toBe(false);
    expect(holders[0].uiAmount).toBe(5000);
  });

  it("without the LP programs and foundation wallets: they are not holders", async () => {
    await run();
    const holders = mockBuildGraph.mock.calls[0][1] as Array<{ address: string }>;
    expect(holders.map((h) => h.address)).not.toContain(LP_PROGRAM);
  });

  it("owners are resolved once, for the graph and the activity feed together", async () => {
    await run({ ca: MINT, activity: "1" });
    expect(mockOwners).toHaveBeenCalledTimes(1);
    const snapshots = mockBuildActivity.mock.calls[0][1] as Array<{ owner: string }>;
    expect(snapshots.map((s) => s.owner)).toEqual(["ownerWallet1", "ownerWallet2", "ownerWallet3", "ownerWallet4", "ownerWallet5"]);
  });
});

describe("clusterActors: the cards token.html swaps in", () => {
  it("one cluster card for each of the top holders that belongs to a cluster, with the wallet's short address", async () => {
    mockBuildGraph.mockResolvedValue(clusteredGraph);
    const res = await run({ ca: MINT, activity: "1" });
    const body = res.body as { clusterActors: Array<{ type: string; tag: string; addr: string; pct: number; desc: string }> };
    expect(body.clusterActors.map((a) => [a.type, a.tag, a.addr])).toEqual([
      ["cluster", "Cluster A", "owne…let1"],
      ["cluster", "Cluster A", "owne…let2"],
    ]);
    expect(body.clusterActors[0].pct).toBeCloseTo(5, 5); // 5,000 of a 100,000 supply
    expect(body.clusterActors[0].desc).toMatch(/cluster of <b>2 wallets<\/b>/);
  });

  it("only cluster cards: the plain holder cards are the scan's, and no Dev card is ever made here (the creator is unknown)", async () => {
    mockBuildGraph.mockResolvedValue(clusteredGraph);
    const body = (await run({ ca: MINT, activity: "1" })).body as { clusterActors: Array<{ type: string }> };
    expect(body.clusterActors.every((a) => a.type === "cluster")).toBe(true);
  });

  it("none when no cluster was found", async () => {
    const body = (await run({ ca: MINT, activity: "1" })).body as { clusterActors: unknown[] };
    expect(body.clusterActors).toEqual([]);
  });

  it("a cluster of 1 wallet, or of under 1 % of the supply, is noise and gets no card", async () => {
    mockBuildGraph.mockResolvedValue({ ...clusteredGraph, clusters: [{ wallets: ["ownerWallet1"], totalPct: 9, label: "A" }, { wallets: ["ownerWallet2", "ownerWallet3"], totalPct: 0.4, label: "B" }] });
    const body = (await run({ ca: MINT })).body as { clusterActors: unknown[] };
    expect(body.clusterActors).toEqual([]);
  });

  it("still answers the graph fields and the activity feed it always answered", async () => {
    mockBuildGraph.mockResolvedValue(clusteredGraph);
    mockBuildActivity.mockResolvedValue({ activity: [{ x: 1 }], wallets: [] });
    const body = (await run({ ca: MINT, activity: "1" })).body as { clusters: unknown[]; stats: unknown; activity: { activity: unknown[] } };
    expect(body.clusters).toHaveLength(1);
    expect(body.stats).toBeDefined();
    expect(body.activity.activity).toHaveLength(1);
  });

  it("a failing activity feed degrades to the graph, with its cards", async () => {
    mockBuildGraph.mockResolvedValue(clusteredGraph);
    mockBuildActivity.mockRejectedValue(new Error("helius down"));
    const res = await run({ ca: MINT, activity: "1" });
    const body = res.body as { activity: unknown; clusterActors: unknown[] };
    expect(res.code).toBe(200);
    expect(body.activity).toBeNull();
    expect(body.clusterActors).toHaveLength(2);
  });
});

describe("unchanged behaviour", () => {
  it("400 on an invalid address, before any upstream call", async () => {
    const res = await run({ ca: "not-an-address!" });
    expect(res.code).toBe(400);
    expect(mockLargest).not.toHaveBeenCalled();
  });

  it("404 when the token has no holder data", async () => {
    mockLargest.mockResolvedValue({ result: { value: [] } });
    expect((await run()).code).toBe(404);
    expect(mockBuildGraph).not.toHaveBeenCalled();
  });

  it("is cached by the CDN for 5 minutes", async () => {
    expect((await run()).headers["Cache-Control"]).toMatch(/s-maxage=300/);
  });

  it("500 when the graph cannot be built", async () => {
    mockBuildGraph.mockRejectedValue(new Error("boom"));
    expect((await run()).code).toBe(500);
  });
});
