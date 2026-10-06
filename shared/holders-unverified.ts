// shared/holders-unverified.ts
//
// A scan that has no holder data carries the layer flag
// "Helius unavailable — holder concentration unverified" (api/_lib/layers.ts),
// and the API caps that verdict at CAUTION (never SAFE).
//
// The overlay hides pipeline-status flags ("X unavailable", "timed out", ...)
// because they describe our plumbing, not the token. This one is the
// exception: it is the reason the verdict is not SAFE, and hiding it printed
// "No issues found" next to a CAUTION badge. It is the single status flag the
// clients show, under a label that names the missing check instead of the
// vendor.
//
// js/compute.js carries a plain-JS copy for the token page (it is not a TS
// import). Keep both in sync.

export const HOLDERS_UNVERIFIED_LABEL = "Holder concentration unverified"

export function isHoldersUnverifiedFlag(label: unknown): boolean {
  return typeof label === "string" && /holder concentration unverified/i.test(label)
}
