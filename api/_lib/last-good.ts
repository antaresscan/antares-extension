// api/_lib/last-good.ts — what to say about an issuer-backed token when its market cannot be read.
//
// A stablecoin, a tokenized stock, an LST... of the issuer registry is judged on its MARKET (issuer-assets.ts). When DexScreener cannot be
// read (an outage, or no pool listed) there is no market to judge it on. It must not flip to a warning for that: its verdict is the one of
// the last time its market WAS read, served again with its age, so that the overlay can say "Scanned 6 min ago". The memory is written by
// scan.ts at each scan that did read the market (cache.ts setLastGoodResult, 6 h), and read only when the market cannot be.
//
// It is only ever the token's OWN last good answer: never a verdict made up, never a copy of a copy, and never better than what this scan
// itself found (a fact from another source, a collapse on the chart, is not hidden by an old SAFE).
import type { ScanResult, Verdict } from "./types";

const RANK: Record<Verdict, number> = { SAFE: 0, CAUTION: 1, DANGER: 2, RUG: 3 };

/**
 * The answer to give instead of `current` (this scan, made with no market), or null when `current` stands: no memory, a memory that is not
 * usable, or a scan that found something worse than the memory (it wins). The memory keeps its own `fetchedAt` (when its market was read),
 * which is what the age sent to the overlay is counted from; the answer is marked degraded (kept 30 s only) and servedFromMemory.
 * It is not a `sourceGap`: the line "Scanned 6 min ago" already says what is going on, and the two must never both be on the card.
 */
export function serveLastGood(good: ScanResult | null, current: ScanResult): ScanResult | null {
  if (!good || typeof good !== "object") return null;
  if (!(good.risk in RANK) || typeof good.fetchedAt !== "number" || !Number.isFinite(good.fetchedAt)) return null;
  if (good.servedFromMemory === true) return null;
  if (RANK[current.risk] > RANK[good.risk]) return null;
  return { ...good, requestId: current.requestId, degraded: true, servedFromMemory: true, sourceGap: false };
}
