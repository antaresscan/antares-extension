// contents/antares-website-bridge.ts
//
// Tiny bridge content-script that runs on the Antares website + GitHub-Pages
// mirror. Its only job is to expose the extension's install_id to the
// website's pricing modal and /account.html so paying customers don't
// have to manually copy-paste a license key into the extension Options.
//
// Flow when the user is buying Pro/Lifetime:
//   1. /pricing.html opens the payment modal
//   2. Modal posts `window.postMessage({ type: 'antares:get-install-id' })`
//   3. This bridge (running in the page) receives the message, fetches
//      install_id from chrome.storage.local
//   4. Bridge replies with `window.postMessage({ type: 'antares:install-
//      id-response', install_id: '...' })`
//   5. Modal includes install_id in /api/payment-intent body
//   6. After on-chain confirmation, cron-check-payments / payment-status
//      auto-call setUserTier(install_id, tier) — the extension is now
//      Pro/Lifetime without ever touching the Options page
//
// Same flow on /account.html — the page can probe for install_id and
// auto-redeem any unredeemed licence to that install retroactively.
//
// Why a content script and not chrome.runtime.sendMessage with
// `externally_connectable`? The postMessage approach doesn't require
// hardcoding the extension's Chrome Web Store ID on the website (which
// changes when re-publishing or developing locally). The trade-off is
// any other extension running on the page can listen too, but we send
// nothing sensitive — the install_id is an opaque random UUID that's
// already sent in plaintext to our API as `X-Antares-Install`.

import type { PlasmoCSConfig } from "plasmo"
import { getInstallId } from "../shared/install-id"

export const config: PlasmoCSConfig = {
  matches: [
    "https://antares-website.vercel.app/*",
    // Vercel preview deployments — pattern matches `<project>-<hash>-<team>-projects.vercel.app`
    "https://antares-website-*.vercel.app/*",
    // GitHub Pages mirror
    "https://comealamaisongroupe.github.io/antares-website/*",
    "https://comealamaisongroupe.github.io/*"
  ],
  run_at: "document_start",
  // World "MAIN" runs in the page's JS context so window.postMessage flows
  // both ways without crossing the isolated-world boundary. Default
  // "ISOLATED" would also work here (postMessage crosses worlds for
  // window-level events) but MAIN is more straightforward.
  world: "ISOLATED"
}

// Marker so the page's JS can detect "extension is installed" without
// having to round-trip a postMessage probe with timeout.
;(() => {
  try {
    const meta = document.createElement("meta")
    meta.name = "antares-extension-installed"
    meta.content = "1"
    // Append at document_start runs before <head> exists in some browsers;
    // wait for it.
    if (document.head) {
      document.head.appendChild(meta)
    } else {
      const obs = new MutationObserver(() => {
        if (document.head) {
          document.head.appendChild(meta)
          obs.disconnect()
        }
      })
      obs.observe(document.documentElement, { childList: true, subtree: true })
    }
  } catch {
    /* harmless — non-critical fallback */
  }
})()

// Listen for install_id requests from the page (pricing modal,
// /account.html auto-link, etc.). We only respond to messages whose
// `type` matches our prefix; everything else is ignored to avoid
// clashing with other postMessage traffic on the page.
window.addEventListener("message", (event) => {
  // Trust the source: messages must come from the same window
  // (page → bridge), not iframes or other origins.
  if (event.source !== window) return
  const data = event.data as { type?: string; nonce?: string } | null
  if (!data || typeof data !== "object") return

  if (data.type === "antares:get-install-id") {
    const nonce = typeof data.nonce === "string" ? data.nonce : ""
    getInstallId()
      .then((installId) => {
        window.postMessage(
          {
            type: "antares:install-id-response",
            nonce,
            install_id: installId,
            // Version tag in case future bridge protocol changes need
            // discrimination ("only call link-install if v >= 2" etc).
            v: 1
          },
          window.location.origin
        )
      })
      .catch(() => {
        window.postMessage(
          { type: "antares:install-id-response", nonce, install_id: null, v: 1 },
          window.location.origin
        )
      })
  }
})
