export {}

import * as Sentry from "@sentry/browser"
import type { HistoryEntry } from "./shared/types"

// ─── SENTRY INITIALIZATION ──────────────────────────────────────────────────
const SENTRY_DSN = process.env.PLASMO_PUBLIC_SENTRY_DSN || ""
if (SENTRY_DSN) {
  Sentry.init({ dsn: SENTRY_DSN, tracesSampleRate: 0.1 })
}

// ─── KEEPALIVE — empêche Chrome de tuer le Service Worker ───────────────────
// Chrome suspend le SW après ~30s d'inactivité, ce qui coupe les fetches
// en cours et provoque des bugs aléatoires. Ce ping toutes les 20s
// maintient le SW actif tant que l'extension tourne.
function startKeepalive() {
  setInterval(() => {
    // Accès à chrome.runtime.id suffit à réveiller/maintenir le contexte SW
    void chrome.runtime.id;
  }, 20_000);
}

chrome.runtime.onInstalled.addListener(startKeepalive);
chrome.runtime.onStartup.addListener(startKeepalive);
startKeepalive();

// ─── BADGE CONFIG ──────────────────────────────────────────────────────────
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
  void chrome.action.setBadgeBackgroundColor({ color: badge.color, ...target })
}

function checkRiskEscalation(ca: string, currentRisk: string, tokenSymbol: string) {
  const key = `antares_last_risk_${ca}`
  chrome.storage.local.get([key], (result) => {
    const prev = result[key] as string | undefined
    if (prev && riskWorsened(prev, currentRisk)) {
      chrome.notifications.create(`antares_alert_${ca}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("assets/icon.png"),
        title: "Antares \u2014 Risk Escalation",
        message: `${tokenSymbol || ca.slice(0, 8)} risk changed: ${prev} \u2192 ${currentRisk}`,
      })
    }
    void chrome.storage.local.set({ [key]: currentRisk })
  })
}

// ─── HISTORY ───────────────────────────────────────────────────────────────
const HISTORY_KEY = "antares_scan_history"
const MAX_HISTORY = 10

function saveToHistory(ca: string, data: Record<string, unknown>) {
  const entry: HistoryEntry = {
    ca,
    symbol: (data.tokenSymbol as string) || (data.pair as Record<string, Record<string, string>> | undefined)?.baseToken?.symbol || ca.slice(0, 8),
    risk: (data.risk as string) || "UNKNOWN",
    score: (data.score as number) || 0,
    ts: Date.now(),
  }
  chrome.storage.local.get([HISTORY_KEY], (result) => {
    const history = (result[HISTORY_KEY] || []) as HistoryEntry[]
    const filtered = history.filter((h) => h.ca !== ca)
    filtered.unshift(entry)
    void chrome.storage.local.set({ [HISTORY_KEY]: filtered.slice(0, MAX_HISTORY) })
  })
}

// ─── MESSAGE HANDLER ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SCAN") {
    void fetch(`https://antares-extension.vercel.app/api/scan?ca=${msg.ca}`)
      .then((r) => r.json())
      .then((data: Record<string, unknown>) => {
        const risk = data.risk as string | undefined
        if (risk) {
          updateBadge(risk, sender.tab?.id)
          const pair = data.pair as Record<string, Record<string, string>> | undefined
          const sym = ((data.tokenSymbol as string) || pair?.baseToken?.symbol || "")
          checkRiskEscalation(msg.ca as string, risk, sym)
        }
        saveToHistory(msg.ca as string, data as Record<string, unknown>)
        sendResponse({ ok: true, data })
      })
      .catch((e: Error) => {
        Sentry.captureException(e)
        sendResponse({ ok: false, error: e.message })
      })
    return true // keep channel open
  }
  if (msg.type === "GET_HISTORY") {
    chrome.storage.local.get([HISTORY_KEY], (result) => {
      sendResponse({ ok: true, history: (result[HISTORY_KEY] || []) as HistoryEntry[] })
    })
    return true
  }
})
