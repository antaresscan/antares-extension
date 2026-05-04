import type { PlasmoCSConfig } from "plasmo"
import * as Sentry from "@sentry/browser"

export const config: PlasmoCSConfig = {
  matches: [
    "https://dexscreener.com/*",
    "https://pump.fun/*",
    "https://axiom.trade/*",
    "https://photon-sol.tinyastro.io/*",
    "https://birdeye.so/*",
    "https://www.geckoterminal.com/*",
    "https://gmgn.ai/*",
    "https://app.telemetry.io/*"
  ],
  run_at: "document_idle"
}

if (process.env.PLASMO_PUBLIC_SENTRY_DSN) {
  Sentry.init({ dsn: process.env.PLASMO_PUBLIC_SENTRY_DSN, tracesSampleRate: 0.1 });
}

import { state } from "./modules/state"
import { hydrateCacheFromLS, clearAllScanCache } from "./modules/cache"
import { createHost, hideBox } from "./modules/components"
import { poll, setupNavListeners, cleanupNavListeners, getInitialDelay } from "./modules/address-detector"
import { logger } from "../shared/logger"

/**
 * GUARD: Prevent double injection via a DOM attribute on <html>.
 *
 * Content scripts share the DOM with the page regardless of isolated world.
 * A data-attribute on documentElement survives across re-injections.
 *
 * ROOT CAUSE OF DOUBLE SCAN:
 * On SPAs (Birdeye, etc.), Chrome may re-inject the content script on
 * pushState navigations. The second instance has fresh state (lastCA=""),
 * fires a new setTimeout(poll, initialDelay), and overwrites the first
 * correct scan result with a stale "DANGER 0/1000".
 */
const GUARD = "data-antares-init"

if (document.documentElement.hasAttribute(GUARD)) {
  logger.info("Already injected, skipping duplicate")
} else {
  document.documentElement.setAttribute(GUARD, "1")

  // Hydrate scan cache from localStorage
  hydrateCacheFromLS()

  
  // MutationObserver to re-inject host if the page strips it. Reference is
  // held on `state` so the EXTENSION_TOGGLE handler below can disconnect it
  // when the user disables the extension — otherwise the observer keeps
  // firing on every DOM mutation forever.
  state.hostObserver = new MutationObserver(() => {
    if (!state.host || !document.documentElement.contains(state.host)) {
      if (state.isInjecting) return
      state.isInjecting = true
      setTimeout(() => { createHost(); state.isInjecting = false }, 150)
    }
  })
  state.hostObserver.observe(document.documentElement, { childList: true, subtree: false })

  // Init
  state.lastNavPath = window.location.pathname
  createHost()

  /**
   * SINGLE initial poll with adapter-specific delayed retry.
   * The delay gives the SPA time to render token data in the DOM.
   */
  setTimeout(() => {
    poll()
  }, getInitialDelay())

  setupNavListeners()
}

// ─── LIVE SESSION SYNC ────────────────────────────────────────────────────────
//
// When the user signs in or out on antares-website, the bridge content
// script writes/clears `antares_session_token` in chrome.storage.local.
// Token-page tabs that are already open need to react to that change so
// the overlay reflects the user's NEW tier without a manual page refresh:
//
//   - Sign in (token written) → next scan adds the JWT, server returns
//     paid tier, overlay re-renders Pro/Yearly/Lifetime ✓
//   - Sign out (token cleared) → next scan goes anonymous, server
//     returns Free, overlay re-renders Free ✓
//
// Implementation: chrome.storage.onChanged fires in every extension
// context (background + every tab's content script). We bust the
// per-CA cache (so the next scan goes through the API instead of
// short-circuiting on cached state) and trigger poll() which detects
// the current page's CA and re-scans it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  if (!Object.prototype.hasOwnProperty.call(changes, "antares_session_token")) return
  if (!state.enabled) return
  // Wipe BOTH caches (in-memory + localStorage) so that token pages
  // visited while the previous session was active don't keep showing
  // the previously-cached tier. Without the localStorage wipe, opening
  // a previously-scanned token after logout would still show Pro
  // because the LS-hydrated cache hits before the re-scan request.
  clearAllScanCache()
  state.lastCA = ""
  state.manuallyDismissed = false
  poll()
})

// ─── EXTENSION TOGGLE (icon click) ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "EXTENSION_TOGGLE") return
  state.enabled = !!msg.enabled
  if (!state.enabled) {
    // Disable: hide box, abort any in-flight scan, and tear down the SPA
    // listeners so we stop wrapping the host page's history APIs and stop
    // observing DOM mutations entirely.
    hideBox()
    if (state.currentScanController) {
      state.currentScanController.abort()
      state.currentScanController = null
    }
    if (state.rescanTimer) { clearTimeout(state.rescanTimer); state.rescanTimer = null }
    cleanupNavListeners()
    if (state.hostObserver) {
      state.hostObserver.disconnect()
      state.hostObserver = null
    }
  } else {
    // Re-enable: reset lastCA so poll() will re-scan the current page, and
    // reinstall the SPA listeners we tore down on disable. setupNavListeners
    // is idempotent so a stray re-enable without prior disable is a no-op.
    state.lastCA = ""
    state.manuallyDismissed = false
    setupNavListeners()
    poll()
  }
})
