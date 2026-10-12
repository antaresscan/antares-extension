// A layer or a flag built by hand in a test has a label and nothing else. The engine's own layers say what each flag is: which safe-gate
// reasons it stands for (ScanFlag.reasons / fallbackReasons) and what kind of signal it is (ScanFlag.tags, ScanFlag.pumpPct), and the
// engine reads those, never the label. This gives a hand-built flag what the layer would have put on it for that label. The rules below
// are the specification the layers' own flags are held to (flag-codes-layers.test.ts); the engine does not run them, except at the door
// for text an upstream invents (api/_lib/upstream-text.ts).
import { makeFlag } from "../../api/_lib/helpers";
import { codesFromUpstreamText } from "../../api/_lib/upstream-text";
import type { FlagTag, ScanFlag, Severity } from "../../api/_lib/types";

const CONCENTRATION = /concentration|well distributed/i;
const XV: Array<[RegExp, FlagTag]> = [
  [/LP burn conflict/i, "xv_lp_burn"],
  [/Mint authority conflict/i, "xv_mint_authority"],
  [/age conflict/i, "xv_age"],
  [/holder concentration/i, "xv_holder_concentration"],
];

/** The pump percentage of a pump label: the first "+N%" of a label that speaks of a pump (what the pump deduplication used to read). */
export function pumpPctOfText(label: string): number | undefined {
  if (!/pump|pumped/i.test(label)) return undefined;
  const m = label.match(/\+(\d+)%/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** The tags the label would have had, among all of them (the layer a flag belongs to decides two of them). */
function allTags(source: string, label: string, doorTags: FlagTag[]): FlagTag[] {
  const tags: FlagTag[] = [...doorTags];
  if (source === "helius" && CONCENTRATION.test(label)) tags.push("concentration");
  if (source === "crossvalidation") {
    for (const [re, t] of XV) if (re.test(label)) { tags.push(t); break; }
  }
  return tags;
}

/** A flag as the layer of `source` would have made it for this label. */
export function flagFromText(label: string, severity: Severity = "critical", impact = 0, source = "dexscreener"): ScanFlag {
  const codes = codesFromUpstreamText(source, label);
  return makeFlag(label, severity, impact, { ...codes, tags: allTags(source, label, codes.tags ?? []), pumpPct: pumpPctOfText(label) });
}

/** The same, for flags that are already built: a flag that already says something is left as it is. */
export function flagsWithCodes(source: string, flags: ScanFlag[]): ScanFlag[] {
  return flags.map((f) => (f.reasons || f.fallbackReasons || f.tags || f.pumpPct !== undefined ? f : flagFromText(f.label, f.severity, f.impact, source)));
}
