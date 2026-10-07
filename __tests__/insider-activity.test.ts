// __tests__/insider-activity.test.ts — Coverage for the live activity feed.
//
// Why this matters: insider-activity.ts was the largest file in the API
// at 0% coverage flagged by the audit. It feeds the overlay's "Insider
// Watch" panel, contributes to the holder-flow signal, and is exposed
// to noisy upstream data (Helius RPC + REST). A silent regression here
// shows up as "the activity feed is stuck" on every Pro user's overlay
// without any error surfacing — exactly the kind of bug observability
// won't help with because nothing throws.
//
// We mock the network boundary (`fetchJson`) and exercise:
//   - Empty input (no holders / no signatures / no parsed txs)
//   - The four-way action classifier (BOUGHT / SOLD / TRANSFER_IN / OUT)
//   - Time-window cutoff (sigs older than WINDOW_HOURS dropped)
//   - Mint-match filter (txs without our mint excluded)
//   - USD value signing (inflow positive, outflow negative)
//   - Net-flow aggregation across the FULL window (not just the slice)
//   - Wallet-snapshot fallback when activity is empty
//   - Cache pass-through when redis returns a hit
//
// Redis stays null for most tests (the no-cache path is the hot path on
// fresh tokens and the only one where every branch can be exercised).
// One test exercises the cache-hit fast path explicitly.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildInsiderActivity,
  initActivityCache,
  type InsiderActivityHolder,
} from "../api/_lib/insider-activity";
import { HELIUS_BASE, HELIUS_REST_BASE } from "../api/_lib/constants";

// fetchJson is the only network seam — every Helius call goes through it.
// Mocking lets us script per-test responses for both the JSON-RPC sig
// fetch and the REST enhanced-tx parse with a single dispatcher.
const fetchJsonMock = vi.fn();
vi.mock("../api/_lib/http", async () => {
  const actual = await vi.importActual<typeof import("../api/_lib/http")>(
    "../api/_lib/http",
  );
  return {
    ...actual,
    fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  };
});

// getSignaturesForAddress goes through heliusRpc, which negotiates how the key
// is sent. Route it into the same fetchJson mock, as a POST to HELIUS_BASE, so
// scriptHelius keeps dispatching on it.
const heliusRpcMock = vi.fn(
  (_key: string, body: object, ms?: number, _retries?: number, _opts?: { usable?: (r: { result?: unknown }) => boolean }) =>
    fetchJsonMock(HELIUS_BASE, { method: "POST", body: JSON.stringify(body) }, ms),
);
vi.mock("../api/_lib/helius", () => ({
  heliusRpc: (...args: Parameters<typeof heliusRpcMock>) => heliusRpcMock(...args),
}));

// Helpers to build canonical Helius shapes without typing each test by hand.
interface MockSig {
  signature: string;
  blockTime?: number;
}
interface MockTx {
  signature: string;
  timestamp: number;
  type?: string;
  events?: { swap?: unknown };
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    tokenAmount?: number;
    mint?: string;
  }>;
}

const MINT = "mintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOLDER_A = "walletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOLDER_B = "walletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const STRANGER = "strangerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

const sec = (msAgo: number) => Math.floor((Date.now() - msAgo) / 1000);

/**
 * Wires fetchJsonMock to return:
 *   - per-wallet signatures when called against HELIUS_BASE (the RPC
 *     endpoint), routing by `params[0]` which is the wallet address.
 *   - parsed transactions when called against HELIUS_REST_BASE/v0/transactions,
 *     filtering the prepared `txs` map by the requested signature batch.
 */
function scriptHelius(opts: {
  sigsByWallet?: Record<string, MockSig[]>;
  txs?: MockTx[];
}) {
  const sigsByWallet = opts.sigsByWallet ?? {};
  const txs = opts.txs ?? [];
  fetchJsonMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith(HELIUS_BASE)) {
      // JSON-RPC body is in init.body (string). Parse to find the wallet.
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: unknown[];
      };
      if (body.method === "getSignaturesForAddress") {
        const wallet = String(body.params?.[0] ?? "");
        return { result: sigsByWallet[wallet] ?? [] };
      }
      return { result: [] };
    }
    if (url.startsWith(`${HELIUS_REST_BASE}/v0/transactions`)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        transactions?: string[];
      };
      const wanted = new Set(body.transactions ?? []);
      return txs.filter((t) => wanted.has(t.signature));
    }
    return null;
  });
}

