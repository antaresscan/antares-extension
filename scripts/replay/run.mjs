// Runs the replay in one of its modes (npm run replay:full | replay:update | replay:verify), the same way on every OS.
//
//   full     the whole corpus (the default `npm run replay` only runs the hand-vetted tokens and a tenth of the bulk).
//   update   replays the whole corpus and rewrites the golden files (golden.json and golden-bulk/*.jsonl). Review
//            `git diff --stat __tests__/replay` and the diff of the golden files: every token whose verdict, score, flags or facts
//            moved is listed there. Then prints how the verdicts spread over the weak labels of the bulk and where the two
//            counts of bulk-baseline.json stand.
//   verify   right after a capture: every replay must give what the real scan gave when it was recorded (fidelity.test.ts).
//            REPLAY_VERIFY_ONLY=mint1,mint2 limits it to some recordings.
import { spawnSync } from "node:child_process";

const mode = process.argv[2];
const modes = { full: { REPLAY_FULL: "1" }, update: { REPLAY_UPDATE: "1" }, verify: { REPLAY_VERIFY: "1" } };
if (!modes[mode]) { console.error("usage: node scripts/replay/run.mjs full|update|verify"); process.exit(2); }

const vitest = (files, env) => spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...files], { stdio: "inherit", env: { ...process.env, ...env } });

const first = vitest(["__tests__/replay"], modes[mode]);
if (mode === "update") {
  console.log("\n--- where the bulk corpus stands now (against bulk-baseline.json) ---");
  vitest(["__tests__/replay/replay-bulk-summary.test.ts"], {});
}
process.exit(first.status ?? 1);
