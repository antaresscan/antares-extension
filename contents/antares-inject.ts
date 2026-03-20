import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

import { state } from "./modules/state"
import { hydrateCacheFromLS } from "./modules/cache"
import { createHost } from "./modules/components"
import { poll, setupNavListeners } from "./modules/address-detector"
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
poll()
setTimeout(poll, 2000)
setupNavListeners()
