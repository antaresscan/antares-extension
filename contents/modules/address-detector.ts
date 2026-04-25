import { state } from "./state"
import { resetState } from "./components"
import { scan } from "./scanner"
import { getAdapter } from "./adapters"
import type { SiteAdapter } from "./adapters"
import { logger } from "../../shared/logger"

/**
 * The active adapter for the current site.
 * Resolved once at injection time and reused for all navigations.
 */
let activeAdapter: SiteAdapter | null = null

/** Get or lazily resolve the adapter for the current site */
function adapter(): SiteAdapter {
  if (!activeAdapter) {
    activeAdapter = getAdapter(window.location.hostname)
    logger.info(`Using adapter: ${activeAdapter.name}`)
  }
  return activeAdapter
}

/** Guard: true if a scan is already running or displayed for this CA */
function alreadyHandled(ca: string): boolean {
  return ca === state.lastCA && !state.manuallyDismissed
}

/**
 * Poll the current page for a token address using the active adapter.
 * Returns the CA found (or empty string) so callers can check.
 */
export function poll(): string {
    if (!state.enabled) return ""
  const url = new URL(window.location.href)
  const ca = adapter().extractCA(url, document)
  if (!ca) return ""
  if (alreadyHandled(ca)) return ca  // already scanned, skip API call
  void scan(ca)
  return ca
}

/**
 * Timestamp of the last onNav call that actually triggered a poll.
 * Used to prevent MutationObserver + history.pushState from both
 * triggering onNav within the same navigation event.
 */
let lastNavTriggerTs = 0

/**
 * Handle a navigation event.
 * Uses the adapter's isNewToken() to decide whether to reset and re-scan.
 *
 * KEY FIXES for double-scan:
 *  1. Debounce increased to 800ms (was 300ms) to let Birdeye SPA settle.
 *  2. De-duplicate rapid-fire onNav calls within 100ms window.
 *     MutationObserver + pushState/replaceState often fire at the same time.
 *  3. Extract CA from the NEW url and compare with state.lastCA before scanning.
 *     If the CA is the same, skip entirely (handles redirect noise).
 */
export function onNav(): void {
    if (!state.enabled) return
  const now = Date.now()
  const curUrl = new URL(window.location.href)
  const prevUrl = new URL(state.lastUrl || window.location.href)
  const isNew = adapter().isNewToken(prevUrl, curUrl)

  state.lastUrl = window.location.href

  // Not a meaningful navigation (e.g. Birdeye adding ?chain=solana) -- skip entirely
  if (!isNew) return

  // De-duplicate: if another onNav already fired within 100ms, skip.
  // This prevents MutationObserver + pushState from both triggering.
  if (now - lastNavTriggerTs < 100) return
  lastNavTriggerTs = now

  if (state.navDebounce) clearTimeout(state.navDebounce)

  state.navDebounce = setTimeout(() => {
    state.navDebounce = null

    // CRITICAL: Before scanning, extract the CA from the CURRENT url.
    // If it matches state.lastCA, the previous scan result is still valid.
    const currentUrl = new URL(window.location.href)
    const currentCA = adapter().extractCA(currentUrl, document)
    if (currentCA && currentCA === state.lastCA && !state.manuallyDismissed) {
      return  // Same token, skip scan
    }

    resetState()
    poll()
  }, 800)
}

// Module-level handles to every side-effect setupNavListeners installs on
// the host page. Tracking them lets us disconnect / restore on extension
// disable so we never leave the host with a permanently-wrapped
// history.pushState or an orphaned MutationObserver firing on every DOM
// mutation. The audit flagged both as real memory / perf leaks on SPAs
// (Birdeye, DexScreener) where the page can stay loaded across many
// navigations.
let navObserver: MutationObserver | null = null
let originalPushState: typeof history.pushState | null = null
let originalReplaceState: typeof history.replaceState | null = null
const popstateHandler: EventListener = () => onNav()

/**
 * Set up SPA navigation listeners. Idempotent: calling twice is a no-op
 * unless cleanupNavListeners() was called in between.
 *
 * MutationObserver + history API interception detects URL changes, then
 * delegates to the adapter's isNewToken() to filter noise.
 */
export function setupNavListeners(): void {
  if (navObserver) return  // already installed

  state.lastUrl = window.location.href

  // Track last href to avoid redundant onNav calls from MutationObserver
  let lastHref = window.location.href

  navObserver = new MutationObserver(() => {
    const cur = window.location.href
    if (cur !== lastHref) {
      lastHref = cur
      onNav()
    }
  })
  navObserver.observe(document.documentElement, { childList: true, subtree: true })

  originalPushState = history.pushState
  originalReplaceState = history.replaceState
  const push = originalPushState.bind(history)
  const replace = originalReplaceState.bind(history)

  history.pushState = function patched(...args) { push(...args); onNav() }
  history.replaceState = function patched(...args) { replace(...args); onNav() }
  window.addEventListener("popstate", popstateHandler)
}

/**
 * Tear down everything setupNavListeners installed: disconnect the
 * MutationObserver, restore the original history APIs (so the host page
 * isn't left with a wrapper indefinitely), remove the popstate listener.
 *
 * Safe to call when nothing is installed — becomes a no-op.
 */
export function cleanupNavListeners(): void {
  if (navObserver) {
    navObserver.disconnect()
    navObserver = null
  }
  if (originalPushState) {
    history.pushState = originalPushState
    originalPushState = null
  }
  if (originalReplaceState) {
    history.replaceState = originalReplaceState
    originalReplaceState = null
  }
  window.removeEventListener("popstate", popstateHandler)

  if (state.navDebounce) {
    clearTimeout(state.navDebounce)
    state.navDebounce = null
  }
}

/** Get the initial delay for the current adapter */
export function getInitialDelay(): number {
  return adapter().initialDelay
}
