export {}

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
  chrome.action.setBadgeText({ text: badge.text, ...target })
  chrome.action.setBadgeBackgroundColor({ color: badge.color, ...target })
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
    chrome.storage.local.set({ [key]: currentRisk })
  })
}

// ─── MESSAGE HANDLER ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "SCAN") {
    fetch(`https://antares-extension.vercel.app/api/scan?ca=${msg.ca}`)
      .then((r) => r.json())
      .then((data) => {
        const risk = data.risk as string | undefined
        if (risk) {
          updateBadge(risk, sender.tab?.id)
          const sym = (data.tokenSymbol || data.pair?.baseToken?.symbol || "") as string
          checkRiskEscalation(msg.ca as string, risk, sym)
        }
        sendResponse({ ok: true, data })
      })
      .catch((e: Error) => sendResponse({ ok: false, error: e.message }))
    return true // keep channel open
  }
})
