// npm run replay:update — replays the whole corpus and rewrites __tests__/replay/golden.json.
// Review `git diff __tests__/replay/golden.json`: every token whose verdict, score, flags or facts moved is listed there.
import { spawnSync } from "node:child_process";

const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "__tests__/replay"], {
  stdio: "inherit",
  env: { ...process.env, REPLAY_UPDATE: "1" },
});
process.exit(r.status ?? 1);
