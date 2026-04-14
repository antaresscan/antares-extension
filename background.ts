export {}

import * as Sentry from "@sentry/browser"
import type { HistoryEntry } from "./shared/types"
import { CA_RE } from "./shared/constants"
import { config } from "./shared/config"

// ─── SENTRY INITIALIZATION ───────────────────────────────────────────────────────────────
if (config.sentryDsn) {
  Sentry.init({ dsn: config.sentryDsn, tracesSampleRate: config.sentryTracesSampleRate })
}

// ─── SAFE DATA EXTRACTION HELPERS ───────────────────────────────────────────────────────
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

// ─── KEEPALIVE — chrome.alarms replaces setInterval for MV3 service workers ──
void chrome.alarms.create(config.keepaliveAlarmName, { periodInMinutes: config.keepaliveIntervalMinutes });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === config.keepaliveAlarmName) void chrome.runtime.id; });

// ─── BADGE CONFIG ────────────────────────────────────────────────────────────────
const BADGE_MAP: Record<string, { text: string; color: string }> = {
  SAFE: { text: "\u2713", color: "#00e5b0" },
  CAUTION: { text: "!", color: "#f5d000" },
  DANGER: { text: "\u2717", color: "#ff5f5f" },
  RUG: { text: "\u2717", color: "#ff2244" },
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
        console.warn("[antares] storage.get error:", chrome.runtime.lastError.message)
        return
      }
      const prev = safeString(result[key])
      if (prev && riskWorsened(prev, currentRisk)) {
        void chrome.notifications.create(`antares_alert_${ca}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("assets/icon.png"),
          title: "Antares \u2014 Risk Escalation",
          message: `${tokenSymbol || ca.slice(0, 8)} risk changed: ${prev} \u2192 ${currentRisk}`,
        })
      }
      void chrome.storage.local.set({ [key]: currentRisk })
    })
  } catch (e: unknown) {
    console.warn("[antares] checkRiskEscalation error:", e)
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
        console.warn("[antares] storage.get error:", chrome.runtime.lastError.message)
        return
      }
      const history = (Array.isArray(result[config.historyStorageKey]) ? result[config.historyStorageKey] : []) as HistoryEntry[]
      const filtered = history.filter((h) => h.ca !== ca)
      filtered.unshift(entry)
      void chrome.storage.local.set({ [config.historyStorageKey]: filtered.slice(0, config.maxHistoryEntries) })
    })
  } catch (e: unknown) {
    console.warn("[antares] saveToHistory error:", e)
  }
}

 // ─── MESSAGE HANDLER (map-based) ────────────────────────────────────────────────────────
type MessageHandler = (
  msg: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) => void

const handlers: Record<string, MessageHandler> = {
  SCAN: (msg, sender, sendResponse) => {
    const ca = typeof msg.ca === "string" ? msg.ca.trim() : ""

    // Security: only accept messages from our own extension or content scripts
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "Unauthorized sender" })
      return true
    }

    if (!CA_RE.test(ca)) {
      sendResponse({ ok: false, error: "Invalid contract address" })
      return true
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs)

    void fetch(`${config.apiBase}/api/scan?ca=${ca}`, {
      signal: ctrl.signal,
    })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((data: Record<string, unknown>) => {
      clearTimeout(timer)
      const risk = safeString(data.risk)
      if (risk) {
        updateBadge(risk, sender.tab?.id)
        const sym = extractSymbol(data)
        checkRiskEscalation(ca, risk, sym)
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
        sendResponse({ ok: true, history: (Array.isArray(result[config.historyStorageKey]) ? result[config.historyStorageKey] : []) as HistoryEntry[] })
      })
    } catch (e: unknown) {
      sendResponse({ ok: false, error: String(e) })
    }
  },
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg.type as string]
  if (handler) {
    handler(msg, sender, sendResponse)
    return true // keep channel open for async response
  }
})

// ─── EXTENSION TOGGLE (click icon to enable/disable) ────────────────────────
let extensionEnabled = true
chrome.storage.local.get(["extensionEnabled"], (r) => {
  if (typeof r.extensionEnabled === "boolean") extensionEnabled = r.extensionEnabled
})

chrome.action.onClicked.addListener(async (_tab) => {
  extensionEnabled = !extensionEnabled
    void chrome.storage.local.set({ extensionEnabled })
  const label = "\u25CF"
  void chrome.action.setBadgeText({ text: label })
  void chrome.action.setBadgeBackgroundColor({ color: "#FFFFFF" })
  void chrome.action.setBadgeTextColor({
    color: extensionEnabled ? "#00e5b0" : "#ff5f5f",
  })
  // Broadcast to ALL tabs so every content script toggles instantly
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id) {
        chrome.tabs.sendMessage(t.id, {
          type: "EXTENSION_TOGGLE",
          enabled: extensionEnabled,
        }).catch(() => { /* no content script in this tab */ })
      }
    }
  })
})
