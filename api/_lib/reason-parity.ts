// api/_lib/reason-parity.ts — The two readers of the safe-gate reasons must agree.
//
// classifySafeBlockedReasons reads the TEXT of every flag and still decides; classifyByCodes reads the codes the layers put on their flags
// (ScanFlag.reasons / fallbackReasons). While the text reader decides, the codes are checked against it on every scan. In the tests a
// difference throws (ANTARES_STRICT_PARITY=1, set in vitest.config.ts), so the replay of the recorded tokens proves the codes are right;
// in production it is logged and counted, and the text answer is the one used, so nothing can move because of it. When the metric stays
// at zero for long enough, the code reader replaces the text reader and the regexes go.

import type { LayerResult, SafeBlockedReason } from "./types";
import { classifyByCodes } from "./scoring";
import { logger } from "./logger";

const same = (a: SafeBlockedReason[], b: SafeBlockedReason[]): boolean => a.length === b.length && a.every((r, i) => r === b[i]);

/** Compares the reasons read from the text with the reasons read from the codes. Returns true when they agree. */
export function checkReasonParity(layers: LayerResult[], byText: SafeBlockedReason[], context: { requestId?: string; ca?: string } = {}): boolean {
  const byCodes = classifyByCodes(layers);
  if (same(byText, byCodes)) return true;
  const detail = { ...context, byText, byCodes };
  if (process.env.ANTARES_STRICT_PARITY === "1") {
    throw new Error(`safe-gate reasons: the codes say ${JSON.stringify(byCodes)}, the text says ${JSON.stringify(byText)}`);
  }
  logger.warn("scan", "safe-gate reasons: the codes differ from the text reader (the text answer is used)", detail);
  logger.metric("scan.reason-parity-mismatch", detail);
  return false;
}
