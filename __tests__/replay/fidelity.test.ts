// __tests__/replay/fidelity.test.ts
//
// Only runs with REPLAY_VERIFY=1, right after a capture (`npm run replay:verify`). A recording keeps, as `live`, what the REAL scan
// answered while it was recorded; replaying the recording must give the same verdict, score, flags and facts. If it does not, the
// replay is not faithful to a real scan (a call that was not recorded, a state that leaked from one token to the next, a clock...)
// and the recording must not enter the corpus.
//
// It is meaningless later: once the engine changes, the replay is SUPPOSED to differ from what the old engine answered (that is
// what the golden files are for). So it compares only recordings made by the code of the working tree: capture, verify, then update.
import { describe, it, expect } from "vitest";
import { loadBulk, loadRecording, recordedMints, replayScan } from "./harness";
import { REPLAY_TOKENS } from "./manifest";
import { describeMove } from "./bulk-shard";

const VERIFY = process.env.REPLAY_VERIFY === "1";
const names = new Map<string, string>([...REPLAY_TOKENS, ...loadBulk()].map((t) => [t.mint, t.symbol]));
/** REPLAY_VERIFY_ONLY=mint1,mint2 limits the check (default: every recording). */
const only = (process.env.REPLAY_VERIFY_ONLY ?? "").split(",").filter(Boolean);

describe.skipIf(!VERIFY)("a replay gives what the real scan gave when it was recorded", () => {
  const mints = recordedMints().filter((m) => only.length === 0 || only.includes(m));
  const unfaithful: string[] = [];
  for (const mint of mints) {
    it(`${names.get(mint) ?? mint} ${mint.slice(0, 8)}`, async () => {
      const rec = loadRecording(mint)!;
      const out = await replayScan(rec);
      const move = describeMove({ mint, symbol: rec.symbol }, rec.live, out.result);
      if (move) unfaithful.push(move);
      expect(out.misses).toEqual([]);
    }, 60_000);
  }
  it("every replay equals its live scan", () => {
    expect(unfaithful, `${unfaithful.length} unfaithful replay(s) out of ${mints.length}`).toEqual([]);
  });
});
