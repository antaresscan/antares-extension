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
import { createHost } from "./modules/components"
import { poll, setupNavListeners, getInitialDelay } from "./modules/address-detector"
import { hideBox } from "./modules/components"

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
 * OLD CODE had: poll() + setTimeout(poll, delay) = DOUBLE SCAN.
 * NEW CODE: first poll after adapter delay, single scan only.
 * The delay gives the SPA time to render token data in the DOM.
 */
setTimeout(() => {
  poll()
}, getInitialDelay())

setupNavListeners()
