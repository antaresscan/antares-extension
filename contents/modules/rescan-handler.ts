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
import { readSessionToken } from "./session-token"
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
 * IMPORTANT: we must read the current session token before storing the cache
 * entry. getCached() validates that e.session === currentSession and evicts on
 * mismatch — if we store session:null while the user is logged in, getCached()
 * immediately evicts the warm entry and scan() falls back to a cold API fetch
 * (which returns the Redis-cached old verdict). This was the root cause of all
 * previous sync failures.
 *
 * @param ca        The CA from the storage entry (already validated by caller)
 * @param freshData The fresh API result written by token.html
 */
export async function handleRescanDone(ca: string, freshData?: ScanResponseData): Promise<void> {
  if (!ca || ca !== state.lastCA || state.manuallyDismissed) return

  if (freshData) {
    // Read the current session token so the cache entry survives getCached()'s
    // session-validation check. Without this, a logged-in user's null-session
    // entry is evicted immediately → cold API fetch → stale Redis result.
    const session = await readSessionToken()
    saveToLS(ca, freshData, session)
    scanCache.set(ca, { data: freshData, ts: Date.now(), session })
  } else {
    evictCached(ca)
  }

  // Reset lastCA so scan()'s early-return guard doesn't short-circuit.
  state.lastCA = ""
  void scan(ca)
}
