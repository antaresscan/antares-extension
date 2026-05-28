// contents/modules/session-handler.ts
//
// Handles chrome.storage.onChanged events for `antares_session_token`.
// Lives in its own module purely so it can be unit-tested in isolation
// without standing up the whole content-script bundle (Sentry init,
// MutationObserver, message handlers, etc).
//
// What this module guarantees:
//
//   1. Any /api/scan in flight at the moment of the session change is
//      ABORTED. Without this, the in-flight request — authenticated
//      with the OLD session token — would complete after the listener
//      and overwrite the overlay with stale tier data. This is the
//      account-switch bug: log out of A, log in to B, overlay stays
//      stuck on A's (or anonymous) tier because the logout's still-
//      flying scan landed last with `el.replaceChildren(...)`.
//
//   2. The scan cache is wiped. Every entry was session-tagged on
//      write; getCached's session-mismatch check would evict them on
//      the next read anyway. Wiping proactively keeps LS small and
//      forces the next scan through the API rather than serving a
//      one-off from a tagged-but-about-to-evict entry.
//
//   3. A fresh silent rescan is kicked off. silent=true keeps the
//      existing overlay visible while /api/scan runs with the NEW
//      session, then atomically swaps in the new-tier UI. If there's
//      no current CA (initial poll hasn't landed yet), we fall through
//      to poll() instead.

import { state } from "./state"
import { clearAllScanCache } from "./cache"
import { scan } from "./scanner"
import { poll } from "./address-detector"

/**
 * Handle a session-token storage change. Pure side-effect function:
 * aborts the in-flight scan, clears the cache, re-triggers a scan or
 * poll. No-op when the extension is disabled (toggle off).
 */
export function handleSessionTokenChange(): void {
  if (!state.enabled) return
  state.manuallyDismissed = false

  // Abort the in-flight scan FIRST. This is the load-bearing step:
  // without it, scan() at L232 would early-return because
  // state.currentScanController is still set, the new-session scan
  // would never start, and the OLD scan's response (with the previous
  // session) would land last and overwrite the overlay.
  if (state.currentScanController) {
    state.currentScanController.abort()
    state.currentScanController = null
  }

  clearAllScanCache()

  if (state.lastCA) {
    // Currently-displayed CA: silent rescan keeps the overlay visible
    // while /api/scan runs with the new session. New-tier UI swaps in
    // atomically when the response lands.
    void scan(state.lastCA, { silent: true })
  } else {
    // CA not yet resolved on this tab (initial poll never landed) —
    // run the normal poll path which will scan once the page settles.
    poll()
  }
}
