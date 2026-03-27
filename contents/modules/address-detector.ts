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

/**
 * Poll the current page for a token address using the active adapter.
 * This replaces the old monolithic findBestAddress().
 */
export function poll(): void {
  const url = new URL(window.location.href)
  const ca = adapter().extractCA(url, document)
  if (!ca) return
  void scan(ca)
}

/**
 * Handle a navigation event.
 * Uses the adapter's isNewToken() to decide whether to reset and re-scan.
 */
export function onNav(): void {
  const curUrl = new URL(window.location.href)
  const prevUrl = new URL(state.lastUrl || window.location.href)

  const isNew = adapter().isNewToken(prevUrl, curUrl)
  state.lastUrl = window.location.href

  if (state.navDebounce) clearTimeout(state.navDebounce)
  state.navDebounce = setTimeout(() => {
    state.navDebounce = null
    if (isNew) {
      resetState()
    }
    poll()
  }, 500)
}

/**
 * Set up SPA navigation listeners.
 * The MutationObserver + history API interception detects URL changes,
 * then delegates to the adapter's isNewToken() to filter noise.
 */
export function setupNavListeners(): void {
  state.lastUrl = window.location.href
  new MutationObserver(() => {
    const cur = window.location.href
    if (cur !== state.lastUrl) { onNav() }
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