beforeEach(() => {
  fetchJsonMock.mockReset();
  // Default: redis disabled — the no-cache path is what matters for
  // correctness and lets every branch run without Upstash mocking.
  initActivityCache(null);
});

// ═══ empty + degenerate inputs ═══════════════════════════════════════════════
describe("buildInsiderActivity — empty paths", () => {
  it("returns an empty result when no top holders are passed", async () => {
    scriptHelius({});
    const out = await buildInsiderActivity(MINT, [], 1_000_000, 0.5, "key");
    expect(out.activity).toEqual([]);
    expect(out.wallets).toEqual([]);
    expect(out.netFlowUsd).toBe(0);
    expect(out.totalCheckedWallets).toBe(0);
    expect(out.walletsWithActivity).toBe(0);
    expect(out.windowHours).toBe(6);
    // No fetch should fire — short-circuit on empty input.
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it("emits wallet snapshots with active=false when no signatures come back", async () => {
    scriptHelius({}); // every wallet returns []
    const holders: InsiderActivityHolder[] = [
      { owner: HOLDER_A, uiAmount: 100_000 },
      { owner: HOLDER_B, uiAmount: 50_000 },
    ];
    const out = await buildInsiderActivity(MINT, holders, 1_000_000, 0.1, "key");
    expect(out.activity).toEqual([]);
    expect(out.wallets).toHaveLength(2);
    expect(out.wallets.every((w) => w.active === false)).toBe(true);
    // pctSupply computed correctly
    expect(out.wallets[0].pctSupply).toBeCloseTo(10, 5);
    expect(out.wallets[1].pctSupply).toBeCloseTo(5, 5);
    expect(out.totalCheckedWallets).toBe(2);
    expect(out.walletsWithActivity).toBe(0);
  });

  it("guards against zero supply — pctSupply is 0 not NaN", async () => {
    scriptHelius({});
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1000 }],
      0,
      0.5,
      "key",
    );
    expect(out.wallets[0].pctSupply).toBe(0);
  });
});

