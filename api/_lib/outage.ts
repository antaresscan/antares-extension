// api/_lib/outage.ts — is a data source DOWN, or just without data for this token?
//
// "Limited data" (the overlay with no verdict) is a last resort, for a real outage: a source that does not answer at all makes the verdict a scan reaches
// without it unreliable (replayed on 1 121 tokens with one source silent: a SAFE read CAUTION, a DANGER read SAFE, a RUG read DANGER), and a token flipping
// from one verdict to another is not credible. It must NOT show each time a source has nothing for a token: Helius cannot list the holders of a token with
// millions of them (BONK, JUP: "Limited data" every time on the previews, 2026-10-14), RugCheck does not know a brand-new token, GoPlus has no entry for it.
// Those scans keep their verdict and their flags ("Helius unavailable - holder concentration unverified"), as before.
//
// What tells the two apart is HOW the source failed. A source that ANSWERED with nothing for this token (HTTP 200 with no usable data, a 404, an error body)
// is not down. A source that DID NOT ANSWER (no response before the timeout, a server error, "too many requests", or our own circuit breaker shut on it)
// has FAILED, and a source is DOWN when it has failed several times within the last minute: a single failed call is a blip, not an outage.
//
// The ledger lives in the memory of the warm instance (module scope, like the circuit breakers): no Redis command, and each instance sees the failures of the
// scans it ran. During an outage every scan makes several calls, so the first scan of an instance is enough: Helius (3 to 10 calls), RugCheck (summary and report)
// and GoPlus (the authenticated lookup, then the public one). One failed call among them, with the others answering, is a blip and does not count as an outage.
import { providerOfHost } from "./usage";

/** The sources whose outage can turn a scan into "Limited data": the three that decide the verdict (Helius alone is enough; RugCheck and GoPlus only together, or with Helius: helpers.ts gapSources). */
export const OUTAGE_SOURCES = ["helius", "rugcheck", "goplus"] as const;
export type OutageSource = (typeof OUTAGE_SOURCES)[number];

/** How far back a failure counts. */
export const OUTAGE_WINDOW_MS = 60_000;

/** Failed calls within the window that make the source DOWN: Helius 3 (a scan makes 3 to 10 calls), RugCheck 2 and GoPlus 2. */
export const OUTAGE_THRESHOLD: Record<OutageSource, number> = { helius: 3, rugcheck: 2, goplus: 2 };

const failures = new Map<OutageSource, number[]>();

const isOutageSource = (p: string): p is OutageSource => (OUTAGE_SOURCES as readonly string[]).includes(p);

/**
 * One call to `host` has failed (no answer before the timeout, a server error, "too many requests" after its retries) or was not sent because the circuit breaker
 * is shut. Called by http.ts. A host that is none of the three sources is ignored. Never throws.
 */
export function noteSourceFailure(host: string | null, now: number = Date.now()): void {
  try {
    if (!host) return;
    const p = providerOfHost(host);
    if (!isOutageSource(p)) return;
    const list = failures.get(p) ?? [];
    list.push(now);
    // Keep the list short: only what is inside the window can matter, and an outage can send many calls.
    const fresh = list.filter((t) => now - t <= OUTAGE_WINDOW_MS);
    failures.set(p, fresh.length > 200 ? fresh.slice(-200) : fresh);
  } catch { /* the ledger must never break a scan */ }
}

/** Is `source` DOWN right now: at least OUTAGE_THRESHOLD failed calls within the last OUTAGE_WINDOW_MS. */
export function isSourceDown(source: OutageSource, now: number = Date.now()): boolean {
  const list = failures.get(source);
  if (!list) return false;
  return list.filter((t) => now - t <= OUTAGE_WINDOW_MS).length >= OUTAGE_THRESHOLD[source];
}

/** Which of the three sources are down right now. */
export function downSources(now: number = Date.now()): Record<OutageSource, boolean> {
  return { helius: isSourceDown("helius", now), rugcheck: isSourceDown("rugcheck", now), goplus: isSourceDown("goplus", now) };
}

/** Test-only: forget every failure. */
export function _resetOutageForTests(): void {
  failures.clear();
}
