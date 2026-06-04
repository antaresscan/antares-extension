export {}

import * as Sentry from "@sentry/browser"
import type { HistoryEntry } from "./shared/types"
import { CA_RE } from "./shared/constants"
import { config } from "./shared/config"
import { logger } from "./shared/logger"
import { getInstallId } from "./shared/install-id"
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
  Sentry.init({
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

function safeRecord(val: unknown): Record<string, unknown> | undefined {
  return typeof val === "object" && val !== null && !Array.isArray(val)
    ? val as Record<string, unknown>
    : undefined
}

function extractSymbol(data: Record<string, unknown>): string {
  const sym = safeString(data.tokenSymbol)
  if (sym) return sym
  const pair = safeRecord(data.pair)
  if (pair) {
    const baseToken = safeRecord(pair.baseToken)
    if (baseToken) {
      const s = safeString(baseToken.symbol)
      if (s) return s
    }
  }
  return ""
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
  "antares-website.vercel.app",
  "comealamaisongroupe.github.io"
])

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
function saveToHistory(ca: string, data: Record<string, unknown>) {
  const entry: HistoryEntry = {
    ca,
    symbol: extractSymbol(data) || ca.slice(0, 8),
    risk: safeString(data.risk) || "UNKNOWN",
    score: safeNumber(data.score),
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
  SCAN: (msg, sender, sendResponse) => {
    const ca = typeof msg.ca === "string" ? msg.ca.trim() : ""

    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "Unauthorized sender" })
      return
    }

    if (!CA_RE.test(ca)) {
      sendResponse({ ok: false, error: "Invalid contract address" })
      return
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs)

    void Promise.all([
      getInstallId(),
      new Promise<{ antares_dev_tier?: string; antares_session_token?: string }>((resolve) =>
        chrome.storage.local.get(
          ["antares_dev_tier", "antares_session_token"],
          (v) => resolve(v as { antares_dev_tier?: string; antares_session_token?: string }),
        ),
      ),
    ])
      .then(([installId, store]) => {
        const headers: Record<string, string> = installId ? { "X-Antares-Install": installId } : {}
        const devTier = store.antares_dev_tier
        if (
          devTier === "free" ||
          devTier === "pro" ||
          devTier === "yearly" ||
          devTier === "lifetime"
        ) {
          headers["X-Antares-Dev-Tier"] = devTier
        }
        // Session token from the website bridge (see contents/antares-
        // website-bridge.ts). The website pushes the JWT after login/link
        // and the extension echoes it on every scan so the server knows
        // who the user is — independent of cookies. This is the reliable
        // path: chrome-extension:// → API cookies are increasingly blocked
        // by Chrome's third-party cookie phase-out, so we don't depend on
        // them. The cookie still flows via credentials:"include" as a
        // fallback for browsers that allow it.
        const sessionToken = store.antares_session_token
        if (typeof sessionToken === "string" && sessionToken.length > 0) {
          headers["X-Antares-Session"] = sessionToken
        }
        return fetch(`${config.apiBase}/api/scan?ca=${ca}`, {
          signal: ctrl.signal,
          headers,
          credentials: "include",
        })
      })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((data: Record<string, unknown>) => {
        clearTimeout(timer)
        const risk = safeString(data.risk)
        if (risk) {
          updateBadge(risk, sender.tab?.id)
          checkRiskEscalation(ca, risk, extractSymbol(data))
        }
        saveToHistory(ca, data)
        sendResponse({ ok: true, data })
      })
      .catch((e: Error) => {
        clearTimeout(timer)
        Sentry.captureException(e)
        sendResponse({ ok: false, error: e.message })
      })
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
let extensionEnabled = true
chrome.storage.local.get(["extensionEnabled"], (r) => {
  if (typeof r.extensionEnabled === "boolean") extensionEnabled = r.extensionEnabled
})

chrome.action.onClicked.addListener(async (_tab) => {
  extensionEnabled = !extensionEnabled
  void chrome.storage.local.set({ extensionEnabled })

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
