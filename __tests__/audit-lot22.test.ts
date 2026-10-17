// __tests__/audit-lot22.test.ts — Lot 22 of the file-by-file audit (2026-10-17): api/_lib/insider-graph.ts, insider-activity.ts.
// Fails on the previous code.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ fetchJson: vi.fn(), heliusRpc: vi.fn() }));
vi.mock("../api/_lib/helpers", () => ({ fetchJson: (...a: unknown[]) => mocks.fetchJson(...a) }));
vi.mock("../api/_lib/helius", () => ({ heliusRpc: (...a: unknown[]) => mocks.heliusRpc(...a) }));

import { buildInsiderGraph } from "../api/_lib/insider-graph";

const MINT = "TokenMint111111111111111111111111111111111";
const WALLETS = ["WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", "WalletCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"];

beforeEach(() => {
  mocks.fetchJson.mockReset().mockResolvedValue([]);
  // Each wallet has 25 signatures: A0..A24, B0..B24, C0..C24 (newest first).
  mocks.heliusRpc.mockReset().mockImplementation(async (_k: string, body: { params: [string] }) => {
    const w = body.params[0];
    const tag = w.slice(6, 7);
    return { result: Array.from({ length: 25 }, (_, i) => ({ signature: `${tag}${i}` })) };
  });
});

describe("insider graph — every analysed wallet's transactions are read", () => {
  it("the 20 signatures parsed come from all the wallets (they were all the largest holder's)", async () => {
    await buildInsiderGraph(MINT, WALLETS.map((address, i) => ({ address, uiAmount: 1000 - i })), 10_000, "key", new Set());
    const call = mocks.fetchJson.mock.calls.find((c) => String(c[0]).includes("/v0/transactions"));
    const sent = (JSON.parse(String((call?.[1] as RequestInit).body)) as { transactions: string[] }).transactions;
    expect(sent.length).toBe(20);
    const owners = new Set(sent.map((s) => s[0]));
    expect([...owners].sort()).toEqual(["A", "B", "C"]);
    expect(sent.slice(0, 3)).toEqual(["A0", "B0", "C0"]); // the newest of each wallet first
  });
});
