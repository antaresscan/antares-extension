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
import { hydrateCacheFromLS } from "./modules/cache"
import { createHost, hideBox } from "./modules/components"
import { poll, setupNavListeners, getInitialDelay } from "./modules/address-detector"

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
  console.log("[antares] Already injected, skipping duplicate")
} else {
  document.documentElement.setAttribute(GUARD, "1")

  // Hydrate scan cache from localStorage
  hydrateCacheFromLS()

  // [5.3] Load stealth mode preference from chrome.storage
  try {
    chrome.storage.local.get(["antares_stealth"], (result) => {
      state.stealthMode = result?.antares_stealth === true
    })
    // Listen for stealth toggle changes from popup or other tabs
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.antares_stealth) {
        state.stealthMode = changes.antares_stealth.newValue === true
        if (state.stealthMode) hideBox()
      }
    })
  } catch (e: unknown) {
    console.warn("[antares]", e)
  }

  // MutationObserver to re-inject host if removed
  new MutationObserver(() => {
    if (!state.host || !document.documentElement.contains(state.host)) {
      if (state.isInjecting) return
      state.isInjecting = true
      setTimeout(() => { createHost(); state.isInjecting = false }, 150)
    }
  }).observe(document.documentElement, { childList: true, subtree: false })

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