// ═══ classification: BOUGHT / SOLD / TRANSFER_IN / TRANSFER_OUT ════════════
describe("buildInsiderActivity — action classifier", () => {
  const recentSig = (sig: string): MockSig => ({
    signature: sig,
    blockTime: sec(60 * 60 * 1000), // 1h ago, well inside the window
  });
  const recentTx = (sig: string): Pick<MockTx, "signature" | "timestamp"> => ({
    signature: sig,
    timestamp: sec(60 * 60 * 1000),
  });

  it("classifies a swap from a stranger to our holder as BOUGHT (positive USD)", async () => {
    scriptHelius({
      sigsByWallet: { [HOLDER_A]: [recentSig("sigBuy1")] },
      txs: [
        {
          ...recentTx("sigBuy1"),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 10_000,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 10_000 }],
      1_000_000,
      0.5,
      "key",
    );
    expect(out.activity).toHaveLength(1);
    expect(out.activity[0].action).toBe("BOUGHT");
    expect(out.activity[0].usdValue).toBe(5_000); // +10000 * 0.5
    expect(out.activity[0].walletFull).toBe(HOLDER_A);
    expect(out.netFlowUsd).toBe(5_000);
    expect(out.walletsWithActivity).toBe(1);
  });

  it("classifies a swap from our holder to a stranger as SOLD (negative USD)", async () => {
    scriptHelius({
      sigsByWallet: { [HOLDER_A]: [recentSig("sigSell1")] },
      txs: [
        {
          ...recentTx("sigSell1"),
          // No `type:"SWAP"` set — exercise the events.swap path instead
          events: { swap: { in: {}, out: {} } },
          tokenTransfers: [
            {
              fromUserAccount: HOLDER_A,
              toUserAccount: STRANGER,
              tokenAmount: 4_000,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 6_000 }],
      1_000_000,
      0.25,
      "key",
    );
    expect(out.activity[0].action).toBe("SOLD");
    expect(out.activity[0].usdValue).toBe(-1_000); // -4000 * 0.25
    expect(out.netFlowUsd).toBe(-1_000);
  });

  it("classifies a non-swap transfer from stranger as TRANSFER_IN", async () => {
    scriptHelius({
      sigsByWallet: { [HOLDER_A]: [recentSig("sigTin")] },
      txs: [
        {
          ...recentTx("sigTin"),
          // type undefined and no events.swap — plain transfer path
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 200,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 200 }],
      1_000_000,
      1,
      "key",
    );
    expect(out.activity[0].action).toBe("TRANSFER_IN");
    expect(out.activity[0].usdValue).toBe(200);
  });

  it("classifies a non-swap transfer to stranger as TRANSFER_OUT", async () => {
    scriptHelius({
      sigsByWallet: { [HOLDER_A]: [recentSig("sigTout")] },
      txs: [
        {
          ...recentTx("sigTout"),
          tokenTransfers: [
            {
              fromUserAccount: HOLDER_A,
              toUserAccount: STRANGER,
              tokenAmount: 50,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 100 }],
      1_000_000,
      2,
      "key",
    );
    expect(out.activity[0].action).toBe("TRANSFER_OUT");
    expect(out.activity[0].usdValue).toBe(-100);
  });

  it("leaves usdValue null when no token price is provided", async () => {
    scriptHelius({
      sigsByWallet: { [HOLDER_A]: [recentSig("sigNoPx")] },
      txs: [
        {
          ...recentTx("sigNoPx"),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 1,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1 }],
      1_000_000,
      null,
      "key",
    );
    expect(out.activity[0].usdValue).toBeNull();
    expect(out.netFlowUsd).toBe(0);
  });
});

// ═══ filters: time window + mint match + zero amount ═══════════════════════
describe("buildInsiderActivity — filters", () => {
  it("drops signatures older than WINDOW_HOURS", async () => {
    scriptHelius({
      sigsByWallet: {
        [HOLDER_A]: [
          { signature: "old", blockTime: sec(7 * 60 * 60 * 1000) }, // 7h ago
          { signature: "new", blockTime: sec(60 * 60 * 1000) }, // 1h ago
        ],
      },
      txs: [
        {
          signature: "new",
          timestamp: sec(60 * 60 * 1000),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 1,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1 }],
      1_000_000,
      1,
      "key",
    );
    expect(out.activity).toHaveLength(1);
    expect(out.activity[0].signature).toBe("new");
    expect(out._debug?.sigsTotal).toBe(2);
    expect(out._debug?.sigsAfterCutoff).toBe(1);
  });

  it("drops transactions whose tokenTransfers do not include our mint", async () => {
    const OTHER_MINT = "otherMintZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    scriptHelius({
      sigsByWallet: { [HOLDER_A]: [{ signature: "sig1", blockTime: sec(1000) }] },
      txs: [
        {
          signature: "sig1",
          timestamp: sec(1000),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 99,
              mint: OTHER_MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1 }],
      1_000_000,
      1,
      "key",
    );
    expect(out.activity).toEqual([]);
    expect(out._debug?.txsTouchingMint).toBe(0);
  });

  it("skips transfers with zero token amount", async () => {
    scriptHelius({
      sigsByWallet: { [HOLDER_A]: [{ signature: "z", blockTime: sec(1000) }] },
      txs: [
        {
          signature: "z",
          timestamp: sec(1000),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 0,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1 }],
      1_000_000,
      1,
      "key",
    );
    expect(out.activity).toEqual([]);
  });

  it("skips transfers when neither side belongs to a tracked holder", async () => {
    scriptHelius({
      sigsByWallet: { [HOLDER_A]: [{ signature: "s", blockTime: sec(1000) }] },
      txs: [
        {
          signature: "s",
          timestamp: sec(1000),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: STRANGER,
              tokenAmount: 100,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1 }],
      1_000_000,
      1,
      "key",
    );
    expect(out.activity).toEqual([]);
  });
});

// ═══ ordering, slicing, and net-flow aggregation ════════════════════════════
describe("buildInsiderActivity — ordering and aggregation", () => {
  it("sorts feed newest-first", async () => {
    scriptHelius({
      sigsByWallet: {
        [HOLDER_A]: [
          { signature: "older", blockTime: sec(3 * 60 * 60 * 1000) },
          { signature: "newer", blockTime: sec(1 * 60 * 60 * 1000) },
        ],
      },
      txs: [
        {
          signature: "older",
          timestamp: sec(3 * 60 * 60 * 1000),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 1,
              mint: MINT,
            },
          ],
        },
        {
          signature: "newer",
          timestamp: sec(1 * 60 * 60 * 1000),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 1,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1 }],
      1_000_000,
      1,
      "key",
    );
    expect(out.activity.map((a) => a.signature)).toEqual(["newer", "older"]);
  });

  it("computes netFlow across the FULL window even when feed is sliced", async () => {
    // Build 12 entries (>MAX_FEED_ENTRIES of 10) so we know slicing happens
    const sigs: MockSig[] = [];
    const txs: MockTx[] = [];
    for (let i = 0; i < 12; i++) {
      const sig = `sig${i}`;
      sigs.push({ signature: sig, blockTime: sec((i + 1) * 60 * 1000) });
      txs.push({
        signature: sig,
        timestamp: sec((i + 1) * 60 * 1000),
        type: "SWAP",
        tokenTransfers: [
          {
            fromUserAccount: STRANGER,
            toUserAccount: HOLDER_A,
            tokenAmount: 100,
            mint: MINT,
          },
        ],
      });
    }
    scriptHelius({ sigsByWallet: { [HOLDER_A]: sigs }, txs });
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 100 }],
      1_000_000,
      1, // $1 per token
      "key",
    );
    expect(out.activity).toHaveLength(10); // sliced
    // But net flow sums all 12 inflows: 12 * 100 * 1 = 1200
    expect(out.netFlowUsd).toBe(1200);
  });
});

// ═══ wallets snapshot (the fallback empty-state UI signal) ═════════════════
describe("buildInsiderActivity — wallet snapshot fallback", () => {
  it("marks the snapshot wallet as active when it appears in the feed", async () => {
    scriptHelius({
      sigsByWallet: {
        [HOLDER_A]: [{ signature: "live", blockTime: sec(1000) }],
        [HOLDER_B]: [],
      },
      txs: [
        {
          signature: "live",
          timestamp: sec(1000),
          type: "SWAP",
          tokenTransfers: [
            {
              fromUserAccount: STRANGER,
              toUserAccount: HOLDER_A,
              tokenAmount: 1,
              mint: MINT,
            },
          ],
        },
      ],
    });
    const out = await buildInsiderActivity(
      MINT,
      [
        { owner: HOLDER_A, uiAmount: 100 },
        { owner: HOLDER_B, uiAmount: 50 },
      ],
      1_000_000,
      1,
      "key",
    );
    const a = out.wallets.find((w) => w.walletFull === HOLDER_A);
    const b = out.wallets.find((w) => w.walletFull === HOLDER_B);
    expect(a?.active).toBe(true);
    expect(b?.active).toBe(false);
    expect(out.walletsWithActivity).toBe(1);
  });

  it("truncates wallet display strings to <prefix>...<suffix>", async () => {
    scriptHelius({});
    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1 }],
      1_000_000,
      1,
      "key",
    );
    expect(out.wallets[0].wallet).toMatch(/^.{4}\.\.\..{4}$/);
  });
});

// ═══ cache fast path ════════════════════════════════════════════════════════
describe("buildInsiderActivity — Redis cache hit", () => {
  it("returns the cached payload without hitting Helius when iact: key is warm", async () => {
    const cachedResult = {
      activity: [],
      wallets: [],
      netFlowUsd: 42,
      windowHours: 6,
      generatedAt: 1234,
      totalCheckedWallets: 7,
      walletsWithActivity: 0,
    };
    const fakeRedis = {
      get: vi.fn().mockResolvedValue(cachedResult),
      set: vi.fn(),
    } as unknown as import("@upstash/redis").Redis;
    initActivityCache(fakeRedis);
    fetchJsonMock.mockClear();

    const out = await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 1 }],
      1_000_000,
      1,
      "key",
    );
    expect(out).toEqual(cachedResult);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });
});

describe("buildInsiderActivity — how the Helius key is sent", () => {
  it("sends getSignaturesForAddress through heliusRpc, checking that the answer carries a result array", async () => {
    heliusRpcMock.mockClear();
    scriptHelius({ sigsByWallet: { [HOLDER_A]: [] } });

    await buildInsiderActivity(
      MINT,
      [{ owner: HOLDER_A, uiAmount: 100_000 } satisfies InsiderActivityHolder],
      1_000_000,
      0.5,
      "the-key",
    );

    expect(heliusRpcMock).toHaveBeenCalled();
    const [key, body, , , opts] = heliusRpcMock.mock.calls[0];
    expect(key).toBe("the-key");
    expect((body as { method: string }).method).toBe("getSignaturesForAddress");
    expect(opts?.usable?.({ result: [] })).toBe(true);
    expect(opts?.usable?.({})).toBe(false);
    expect(opts?.usable?.({ result: undefined })).toBe(false);
  });
});
