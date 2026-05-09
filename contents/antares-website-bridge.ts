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
  // Manifest-v3 match patterns: wildcards can be the scheme, the first
  // hostname segment, or in the path — never mid-hostname. So we don't
  // try to cover Vercel preview URLs (`<project>-<hash>-<team>-
  // projects.vercel.app`) — auto-link is production-only; preview
  // users still get the manual paste-key path.
  //
  // The two GH Pages entries are kept overlapping intentionally: the
  // narrower one captures user intent (we own only the antares-website
  // path under that org), the wildcard one is a defensive net for any
  // future page added to the same org.
  matches: [
    // Production custom domain — primary website host. Without this entry
    // the bridge is never injected on antaresscan.com pages, so:
    //   - account.html can't push the freshly minted session JWT into
    //     chrome.storage.local (Pro never unlocks on the extension), and
    //   - account.html's logout postMessage `antares:clear-session-token`
    //     is silently dropped (storage stays put, the storage-onChanged
    //     listener in antares-inject.ts never fires, the overlay keeps
    //     sending the still-valid JWT and stays on Pro forever).
    "https://antaresscan.com/*",
    "https://www.antaresscan.com/*",
    // Legacy + preview origins kept for older installs / Vercel previews.
    "https://antares-website.vercel.app/*",
    "https://comealamaisongroupe.github.io/antares-website/*",
    "https://comealamaisongroupe.github.io/*"
  ]
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

// Storage key shared with background.ts. The session token sits next to
// install_id in chrome.storage.local — both are bound to the same browser
// profile, both clear on uninstall.
const SESSION_TOKEN_KEY = "antares_session_token"

function setStoredSessionToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SESSION_TOKEN_KEY]: token }, () => {
      // chrome.runtime.lastError is a non-fatal write failure (quota,
      // OS lock); resolve either way so the page's postMessage flow
      // doesn't hang. Background.ts treats missing token as signed-out.
      resolve()
    })
  })
}

function clearStoredSessionToken(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(SESSION_TOKEN_KEY, () => resolve())
  })
}

// Listen for install_id requests from the page (pricing modal,
// /account.html auto-link, etc.). We only respond to messages whose
// `type` matches our prefix; everything else is ignored to avoid
// clashing with other postMessage traffic on the page.
window.addEventListener("message", (event) => {
  // Trust the source: messages must come from the same window
  // (page → bridge), not iframes or other origins.
  if (event.source !== window) return
  const data = event.data as {
    type?: string
    nonce?: string
    token?: unknown
  } | null
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
    return
  }

  // Website pushes the session JWT after successful login / link / signup.
  // The extension stores it in chrome.storage.local; background.ts reads
  // it on every scan and sends it as the X-Antares-Session header. This
  // is the cookie-free path — works even when Chrome blocks third-party
  // cookies for chrome-extension origins.
  if (data.type === "antares:set-session-token") {
    if (typeof data.token === "string" && data.token.length > 0) {
      void setStoredSessionToken(data.token).then(() => {
        window.postMessage(
          { type: "antares:session-token-stored", v: 1 },
          window.location.origin
        )
      })
    }
    return
  }

  // Logout: website tells the bridge to drop the stored token. The next
  // scan from the extension goes out without X-Antares-Session, so the
  // server treats it as anonymous → Free tier.
  if (data.type === "antares:clear-session-token") {
    void clearStoredSessionToken().then(() => {
      window.postMessage(
        { type: "antares:session-token-cleared", v: 1 },
        window.location.origin
      )
    })
    return
  }
})
