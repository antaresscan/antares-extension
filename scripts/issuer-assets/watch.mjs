// scripts/issuer-assets/watch.mjs
//
// Says whether Jupiter's verified list still matches the committed registry (api/_lib/issuer-assets.data.ts). Run every Monday by
// .github/workflows/issuer-registry-watch.yml, which opens (or updates) one issue when it does not.
//
//   node scripts/issuer-assets/watch.mjs [--report report.md] [--from verified.json] [--data api/_lib/issuer-assets.data.ts]
//
// It READS: the list (downloaded, or --from a saved copy) and the data file. It writes nothing but the --report file, and only when the two
// differ (an older report is removed when they match). It never changes the registry: a refresh is a pull request that shows the verdicts
// that move (node scripts/issuer-assets/build.mjs, see the issue). A list that looks broken (too short, a hand-checked address gone) or a data
// file in a shape it does not know ends the run with an error: the red run is the signal then, not a wrong comparison.
import fs from "node:fs";
import path from "node:path";
import { assertPlausible, classify, diffRegistry, loadList, parseRegistry, renderReport, symbolsOf } from "./lib.mjs";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataPath = path.resolve(arg("--data") ?? "api/_lib/issuer-assets.data.ts");
const reportPath = arg("--report");

const list = await loadList(arg("--from"));
const fresh = classify(list);
assertPlausible(list, fresh);
const committed = parseRegistry(fs.readFileSync(dataPath, "utf8"));
const diff = diffRegistry(committed, fresh);

if (reportPath) fs.rmSync(reportPath, { force: true });
if (!diff) {
  console.log(`The registry matches Jupiter's verified list (${committed.date}, ${list.length} verified tokens now).`);
} else {
  console.log(`The registry is out of date: ${diff.added} added, ${diff.removed} removed since ${committed.date}.`);
  if (reportPath) {
    fs.writeFileSync(reportPath, renderReport(diff, {
      symbols: symbolsOf(list), committedDate: committed.date, committedVerified: committed.verified, freshVerified: list.length, today: new Date().toISOString().slice(0, 10),
    }));
    console.log(`Report written to ${reportPath}`);
  }
}
