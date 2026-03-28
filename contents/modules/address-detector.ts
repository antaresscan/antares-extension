import { state } from "./state"
import { resetState } from "./components"
import { scan } from "./scanner"
import { getAdapter } from "./adapters"
import type { SiteAdapter } from "./adapters"

/**
 * The active adapter for the current site.
 * Resolved once at injection time and reused for all navigations.
 */
let activeAdapter: SiteAdapter | null = null

/** Get or lazily resolve the adapter for the current site */
function adapter(): SiteAdapter {
  if (!activeAdapter) {
    activeAdapter = getAdapter(window.location.hostname)
    console.log(`[antares] Using adapter: ${activeAdapter.name}`)
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

/**
 * Set up SPA navigation listeners.
 * MutationObserver + history API interception detects URL changes,
 * then delegates to the adapter's isNewToken() to filter noise.
 */
export function setupNavListeners(): void {
  state.lastUrl = window.location.href

  // Track last href to avoid redundant onNav calls from MutationObserver
  let lastHref = window.location.href

  new MutationObserver(() => {
    const cur = window.location.href
    if (cur !== lastHref) {
      lastHref = cur
      onNav()
    }
  }).observe(document.documentElement, { childList: true, subtree: true })

  const _push = history.pushState.bind(history)
  const _replace = history.replaceState.bind(history)

  history.pushState = (...args) => { _push(...args); onNav() }
  history.replaceState = (...args) => { _replace(...args); onNav() }
  window.addEventListener("popstate", onNav)
}

/** Get the initial delay for the current adapter */
export function getInitialDelay(): number {
  return adapter().initialDelay
}
