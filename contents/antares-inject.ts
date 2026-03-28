import type { PlasmoCSConfig } from "plasmo"
import * as Sentry from "@sentry/browser"

export const config: PlasmoCSConfig = {
  matches: [
    "https://dexscreener.com/*",
    "https://pump.fun/*",
    "https://axiom.trade/*",
    "https://neo.bullx.io/*",
    "https://photon-sol.tinyastro.io/*",
    "https://birdeye.so/*",
    "https://raydium.io/*",
    "https://jup.ag/*",
    "https://solscan.io/*",
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
 * GUARD: Prevent double injection using a DOM attribute.
 *
 * Chrome content scripts run in an isolated world, but they share the same DOM.
 * Using a data attribute on <html> ensures any re-injection of this script
 * (same or different isolated world) can detect a previous instance.
 *
 * Also use window-level flag for same-world re-injections (Plasmo HMR, etc).
 *
 * ROOT CAUSE OF DOUBLE SCAN:
 * On Birdeye and other SPAs, Chrome may re-inject the content script when
 * the URL changes via pushState/replaceState. The second instance creates
 * new state (lastCA = ""), new setTimeout(poll, 1200ms), and new nav listeners.
 * This second poll fires ~1-3s after the first scan completed, calling the API
 * again. If the API returns a different result (or an error), it overwrites
 * the correct first result with "DANGER 0/1000".
 */
const GUARD_ATTR = "data-antares-init"
const GUARD_WIN = "__antares_injected__"

const alreadyInitDOM = document.documentElement.hasAttribute(GUARD_ATTR)
const alreadyInitWin = (window as any)[GUARD_WIN] === true

if (alreadyInitDOM || alreadyInitWin) {
  console.log("[antares] Duplicate injection detected, skipping init")
} else {
  document.documentElement.setAttribute(GUARD_ATTR, "1")
  ;(window as any)[GUARD_WIN] = true

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
  } catch (e: unknown) { console.warn("[antares]", e) }

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
