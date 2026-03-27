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
 * Handle a navigation event.
 * Uses the adapter's isNewToken() to decide whether to reset and re-scan.
 * KEY FIX: only re-poll when the adapter says it's a meaningful navigation.
 */
export function onNav(): void {
  const curUrl = new URL(window.location.href)
  const prevUrl = new URL(state.lastUrl || window.location.href)
  const isNew = adapter().isNewToken(prevUrl, curUrl)

  state.lastUrl = window.location.href

  // Not a meaningful navigation (e.g. Birdeye adding ?chain=solana) — skip entirely
  if (!isNew) return

  if (state.navDebounce) clearTimeout(state.navDebounce)
  state.navDebounce = setTimeout(() => {
    state.navDebounce = null
    resetState()
    poll()
  }, 300)
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
