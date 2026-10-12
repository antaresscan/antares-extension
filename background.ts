export {}

// Named imports only — a namespace import (`import * as Sentry`) defeats
// tree-shaking and drags lazyLoadIntegration() + getReportDialogEndpoint()
// into the bundle. Those build `<script src="https://browser.sentry-cdn.com/...">`
// at runtime → "remotely-hosted code" → MV3 / CWS rejection. Importing only
// the two symbols we use lets the bundler drop the CDN-loading code paths.
import { init as sentryInit, captureException as sentryCapture } from "@sentry/browser"
import type { HistoryEntry } from "./shared/types"
import { CA_RE } from "./shared/constants"
import { config } from "./shared/config"
import { logger } from "./shared/logger"
import { getInstallId } from "./shared/install-id"
import { toggleExtensionEnabled } from "./shared/extension-toggle"
import { scrubEvent, scrubBreadcrumb } from "./shared/sentry-scrub"

// ─── SENTRY INITIALIZATION ───────────────────────────────────────────────────
// `sendDefaultPii: false` + `beforeSend` + `beforeBreadcrumb` wire the
// same SCRUB_KEYS / URL-query-strip the backend uses (api/_lib/sentry.ts).
// Without these, the browser Sentry SDK silently shipped:
//   - the full request URL including `?ca=<contract>` via XHR
//     breadcrumbs (every overlay scan call),
//   - any email / JWT / authorization header attached to the scope
//     via captureException-with-context,
// violating privacy.html's "Sentry: never the contract address or
// your IP" promise on the entire extension surface.
if (config.sentryDsn) {
  sentryInit({
    dsn: config.sentryDsn,
    tracesSampleRate: config.sentryTracesSampleRate,
    sendDefaultPii: false,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  })
}

// ─── SAFE DATA EXTRACTION HELPERS ─────────────────────────────────────────────
function safeString(val: unknown): string | undefined {
  return typeof val === "string" ? val : undefined
}

function safeNumber(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) ? val : 0
}

// Hosts the OPEN_TAB handler is allowed to open. Anything else — even an
// HTTPS URL — is rejected and the caller falls back to window.open(), which
// still has the page's CSP + popup-blocker + user-gesture gates in front of
// it. This is the second line of defence behind `sender.id` checking: it
// prevents a compromised content script (XSS on a host site that somehow
// reaches the message handler) from using the extension's tab privileges
// to spawn a phishing page under an Antares-trusted-looking pattern.
//
// Update this list when introducing a new product host. Localhost dev is
// intentionally excluded — devs working against PLASMO_PUBLIC_ANALYSIS_URL
// see the window.open fallback and can sideload normally.
const ALLOWED_OPEN_TAB_HOSTS = new Set([
  "antares-extension.vercel.app",
  "antaresscan.com",
  "www.antaresscan.com",
  "antares-website.vercel.app"
])

// ─── INSTALL ID ───────────────────────────────────────────────────────────────
// Create the install id as soon as the extension is installed or updated, so it exists before any content script or the
// Options page asks for it (shared/install-id.ts is safe when they race, this makes the race rare in the first place).
chrome.runtime.onInstalled.addListener(() => { void getInstallId() })

// ─── KEEPALIVE ────────────────────────────────────────────────────────────────
void chrome.alarms.create(config.keepaliveAlarmName, { periodInMinutes: config.keepaliveIntervalMinutes })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === config.keepaliveAlarmName) void chrome.runtime.id })

// ─── BADGE CONFIG ─────────────────────────────────────────────────────────────
const BADGE_MAP: Record<string, { text: string; color: string }> = {
  SAFE:    { text: "\u2713", color: "#00e5b0" },
  CAUTION: { text: "!",     color: "#f5d000" },
  DANGER:  { text: "\u2717", color: "#ff5f5f" },
  RUG:     { text: "\u2717", color: "#ff2244" },
}

const RISK_ORDER: Record<string, number> = { SAFE: 0, CAUTION: 1, DANGER: 2, RUG: 3 }

// A symbol only labels the notification / history row; cap what we accept.
const MAX_SYMBOL_LENGTH = 24

