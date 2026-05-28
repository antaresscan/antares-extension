import type { PlasmoCSConfig } from "plasmo"
import * as Sentry from "@sentry/browser"
import { scrubEvent, scrubBreadcrumb } from "../shared/sentry-scrub"

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

// Wire shared PII scrubbing — same SCRUB_KEYS + URL-query-strip the
// backend uses (api/_lib/sentry.ts). Without this, every XHR
// breadcrumb from /api/scan shipped `?ca=<contract>` to Sentry and
// captureException-with-context sites leaked email / JWT, violating
// privacy.html's "no PII" promise on the content-script side.
if (process.env.PLASMO_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.PLASMO_PUBLIC_SENTRY_DSN,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
}

import { state } from "./modules/state"
import { hydrateCacheFromLS } from "./modules/cache"
import { createHost, hideBox } from "./modules/components"
import { poll, setupNavListeners, cleanupNavListeners, getInitialDelay } from "./modules/address-detector"
import { scan } from "./modules/scanner"
import { handleSessionTokenChange } from "./modules/session-handler"
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
// Token-page tabs already open react to that change so the overlay
// reflects the user's NEW tier without a manual page refresh:
//
//   - Sign in (token written) → silent re-scan with the JWT, server
//     returns paid tier, overlay swaps to Pro/Yearly/Lifetime ✓
//   - Sign out (token cleared) → silent re-scan, server returns Free,
//     overlay swaps to Free ✓
//
// UX guarantee: silent: true keeps the EXISTING overlay on screen
// during the fetch — no skeleton flash, no perceived reload. The new
// data swaps in atomically the moment it lands. We also reset
// manuallyDismissed because login/logout is an explicit user action
// and they probably want to see the resulting tier change.
//
// We still call clearAllScanCache to keep localStorage bounded — without
// it, every token a user ever scanned would linger in LS forever for
// pages they don't revisit. Session-tagged entries auto-invalidate on
// read, but they'd still occupy disk. The wipe is cheap (small payloads,
// few entries) and runs only on auth state change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return
  if (!Object.prototype.hasOwnProperty.call(changes, "antares_session_token")) return
  // Listener body is in session-handler.ts so the abort + clear + scan
  // logic can be unit-tested in isolation. See that module for the
  // why-this-exists comments.
  handleSessionTokenChange()
})

// ─── TAB-FOCUS SELF-HEAL ──────────────────────────────────────────────────
//
// chrome.storage.onChanged is reliable for tabs whose content scripts are
// still RUNNING when the session changes. But Chrome aggressively
// discards inactive tabs to reclaim memory — when that happens the
// content script is torn down and the storage listener never fires.
// On revisit, the script re-injects and hydrates from localStorage,
// which still holds the pre-logout/login Pro/Free entry.
//
// Two backstops cover that gap:
//
//   1. Cache entries are session-tagged (see cache.ts → getCached).
//      A stale entry can never serve the wrong tier — getCached evicts
//      on session mismatch and returns null, forcing a fresh scan.
//
//   2. When a previously-hidden tab becomes visible, we silent-rescan
//      the current CA. silent: true means scan() short-circuits cheaply
//      if the cache is still valid (no API call, no re-render), and
//      keeps the existing overlay visible if a fresh fetch is needed
//      (no skeleton flash). Net effect: zero perceived activity when
//      nothing changed; a smooth atomic swap when something did.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return
  if (!state.enabled) return
  // Don't auto-resurrect a manually-dismissed overlay; the next nav
  // event will re-evaluate. This keeps the close-button UX intact —
  // user closes the box, switches tabs, comes back, box stays closed.
  if (state.manuallyDismissed) return

  if (state.lastCA) {
    void scan(state.lastCA, { silent: true })
  } else {
    // Nothing scanned yet on this tab — fall back to normal poll.
    poll()
  }
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
