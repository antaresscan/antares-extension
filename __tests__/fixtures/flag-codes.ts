// A layer built by hand in a test has flags with a label and nothing else. The engine's own layers put the safe-gate reasons on their
// flags (ScanFlag.reasons / fallbackReasons) and the classifier reads those, not the label. This gives such a flag the codes it would
// carry if its label were text an upstream invented: read once from the label, by the same tables the engine uses at that door.
import { makeFlag } from "../../api/_lib/helpers";
import { codesFromUpstreamText } from "../../api/_lib/upstream-text";
import type { ScanFlag } from "../../api/_lib/types";

export function flagsWithCodes(source: string, flags: ScanFlag[]): ScanFlag[] {
  return flags.map((f) => (f.reasons || f.fallbackReasons ? f : makeFlag(f.label, f.severity, f.impact, codesFromUpstreamText(source, f.label))));
}