function riskWorsened(prev: string, current: string): boolean {
  const p = RISK_ORDER[prev]
  const c = RISK_ORDER[current]
  return p !== undefined && c !== undefined && c > p
}

function updateBadge(risk: string, tabId?: number) {
  const badge = BADGE_MAP[risk]
  if (!badge) return
  const target = tabId !== undefined ? { tabId } : {}
  void chrome.action.setBadgeText({ text: badge.text, ...target })
  void chrome.action.setBadgeBackgroundColor({ color: "#FFFFFF", ...target })
  void chrome.action.setBadgeTextColor({ color: badge.color, ...target })
}

function checkRiskEscalation(ca: string, currentRisk: string, tokenSymbol: string) {
  const key = `${config.riskStoragePrefix}${ca}`
  try {
    chrome.storage.local.get([key], (result) => {
      if (chrome.runtime.lastError) {
        logger.warn("background", "storage.get error", chrome.runtime.lastError.message)
        return
      }
      const prev = safeString(result[key])
      if (prev && riskWorsened(prev, currentRisk)) {
        // Plasmo hashes icon paths at build time (icon128.plasmo.<hash>.png),
        // so we can't hardcode "assets/icon.png" \u2014 that file doesn't exist
        // in the packaged build. Read the real icon path from the runtime
        // manifest, which Plasmo populates with the correct hashed names.
        // Without a resolvable iconUrl, chrome.notifications.create() fails
        // silently and the user never sees the alert.
        const icons = chrome.runtime.getManifest().icons as Record<string, string> | undefined
        const iconPath = icons?.["128"] || icons?.["64"] || icons?.["48"] || icons?.["32"] || ""
        void chrome.notifications.create(`antares_alert_${ca}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL(iconPath),
          title: "Antares \u2014 Risk Escalation",
          message: `${tokenSymbol || ca.slice(0, 8)} risk changed: ${prev} \u2192 ${currentRisk}`,
        })
      }
      void chrome.storage.local.set({ [key]: currentRisk })
    })
  } catch (e: unknown) {
    logger.warn("background", "checkRiskEscalation error", String(e))
  }
}

// ─── HISTORY ─────────────────────────────────────────────────────────────────
function saveToHistory(ca: string, risk: string, score: number, symbol: string) {
  const entry: HistoryEntry = {
    ca,
    symbol: symbol || ca.slice(0, 8),
    risk,
    score,
    ts: Date.now(),
  }
  try {
    chrome.storage.local.get([config.historyStorageKey], (result) => {
      if (chrome.runtime.lastError) {
        logger.warn("background", "storage.get error in saveToHistory", chrome.runtime.lastError.message)
        return
      }
      const history = (Array.isArray(result[config.historyStorageKey])
        ? result[config.historyStorageKey]
        : []) as HistoryEntry[]
      const filtered = history.filter((h) => h.ca !== ca)
      filtered.unshift(entry)
      void chrome.storage.local.set({ [config.historyStorageKey]: filtered.slice(0, config.maxHistoryEntries) })
    })
  } catch (e: unknown) {
    logger.warn("background", "saveToHistory error", String(e))
  }
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────
type MessageHandler = (
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => void

const handlers: Record<string, MessageHandler> = {
  /**
   * SCAN_RESULT — sent by the content script every time the overlay shows a
   * verdict (see contents/modules/scan-report.ts). The service worker no
   * longer fetches scans itself: it only turns the verdict into the toolbar
   * badge, the risk-escalation notification and the local scan history.
   *
   * Payload: { type: "SCAN_RESULT", ca, risk, score, symbol }
   */
  SCAN_RESULT: (msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "Unauthorized sender" })
      return
    }

    const ca = typeof msg.ca === "string" ? msg.ca.trim() : ""
    const risk = safeString(msg.risk)
    // hasOwnProperty, not `in`: "constructor" / "__proto__" must not pass as a risk.
    if (!CA_RE.test(ca) || !risk || !Object.prototype.hasOwnProperty.call(BADGE_MAP, risk)) {
      sendResponse({ ok: false, error: "Invalid scan result" })
      return
    }
    const symbol = (safeString(msg.symbol) ?? "").slice(0, MAX_SYMBOL_LENGTH)

    updateBadge(risk, sender.tab?.id)
    checkRiskEscalation(ca, risk, symbol)
    saveToHistory(ca, risk, safeNumber(msg.score), symbol)
    sendResponse({ ok: true })
  },

  GET_HISTORY: (_msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "Unauthorized sender" })
      return
    }
    try {
      chrome.storage.local.get([config.historyStorageKey], (result) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message })
          return
        }
        sendResponse({
          ok: true,
          history: (Array.isArray(result[config.historyStorageKey])
            ? result[config.historyStorageKey]
            : []) as HistoryEntry[],
        })
      })
    } catch (e: unknown) {
      sendResponse({ ok: false, error: String(e) })
    }
  },

  /**
   * OPEN_TAB — delegated from content scripts.
   * chrome.tabs.create is forbidden in content scripts (MV3).
   * The background service worker is the only place that can open tabs.
   *
   * Payload: { type: "OPEN_TAB", url: string, reusePattern?: string }
   *   - url: the full URL to open
   *   - reusePattern: optional URL match string; if an existing tab matches, reuse it
   */
  LOG_ERROR: (msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "Unauthorized sender" })
      return
    }
    const message = typeof msg.message === "string" ? msg.message : "Unknown content-script error"
    const stack = typeof msg.stack === "string" ? msg.stack : undefined
    const err = new Error(message)
    if (stack) err.stack = stack
    sentryCapture(err)
    sendResponse({ ok: true })
  },

  OPEN_TAB: (msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "Unauthorized sender" })
      return
    }

    const url = safeString(msg.url)
    if (!url) {
      sendResponse({ ok: false, error: "Invalid URL" })
      return
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      sendResponse({ ok: false, error: "Invalid URL" })
      return
    }
    // HTTPS only — drop the legacy `http?:` allowance. No host on the
    // allowlist serves over plain HTTP, so http URLs are categorically a
    // sign of either dev fallback (should go through window.open instead)
    // or attempted abuse.
    if (parsed.protocol !== "https:") {
      sendResponse({ ok: false, error: "Invalid URL: https required" })
      return
    }
    if (!ALLOWED_OPEN_TAB_HOSTS.has(parsed.hostname)) {
      sendResponse({ ok: false, error: "Invalid URL: host not allowed" })
      return
    }

    const reusePattern = safeString(msg.reusePattern)

    if (reusePattern) {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError) {
          void chrome.tabs.create({ url })
          sendResponse({ ok: true })
          return
        }
        const existing = tabs.find(
          (t) => typeof t.url === "string" && t.url.includes(reusePattern)
        )
        if (existing?.id !== undefined) {
          void chrome.tabs.update(existing.id, { active: true, url })
          if (existing.windowId !== undefined) {
            void chrome.windows.update(existing.windowId, { focused: true })
          }
        } else {
          void chrome.tabs.create({ url })
        }
        sendResponse({ ok: true })
      })
    } else {
      void chrome.tabs.create({ url })
      sendResponse({ ok: true })
    }
  },

}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg.type as string]
  if (handler) {
    handler(msg, sender, sendResponse)
    return true
  }
})

// ─── EXTENSION TOGGLE ─────────────────────────────────────────────────────────
// The state is read from chrome.storage at click time (shared/extension-toggle.ts), not kept in a variable: the service
// worker that handles the click was often started by it, before any startup read could have finished.
chrome.action.onClicked.addListener(async (_tab) => {
  const extensionEnabled = await toggleExtensionEnabled(chrome.storage.local)

  void chrome.action.setBadgeText({ text: "\u25CF" })
  void chrome.action.setBadgeBackgroundColor({ color: "#FFFFFF" })
  void chrome.action.setBadgeTextColor({ color: extensionEnabled ? "#00e5b0" : "#ff5f5f" })

  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id) {
        chrome.tabs.sendMessage(t.id, { type: "EXTENSION_TOGGLE", enabled: extensionEnabled })
          .catch(() => { /* no content script */ })
      }
    }
  })
})
