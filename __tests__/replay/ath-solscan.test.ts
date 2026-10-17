// __tests__/replay/ath-solscan.test.ts
//
// The history of a token comes from Solscan alone (api/_lib/ath.ts, token/price: ONE price a day) and the question "is its market alive?" from Jupiter's organic score
// (api/_lib/jupiter.ts). Solscan's daily high is a little under an intraday one (PYTH, measured on 2026-10-16: 1.10 against 1.20 = 92 %), and a launch that pumped and dumped within hours
// can have a daily high far under its real one (YZY, GRIFFAIN). The harness answers both services from tables (harness.ts) so that these properties can be tested on the real recordings:
//   1. what a relief or a softening decides does not move when the daily high is lower than assumed (a serious token is clean either way);
//   2. a market that is not alive is never relieved, whatever the history says (the daily high cannot see a spike: Jupiter's score can);
//   3. without Solscan, or without Jupiter, there is no relief: the verdict the engine gave before, and a scan that says it is missing data.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRecording, recordedMints, replayScan, DAILY_HIGH_SHARE } from "./harness";

const FULL = process.env.REPLAY_FULL === "1" || process.env.REPLAY_UPDATE === "1";
const table = (JSON.parse(readFileSync(fileURLToPath(new URL("./ath.json", import.meta.url)), "utf8")) as { tokens: Record<string, unknown> }).tokens;
const verdict = (r: { result: { risk: string; score: number } }) => ({ risk: r.result.risk, score: r.result.score });
const degraded = (r: { body: Record<string, unknown> | null }) => (r.body as { degraded?: boolean }).degraded === true;

// The tokens a relief or a softening decides, the owner's serious ones (CAUTION), and the ones whose market is not alive (organic score 0).
const SERIOUS: Array<[string, string]> = [
  ["CARDS", "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp"], ["MET", "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL"], ["SPX", "J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr"],
  ["JUP", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"], ["RAY", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"], ["BC", "BCNT4t3rv5Hva8RnUtJUJLnxzeFAabcYp8CghC1SmWin"],
  ["DBR", "DBRiDgJAMsM95moTzJs7M9LnkGErpbv9v6CUR1DXnUu5"], ["HUMA", "HUMA1821qVDKta3u2ovmfDQeW2fSQouSKE8fkF44wvGw"], ["NPC", "BeGY8KqKxboEwRbJd1q9H2K829jS4Rc5dEyNMYXCbV5p"],
  ["ANSEM", "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump"],
];
const DEAD: Array<[string, string]> = [
  ["YZY", "DrZ26cKJDksVRWib3DVVsjo9eeXccc7hKhDJviiYEEZY"], ["MELANIA", "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P"], ["LUNA", "9se6kma7LeGcQWyRBNcYzyxZPE3r9t9qWZ8SnjnN3jJ7"],
  ["TRUNK", "9mV4WUukVsva5wYcYW4veo34CNDiF44sh3Ji65JNdvh5"], ["BAN", "9PR7nCP9DpcUotnDPVLUBUZKu5WAYkwrCUx9wDnSpump"], ["JELLYJELLY", "FeR8VBqNRSUD5NtXAj2n3j1dAHkZHfyDktKuLXD4pump"],
  ["ALCH", "HNg5PYJmtqcmzXrv6S9zP1CDKk5BgDuyFBxbvNApump"], ["NST", "G7iK3prSzAA4vzcJWvsLUEsdCqzR7PnMzJV61vSdFSNW"],
];
const RELIEVED = (r: { result: { risk: string } }) => r.result.risk === "CAUTION" || r.result.risk === "SAFE";

describe("the model of Solscan's daily series is the one measured", () => {
  it("a daily high at 92 % of the intraday one (PYTH: 1.10 against 1.20)", () => {
    expect(DAILY_HIGH_SHARE).toBe(0.92);
  });
});

describe("1. a serious token is clean whatever the daily high: what a relief decides does not move", () => {
  it("the recordings exist (the test cannot pass on an empty list)", () => {
    for (const [symbol, mint] of [...SERIOUS, ...DEAD]) expect(loadRecording(mint), symbol).not.toBeNull();
  });
  it.each(SERIOUS)("%s is relieved (CAUTION) at the default daily high and at 80 %, 60 %, 30 % and 10 % of the intraday one", async (_symbol, mint) => {
    const rec = loadRecording(mint)!;
    const reference = await replayScan(rec);
    expect(RELIEVED(reference), "the reference is relieved").toBe(true);
    expect(degraded(reference)).toBe(false);
    for (const dailyShare of [0.8, 0.6, 0.3, 0.1]) expect(verdict(await replayScan(rec, { dailyShare })), `a daily high at ${dailyShare}`).toEqual(verdict(reference));
  }, 60_000); // five replays of one recording: a machine under load needs more than the default five seconds
});

