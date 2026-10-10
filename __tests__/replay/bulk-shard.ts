// __tests__/replay/bulk-shard.ts
//
// The replay of one shard of the bulk corpus (see bulk.ts). replay-bulk-<n>.test.ts calls defineBulkShard(n): the shards are
// separate test files so that vitest runs them in parallel workers (the engine is replayed through a process-wide fetch and
// clock, so tokens of one file can only run one after the other).
//
// Per token: the scan answers and every request it makes was recorded. Then, ONE check for the whole shard: no token moved
// from its golden line (golden-bulk/<n>.jsonl, one line per token). The failure lists the tokens that moved, with the verdict,
// score and flags that changed, so that a pull request touching the engine says which tokens it moves and why.
//
// By default only the sample (about a tenth of the bulk) runs, which keeps `npm test` fast; REPLAY_FULL=1 runs everything
// (the `replay` job of the CI), REPLAY_UPDATE=1 rewrites the golden lines (npm run replay:update).
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inSample, shardOf, type BulkToken } from "./bulk";
import { loadBulk, loadRecording, recordedMints, replayScan } from "./harness";
import type { NormalizedScan } from "./normalize";

const GOLDEN_DIR = fileURLToPath(new URL("./golden-bulk/", import.meta.url));
export const goldenFile = (shard: number): string => `${GOLDEN_DIR}${shard}.jsonl`;
export const UPDATE = process.env.REPLAY_UPDATE === "1";
export const FULL = UPDATE || process.env.REPLAY_FULL === "1";

interface GoldenLine { mint: string; symbol: string; scan: NormalizedScan }

export function readGolden(shard: number): Map<string, GoldenLine> {
  const file = goldenFile(shard);
  const out = new Map<string, GoldenLine>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const g = JSON.parse(line) as GoldenLine;
    out.set(g.mint, g);
  }
  return out;
}

/** What changed between two normalized scans of a token, in one line ("" when nothing). */
export function describeMove(token: { mint: string; symbol: string }, was: NormalizedScan | undefined, now: NormalizedScan): string {
  const name = `${token.symbol} (${token.mint.slice(0, 8)})`;
  if (!was) return `${name}: no golden line (now ${now.risk} ${now.score})`;
  const parts: string[] = [];
  if (was.risk !== now.risk || was.score !== now.score) parts.push(`${was.risk} ${was.score} -> ${now.risk} ${now.score}`);
  const added = now.flags.filter((f) => !was.flags.includes(f));
  const removed = was.flags.filter((f) => !now.flags.includes(f));
  if (added.length) parts.push(`+[${added.join("; ")}]`);
  if (removed.length) parts.push(`-[${removed.join("; ")}]`);
  for (const k of Object.keys(now) as Array<keyof NormalizedScan>) {
    if (k === "risk" || k === "score" || k === "flags") continue;
    if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) parts.push(`${k} ${JSON.stringify(was[k])} -> ${JSON.stringify(now[k])}`);
  }
  return parts.length ? `${name}: ${parts.join(" | ")}` : "";
}

export function defineBulkShard(shard: number): void {
  const recorded = new Set(recordedMints());
  const members: BulkToken[] = loadBulk().filter((t) => shardOf(t.mint) === shard && recorded.has(t.mint));
  const tokens = FULL ? members : members.filter((t) => inSample(t.mint));
  const golden = readGolden(shard);
  const replayed = new Map<string, NormalizedScan>();
  const moved: string[] = [];

  describe(`bulk replay, shard ${shard} (${tokens.length} of ${members.length} recorded tokens)`, () => {
    for (const token of tokens) {
      it(`${token.symbol} ${token.mint.slice(0, 8)}: answers, and every upstream request it makes was recorded`, async () => {
        const outcome = await replayScan(loadRecording(token.mint)!);
        replayed.set(token.mint, outcome.result);
        const move = UPDATE ? "" : describeMove(token, golden.get(token.mint)?.scan, outcome.result);
        if (move) moved.push(move);
        expect(outcome.status).toBe(200);
        expect(outcome.misses, "the engine now makes a request that is not in the recording: refresh it (scripts/replay/README.md)").toEqual([]);
      }, 60_000);
    }

    it.skipIf(UPDATE)("no token moved from its golden line", () => {
      const shown = moved.slice(0, 60);
      expect(moved.length, `${moved.length} token(s) moved. If that is intended, run \`npm run replay:update\` and review the diff of golden-bulk/.\n${shown.join("\n")}${moved.length > shown.length ? `\n... and ${moved.length - shown.length} more` : ""}`).toBe(0);
    });

    it.skipIf(UPDATE || !FULL)("the golden file holds exactly the recorded tokens of the shard", () => {
      expect([...golden.keys()].sort()).toEqual(members.map((t) => t.mint).sort());
    });
  });

  afterAll(() => {
    if (!UPDATE || replayed.size !== members.length) return;
    mkdirSync(GOLDEN_DIR, { recursive: true });
    const lines = [...members].sort((a, b) => (a.mint < b.mint ? -1 : 1)).map((t) => JSON.stringify({ mint: t.mint, symbol: t.symbol, scan: replayed.get(t.mint) }));
    writeFileSync(goldenFile(shard), `${lines.join("\n")}\n`);
    console.log(`[replay] golden-bulk/${shard}.jsonl rewritten for ${lines.length} tokens`);
  });
}
