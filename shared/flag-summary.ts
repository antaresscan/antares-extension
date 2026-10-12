// shared/flag-summary.ts
//
// Which flags the overlay counts in its one-line summary ("3 flags — 1 critical"). The Free overlay shows that count and nothing
// else about the flags: the labels are the Pro "Critical Flags" panel.
//
// The server needs the same rule. A Free caller no longer receives the text of the flags (api/_lib/pro-gate.ts), but the overlay
// still counts them from the array it gets: if the server dropped the array a DANGER token would read "No issues found". So the
// server keeps one placeholder flag, severity only, for every flag the overlay would have counted, and drops the others.
//
// The regex below is a copy of the one inline in contents/modules/components.ts (PIPELINE_STATUS_PATTERN_C), which is not exported.
// __tests__/pro-gate.test.ts fails the day the two sources differ.
import { isHoldersUnverifiedFlag } from "./holders-unverified"

/** Flags that describe OUR plumbing ("Helius unavailable", "timed out"...), not the token: the overlay never counts them. */
export const PIPELINE_STATUS_PATTERN =
  /^(Helius|GoPlus|RugCheck|Solscan|DexScreener|Birdeye|Helius RPC) (unavailable|rate[- ]limited|timed out|degraded)\b|Holder data unreliable|broken upstream/i

/** True when the overlay counts this flag in "N flags — M critical". */
export function countsInOverlaySummary(flag: { label?: unknown; severity?: unknown }): boolean {
  if (flag.severity === "bonus" || flag.severity === "info") return false
  const label = typeof flag.label === "string" ? flag.label : ""
  // "Holder concentration unverified" is the one status flag that stays visible: it is why a CAUTION verdict is not SAFE.
  if (PIPELINE_STATUS_PATTERN.test(label) && !isHoldersUnverifiedFlag(label)) return false
  return true
}