describe("2. a market that is not alive is never relieved, whatever the history says", () => {
  it.each(DEAD)("%s stays what the engine called it before (DANGER or RUG) at every daily high, even when the history looks clean", async (_symbol, mint) => {
    const rec = loadRecording(mint)!;
    for (const dailyShare of [DAILY_HIGH_SHARE, 0.5, 0.1]) {
      const r = await replayScan(rec, { dailyShare });
      expect(RELIEVED(r), `at a daily high of ${dailyShare}: ${r.result.risk} ${r.result.score}`).toBe(false);
    }
  }, 60_000);
  it("witness: the organic score is what grants the relief (the check can fail): CARDS is relieved with Jupiter's answer and is not without it", async () => {
    const cards = loadRecording("CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp")!;
    expect((await replayScan(cards)).result.risk).toBe("CAUTION");
    expect((await replayScan(cards, { organicDown: true })).result.risk).toBe("DANGER");
  });
});

describe("3. without Solscan, or without Jupiter: no relief, the verdict of before, and a scan that says it is missing data", () => {
  // The verdicts below are the ones master gave on these recordings (replayed on the 1 090 bulk tokens with the history missing: every verdict and score was master's).
  const BEFORE: Array<{ symbol: string; mint: string; risk: string; score: number; degraded: boolean; why: string }> = [
    { symbol: "CARDS", mint: "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp", risk: "DANGER", score: 500, degraded: true, why: "needs the high for its relief" },
    { symbol: "MET", mint: "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL", risk: "RUG", score: 100, degraded: true, why: "needs the high for its relief" },
    { symbol: "SPX", mint: "J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr", risk: "DANGER", score: 500, degraded: true, why: "needs the high to soften its bridge-held mint authority" },
    { symbol: "LUNA", mint: "9se6kma7LeGcQWyRBNcYzyxZPE3r9t9qWZ8SnjnN3jJ7", risk: "DANGER", score: 500, degraded: true, why: "a bridge-held mint authority, history unknown" },
  ];
  const NEW_FLAGS = /all-time high|established token, exchanges, treasuries|established token, a treasury|Mint held by the .+ bridge/;
  it.each(BEFORE.map((b) => [b.symbol, b] as const))("%s with Solscan down", async (_s, b) => {
    const down = await replayScan(loadRecording(b.mint)!, { athDown: true });
    expect({ risk: down.result.risk, score: down.result.score }, b.why).toEqual({ risk: b.risk, score: b.score });
    expect(down.result.flags.filter((f) => NEW_FLAGS.test(f))).toEqual([]);
    expect(degraded(down), b.why).toBe(b.degraded);
  });
  it.each(BEFORE.filter((b) => b.symbol !== "LUNA").map((b) => [b.symbol, b] as const))("%s with Jupiter down", async (_s, b) => {
    const down = await replayScan(loadRecording(b.mint)!, { organicDown: true });
    expect({ risk: down.result.risk, score: down.result.score }, b.why).toEqual({ risk: b.risk, score: b.score });
    expect(down.result.flags.filter((f) => NEW_FLAGS.test(f))).toEqual([]);
    expect(degraded(down)).toBe(true);
  });
  it("a flag only adds a warning: with Solscan down GRIFFAIN is the verdict of before, and that is not a gap", async () => {
    const down = await replayScan(loadRecording("KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP")!, { athDown: true });
    expect(down.result.flags.some((f) => /all-time high/.test(f))).toBe(false);
    expect(degraded(down)).toBe(false);
  });
});

describe("4. a daily high far under the real one only costs the FLAG, never gives a relief (whole corpus: REPLAY_FULL=1)", () => {
  it.skipIf(!FULL)("at 80 % and at 60 % of the intraday high, every token that moves is a token that loses its all-time-high flag", async () => {
    const wrong: string[] = [];
    for (const mint of recordedMints().filter((m) => m in table)) {
      const rec = loadRecording(mint)!;
      const reference = await replayScan(rec);
      const hadFlag = reference.result.flags.some((f) => /all-time high/.test(f));
      for (const dailyShare of [0.8, 0.6]) {
        const got = await replayScan(rec, { dailyShare });
        const moved = got.result.risk !== reference.result.risk || got.result.score !== reference.result.score;
        if (moved && (!hadFlag || got.result.flags.some((f) => /all-time high/.test(f)))) wrong.push(`${rec.symbol} at ${dailyShare}: ${reference.result.risk} ${reference.result.score} -> ${got.result.risk} ${got.result.score}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 900_000);
});
