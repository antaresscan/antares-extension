// contents/modules/rescan-handler.ts
//
// Handler called when token.html completes a ?fresh=1 rescan and the
// chrome.storage.onChanged listener fires with the new result.
//
// WHY chrome.storage.onChanged instead of message passing:
//   - storage.onChanged fires automatically in every content script that
//     is RUNNING when storage changes — no relay, no sendMessage, no SW
//   - The new value is embedded directly in the change event, so no
//     additional chrome.storage.local.get() call is needed
//   - Previous message-relay approaches failed because the background SW
//     relay added failure modes (SW dormant, tabs.sendMessage timing)
//
// WHY the full data is stored (not just { ca, ts }):
//   - Previous versions stored only { ca, ts }, then re-fetched from API
//   - The API returns the OLD result from Redis cache for several minutes
//   - Storing the full result lets the overlay render the EXACT same data
//     as token.html — no network call, no Redis cache hit

import type { ScanResponseData } from "../../shared/types"
import { state, scanCache } from "./state"
import { evictCached, saveToLS } from "./cache"
import { scan } from "./scanner"

export const FRESH_SCAN_KEY = "antares_fresh_scan"
export const FRESH_SCAN_TTL_MS = 30_000

export interface FreshScanEntry {
  ca: string
  data: ScanResponseData
  ts: number
}

/**
 * Handle a fresh scan result received directly from chrome.storage.onChanged.
 *
 * @param ca        The CA from the storage entry (already validated by caller)
 * @param freshData The fresh API result written by token.html
 */
export function handleRescanDone(ca: string, freshData?: ScanResponseData): void {
  if (!ca || ca !== state.lastCA || state.manuallyDismissed) return

  if (freshData) {
    // Inject the fresh result directly into the local cache.
    // scan() will hit this warm entry and re-render with zero network cost.
    saveToLS(ca, freshData, null)
    scanCache.set(ca, { data: freshData, ts: Date.now(), session: null })
  } else {
    // No data available — evict the stale local cache so scan() re-fetches.
    evictCached(ca)
  }

  // Reset lastCA so scan()'s early-return guard doesn't short-circuit.
  state.lastCA = ""
  void scan(ca)
}
