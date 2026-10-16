// __tests__/replay/ath-solscan.test.ts
//
// Solscan gives the all-time high as a DAILY price (api/_lib/ath.ts): a little under the intraday high that the owner's line (ATH_COLLAPSE_PCT, 90 %) is written on. The test of
// that: the same recordings replayed with Solscan answering a daily series whose highest day is 92 % (PYTH, measured live on 2026-10-16: 1.10 against 1.20), 80 % and 60 % of
// CoinGecko's high must give the verdict AND the score that CoinGecko's high gives. The tokens that stand next to the line are where a daily high would flip a verdict (YZY, -90.2 %,
// would otherwise become a CAUTION), and the whole corpus is replayed when REPLAY_FULL=1.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRecording, recordedMints, replayScan } from "./harness";

const FULL = process.env.REPLAY_FULL === "1" || process.env.REPLAY_UPDATE === "1";
const table = (JSON.parse(readFileSync(fileURLToPath(new URL("./ath.json", import.meta.url)), "utf8")) as { tokens: Record<string, unknown> }).tokens;

// The tokens that stand within reach of the line, and the ones the owner names.
const NEXT_TO_THE_LINE: Array<[string, string]> = [
  ["YZY", "DrZ26cKJDksVRWib3DVVsjo9eeXccc7hKhDJviiYEEZY"], ["RAY", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"], ["CLOUD", "CLoUDKc4Ane7HeQcPpE3YHnznRxhMimJ4MyaUqyHFzAu"],
  ["ORCA", "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE"], ["DOG", "dog1viwbb2vWDpER5FrJ4YFG6gq6XuyFohUe9TXN65u"], ["BIRB", "G7vQWurMkMMm2dU3iZpXYFTHT9Biio4F4gZCrwFpKNwG"],
  ["BORG", "3dQTr7ror2QPKQ3GbBCokJUmjErGg8kTJzdnYjNfvi3Z"], ["ANTFUN", "CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt"], ["BAT", "EPeUFDgHRxs9xxEPVaL6kfGQvCon7jmAWKVUHuux1Tpz"],
  ["PENGU", "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"], ["JELLYJELLY", "FeR8VBqNRSUD5NtXAj2n3j1dAHkZHfyDktKuLXD4pump"], ["ORE", "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp"],
  ["JTO", "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"], ["ENA", "72QvBVwpxqmheEPfaCwWSWqEFsUy3rhWt6JhQBMNTwD1"], ["VIRTUAL", "3iQL8BFS2vE7mww4ehAqQHAsbmRNCrPxizWAT2Zfyr9y"],
];
const NAMED: Array<[string, string]> = [
  ["CARDS", "CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp"], ["MET", "METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL"], ["SPX", "J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr"],
  ["JUP", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"], ["LUNA", "9se6kma7LeGcQWyRBNcYzyxZPE3r9t9qWZ8SnjnN3jJ7"], ["TRUNK", "9mV4WUukVsva5wYcYW4veo34CNDiF44sh3Ji65JNdvh5"],
  ["MELANIA", "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P"], ["GRIFFAIN", "KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP"], ["ZEREBRO", "8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn"],
  ["PYTH", "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3"], ["BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"], ["WIF", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"],
];
const SAMPLE = [...NEXT_TO_THE_LINE, ...NAMED].filter(([, mint]) => loadRecording(mint) !== null);
const ALL = recordedMints().filter((m) => m in table).map((m) => [m.slice(0, 6), m] as [string, string]);

const FACTORS = [0.92, 0.8, 0.6];
const verdict = (r: { result: { risk: string; score: number } }) => ({ risk: r.result.risk, score: r.result.score });

describe("a daily high from Solscan gives the verdict of CoinGecko's intraday high", () => {
  it("the recordings exist (the test cannot pass on an empty list)", () => {
    expect(SAMPLE.length).toBeGreaterThanOrEqual(25);
  });
  it.each(SAMPLE)("%s", async (_symbol, mint) => {
    const rec = loadRecording(mint)!;
    const reference = verdict(await replayScan(rec));
    for (const factor of FACTORS) {
      const viaSolscan = await replayScan(rec, { athViaSolscan: factor });
      expect(verdict(viaSolscan), `a daily high at ${factor} of the intraday one`).toEqual(reference);
    }
  });
  it.skipIf(!FULL)("the whole corpus, one daily high at 92 % of the intraday one", async () => {
    const moved: string[] = [];
    for (const [symbol, mint] of ALL) {
      const rec = loadRecording(mint)!;
      const reference = verdict(await replayScan(rec));
      const got = verdict(await replayScan(rec, { athViaSolscan: 0.92 }));
      if (got.risk !== reference.risk || got.score !== reference.score) moved.push(`${symbol} ${mint}: ${reference.risk} ${reference.score} -> ${got.risk} ${got.score}`);
    }
    expect(moved).toEqual([]);
  }, 600_000);
  it("witness: YZY (-90.2 % by CoinGecko) with a daily high at 92 % and CoinGecko DOWN is NOT what CoinGecko's high gives (the check can fail), and the scan says that it is missing something", async () => {
    const rec = loadRecording("DrZ26cKJDksVRWib3DVVsjo9eeXccc7hKhDJviiYEEZY")!;
    const reference = verdict(await replayScan(rec));
    expect(reference.risk).toBe("RUG");
    const blind = await replayScan(rec, { athViaSolscan: 0.92, athDown: true });
    expect(verdict(blind)).not.toEqual(reference);
    expect((blind.body as { degraded?: boolean }).degraded).toBe(true);
  });
  it("witness: Solscan's high IS used (RAY, -89 %): with CoinGecko down the daily high keeps its relief, the scan says it is missing something, and without any high it would be a DANGER", async () => {
    const rec = loadRecording("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R")!;
    const withDaily = await replayScan(rec, { athViaSolscan: 0.92, athDown: true });
    expect(withDaily.result.risk).toBe("CAUTION");
    expect((withDaily.body as { degraded?: boolean }).degraded).toBe(true);
    const nothing = await replayScan(rec, { athDown: true });
    expect(nothing.result.risk).toBe("DANGER");
  });
});
