// contents/modules/rescan-handler.ts
//
// Extracted handler for the RESCAN_DONE message sent by token.html after
// a successful ?fresh=1 rescan. Keeping the logic in its own module makes
// it unit-testable without needing to stub chrome.runtime.onMessage or
// the entire antares-inject.ts entrypoint.
//
// Flow (happy path):
//   1. token.html writes { ca, data, ts } to chrome.storage.local under
//      the key "antares_fresh_scan" before sending RESCAN_DONE.
//   2. This handler reads that entry; if it matches the CA currently shown
//      in the overlay and is < 30s old, it injects the result directly into
//      the local cache (scanCache Map + localStorage mirror).
//   3. scan(ca) is called — it hits the warm cache and re-renders immediately.
//      No network call, no server Redis cache hit, no stale data.
//
// Fallback (storage miss / stale / CA mismatch):
//   Evict the local cache entry and call scan(ca) without the warmed cache.
//   scan() will re-fetch from the API (may return cached server result, but
//   at least the local 5-minute lock is broken).

import type { ScanResponseData } from "../../shared/types"
import { state, scanCache } from "./state"
import { evictCached, saveToLS } from "./cache"
import { scan } from "./scanner"

/** Key used by token.html to store the fresh scan result. */
export const FRESH_SCAN_KEY = "antares_fresh_scan"

/** How long (ms) a stored fresh result is considered valid. */
export const FRESH_SCAN_TTL_MS = 30_000

export interface FreshScanEntry {
  ca: string
  data: ScanResponseData
  ts: number
}

/**
 * Handle a RESCAN_DONE message from the background relay.
 *
 * @param ca  The contract address that was rescanned in token.html.
 *            Must match state.lastCA for the overlay to update.
 */
export function handleRescanDone(ca: string): void {
  // Guard: only act if the overlay is currently showing this CA and
  // the user hasn't manually dismissed it.
  if (!ca || ca !== state.lastCA || state.manuallyDismissed) return

  chrome.storage.local.get([FRESH_SCAN_KEY], (result) => {
    const fresh = result?.[FRESH_SCAN_KEY] as FreshScanEntry | undefined

    const isValid =
      fresh?.ca === ca &&
      fresh?.data != null &&
      typeof fresh.ts === "number" &&
      Date.now() - fresh.ts < FRESH_SCAN_TTL_MS

    if (isValid && fresh) {
      // Warm the local cache with the result already fetched by token.html.
      // scan() will hit this cache entry and re-render with zero network cost.
      // session: null — token.html doesn't know the session token; null is
      // safe here because getCached() only evicts on session MISMATCH, and a
      // null entry will be replaced by the next organic scan which is session-
      // aware.
      saveToLS(ca, fresh.data, null)
      scanCache.set(ca, { data: fresh.data, ts: Date.now(), session: null })
    } else {
      // Fresh result unavailable (storage miss, stale, or CA mismatch) —
      // evict the stale local cache so scan() re-fetches from the API.
      evictCached(ca)
    }

    // In both paths, reset lastCA so scan()'s early-return guard doesn't
    // short-circuit, then trigger re-render.
    state.lastCA = ""
    void scan(ca)
  })
}
