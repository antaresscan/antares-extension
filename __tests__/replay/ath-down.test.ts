// __tests__/replay/ath-down.test.ts
//
// What a scan does when CoinGecko does not answer (api/_lib/ath.ts): the verdict the engine gave BEFORE the all-time high existed (no relief, no softening, no flag), never a
// different or a wrong one, and a scan that needed the high says so (`degraded`), so that it is kept 30 seconds and not for the full TTL: one hiccup of CoinGecko must not pin
// a DANGER on CARDS for ten minutes. The verdicts below are the ones master gave on these recordings. Replayed on the 1 090 bulk tokens with CoinGecko down (audit,
// 2026-10-16), every verdict AND score was master's, and not one flag of the new rules appeared.
import { describe, it, expect } from "vitest";
import { loadRecording, replayScan } from "./harness";

const BEFORE: Array<{ symbol: string; mint: string; risk: string; score: number; degraded: boolean; why: string }> = [
  { symbol: "CARDS", mint: "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp", risk: "DANGER", score: 500, degraded: true, why: "needs the high for its relief" },
  { symbol: "MET", mint: "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL", risk: "RUG", score: 100, degraded: true, why: "needs the high for its relief" },
  { symbol: "SPX", mint: "J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr", risk: "DANGER", score: 500, degraded: true, why: "needs the high to soften its bridge-held mint authority" },
  { symbol: "LUNA", mint: "9se6kma7LeGcQWyRBNcYzyxZPE3r9t9qWZ8SnjnN3jJ7", risk: "DANGER", score: 500, degraded: true, why: "a bridge-held mint authority, history unknown" },
  { symbol: "GRIFFAIN", mint: "KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP", risk: "CAUTION", score: 868, degraded: false, why: "the high only adds a flag: its absence is the verdict of before, not a gap" },
];
const NEW_FLAGS = /all-time high|established token, exchanges, treasuries|established token, a treasury|Mint held by the .+ bridge/;

describe("CoinGecko down: the verdict of before, and a scan that says it is missing something", () => {
  it.each(BEFORE.map((b) => [b.symbol, b] as const))("%s", async (_s, b) => {
    const rec = loadRecording(b.mint);
    expect(rec, `${b.symbol} has no recording`).not.toBeNull();
    const down = await replayScan(rec!, { athDown: true });
    expect(down.misses).toEqual([]);
    expect({ risk: down.result.risk, score: down.result.score }, b.why).toEqual({ risk: b.risk, score: b.score });
    expect(down.result.flags.filter((f) => NEW_FLAGS.test(f))).toEqual([]);
    expect((down.body as { degraded?: boolean }).degraded === true, b.why).toBe(b.degraded);
  });
  it("witness: with CoinGecko answering, the same recording gets the relief (the check can fail)", async () => {
    const up = await replayScan(loadRecording(BEFORE[0].mint)!);
    expect(up.result.risk).toBe("CAUTION");
    expect((up.body as { degraded?: boolean }).degraded === true).toBe(false);
  });
});
