import type { ScanResponseFlag, ScanResponseData } from "../../shared/types"
import { RISK_CLASS, LABELS, ANALYSIS_PAGE, SVG_MOVE, SVG_CLOSE, VERDICT_COLORS } from "./constants"
import { state, scanCache } from "./state"
import { SHADOW_CSS, injectFonts } from "./styles"
import { initDrag } from "./drag"
import { encodeHashPayload } from "../../shared/hash-payload"
import { toggleAiSummary } from "./ai-summary"

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, ch => HTML_ESCAPE[ch] || ch)
}
function safeText(val: string | null | undefined): string {
  if (!val) return ""
  return escapeHtml(String(val))
}

export function formatMcap(mc: number | null | undefined): string {
  if (mc == null) return "\u2014"
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`
  if (mc >= 1_000_000)     return `$${(mc / 1_000_000).toFixed(2)}M`
  if (mc >= 1_000)         return `$${(mc / 1_000).toFixed(1)}K`
  return `$${mc.toFixed(0)}`
}

export function createHost() {
  injectFonts()
  document.getElementById("antares-host")?.remove()
  state.host = document.createElement("div")
  state.host.id = "antares-host"
  document.documentElement.appendChild(state.host)
  state.shadow = state.host.attachShadow({ mode: "open" })
  const styleEl = document.createElement("style")
  styleEl.textContent = SHADOW_CSS
  state.shadow.appendChild(styleEl)
  const fontLink = document.createElement("link")
  fontLink.rel = "stylesheet"
  fontLink.href = "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap"
  state.shadow.appendChild(fontLink)
  state.boxEl = document.createElement("div")
  state.boxEl.className = "box"
  state.shadow.appendChild(state.boxEl)
  initDrag()
}

export function getBox(): HTMLDivElement {
  if (!state.host || !document.documentElement.contains(state.host)) createHost()
  return state.boxEl!
}

export function hideBox() {
  if (!state.boxEl) return
  state.boxEl.style.transition = "opacity .15s ease, transform .15s ease"
  state.boxEl.style.opacity = "0"
  state.boxEl.style.transform = "translateY(8px)"
  if (state.hideTimeout) clearTimeout(state.hideTimeout)
  state.hideTimeout = setTimeout(() => {
    if (state.boxEl) {
      state.boxEl.style.display = "none"
      state.boxEl.style.transition = "opacity .2s ease, transform .2s ease"
    }
  }, 150)
}

export function showBox() {
  if (!state.host || !document.documentElement.contains(state.host)) createHost()
  const el = state.boxEl!
  if (state.hideTimeout) clearTimeout(state.hideTimeout)
  el.style.display = "block"
  el.style.transition = "opacity .2s ease, transform .2s ease"
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.opacity = "1"
    el.style.transform = "translateY(0)"
  }))
}

export function resetState() {
  state.lastCA = ""
  state.manuallyDismissed = false
  state.currentScanController?.abort()
  state.currentScanController = null
  if (state.rescanTimer) { clearTimeout(state.rescanTimer); state.rescanTimer = null }
  hideBox()
}

export function attachClose(aiSummary?: string | null) {
  state.shadow?.querySelector("#ant-close")?.addEventListener(
    "click",
    () => { state.manuallyDismissed = true; hideBox() },
    { once: true }
  )
  // AI Summary button: toujours actif, jamais disabled
  const aiBtn = state.shadow?.querySelector("#ant-ai-summary-btn")
  if (aiBtn) {
    const fresh = aiBtn.cloneNode(true) as HTMLElement
    aiBtn.parentNode?.replaceChild(fresh, aiBtn)
    // Attacher le listener quel que soit l'état de aiSummary
    fresh.addEventListener("click", () => toggleAiSummary(aiSummary ?? null))
  }
}

/**
 * Attaches the Full Analysis button handler.
 * Delegates tab creation to the background service worker via chrome.runtime.sendMessage
 * because chrome.tabs.create is NOT available in content scripts (MV3).
 */
export function attachAnalysisBtn(mint: string) {
  const btn = state.shadow?.querySelector("#ant-full-analysis")
  if (!btn) return

  // Clone to remove any previous listener
  const fresh = btn.cloneNode(true) as HTMLElement
  btn.parentNode?.replaceChild(fresh, btn)

  fresh.addEventListener("click", (e) => {
    e.preventDefault()
    const cacheEntry = scanCache.get(mint)
    const hashFragment = cacheEntry
      ? encodeHashPayload(cacheEntry.data as unknown as Record<string, unknown>)
      : ""
    const baseUrl = `${ANALYSIS_PAGE}?ca=${encodeURIComponent(mint)}`
    const url = hashFragment ? `${baseUrl}#data=${hashFragment}` : baseUrl
    const reusePattern = `ca=${encodeURIComponent(mint)}`

    // Delegate to background — the only place allowed to call chrome.tabs.create in MV3
    chrome.runtime.sendMessage(
      { type: "OPEN_TAB", url, reusePattern },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          // Last-resort fallback: open via window.open (works from content script)
          window.open(url, "_blank", "noopener,noreferrer")
        }
      }
    )
  })
}

export function showCachedBadge(ageMs: number) {
  const fo = state.shadow?.querySelector(".fo")
  if (!fo) return
  fo.querySelector(".cached-badge")?.remove()
  const mins = Math.max(1, Math.round(ageMs / 60_000))
  const badge = document.createElement("span")
  badge.className = "cached-badge"
  badge.textContent = `\u26a1 cached \u00b7 ${mins}m ago`
  fo.prepend(badge)
}

export function triggerResultAnimations(el: HTMLDivElement) {
  requestAnimationFrame(() => {
    el.querySelectorAll(".sbar-fill").forEach((b: Element) => {
      const bar = b as HTMLElement
      setTimeout(() => { bar.style.width = bar.dataset.w + "%" }, 250)
    })
    const scoreEl = el.querySelector(".ant-score") as HTMLElement | null
    if (scoreEl) {
      const target = parseInt(scoreEl.dataset.target || "0", 10)
      animateScore(scoreEl, target)
    }
  })
}

export function easeOutQuad(t: number): number { return t * (2 - t) }

export function animateScore(el: HTMLElement, target: number, duration = 1100) {
  const start = performance.now()
  function tick(now: number) {
    const elapsed = now - start
    const progress = Math.min(elapsed / duration, 1)
    const value = Math.round(easeOutQuad(progress) * target)
    el.textContent = String(value)
    if (progress < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export function buildSparkline(candles: Array<{ close: number }> | undefined, risk: string): string {
  if (!candles || candles.length < 2) return ""
  const closes = candles.map((c) => c.close)
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const range = max - min || 1
  const w = 60, h = 30
  const points = closes.map((v, i) => {
    const x = (i / (closes.length - 1)) * w
    const y = h - ((v - min) / range) * h
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(" ")
  const color = VERDICT_COLORS[risk] || "#555"
  return `<div class="sparkline"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
}

export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function buildHeader(): string {
  return `<div class="hd"><span class="brand">ANTARES</span><div class="hd-right"><span class="drag-icon">${SVG_MOVE}</span><button class="x" id="ant-close">${SVG_CLOSE}</button></div></div>`
}

export function buildResult(data: ScanResponseData, ca: string): string {
  const riskClass = RISK_CLASS[data.risk] || "danger"
  const label = LABELS[data.risk] || data.risk
  const mint = data.resolvedMint || ca
  const liq = data.liquidity ?? data.pair?.liquidity?.usd ?? null

  const score = data.score || 0
  const barW = Math.min(100, Math.round(score / 10))

  const tokenName = safeText(data.tokenName || data.pair?.baseToken?.name || "")
  const tokenSymbol = safeText(data.tokenSymbol || data.pair?.baseToken?.symbol || "")

  if (state.boxEl) state.boxEl.className = `box ${riskClass}`

  const dotsCount = Math.round((score / 1000) * 5)
  const dots = Array.from({length: 5}, (_, i) =>
    `<div class="dt ${i < dotsCount ? 'on' : 'off'}"></div>`
  ).join("")

  const allFlags = (data.flags || []).filter((f: ScanResponseFlag) => f.severity !== "bonus")
  const flagCount = allFlags.length
  const critCount = allFlags.filter((f: ScanResponseFlag) => f.severity === "critical").length

  let summary = ""
  if (flagCount === 0) summary = "No issues found"
  else if (critCount > 0) summary = `${flagCount} flags \u2014 ${critCount} critical`
  else summary = `${flagCount} flags detected`

  const isDangerous = data.risk === "RUG" || data.risk === "DANGER"

  const boolSI = (siLabel: string, val: unknown, invert = false) => {
    if (val === null || val === undefined) return `<div class="si"><span>${escapeHtml(siLabel)}</span><b style="color:#333">\u2014</b></div>`
    const yes = invert ? !val : !!val
    return `<div class="si"><span>${escapeHtml(siLabel)}</span><b class="${yes ? "y" : "n"}">${yes ? "\u2713" : "\u2717"}</b></div>`
  }
  const siSell = `<div class="si"><span>Sell</span><b class="${data.honeypot ? "n" : "y"}">${data.honeypot ? "\u2717" : "\u2713"}</b></div>`
  const siMint = boolSI("Mint", data.mintAuthority, true)
  const siFreeze = boolSI("Freeze", data.freezeAuthority, true)
  const liqDisplay = liq !== null ? formatMcap(liq) : "\u2014"
  const siLiq = `<div class="si"><span>Liq</span><b${liq !== null && liq < 5000 ? ' class="n"' : liq !== null && liq > 50000 ? ' class="y"' : ""}>${liqDisplay}</b></div>`

  const siLP = (() => {
    if (data.lpBurned) return `<div class="si"><span>LP Burned</span><b class="y">\u2713</b></div>`
    if (data.lpLocked) {
      const pct = data.lpLockedPct != null ? ` ${data.lpLockedPct}%` : ""
      const dur = data.lpLockDurationDays != null ? ` (${data.lpLockDurationDays}d)` : ""
      return `<div class="si"><span>LP Locked${escapeHtml(pct + dur)}</span><b class="y">\u2713</b></div>`
    }
        if (data.lpBurned == null && data.lpLocked == null) return `<div class="si"><span>LP Lock</span><b style="color:#555">\u2014</b></div>`
    return `<div class="si"><span>LP Lock</span><b class="n">\u2717</b></div>`
  })()

  const rawDexUrl = data.pair?.url || `https://dexscreener.com/solana/${mint}`
  const safeDexUrl = rawDexUrl && /^https?:\/\//i.test(rawDexUrl) ? rawDexUrl : ""
  const dexLink = safeDexUrl
    ? `<a href="${escapeHtml(safeDexUrl)}" target="_blank" rel="noopener noreferrer">DexScreener</a>`
    : ""
  const analysisLink = `<a href="#" id="ant-full-analysis" data-ca="${encodeURIComponent(mint)}"${isDangerous ? ' class="warn"' : ''}>Full Analysis \u2192</a>`

  // Bouton AI Summary TOUJOURS actif — jamais disabled
  const aiBtn = `<button class="ai-btn ai-btn--active" id="ant-ai-summary-btn">\u2b21 AI Summary</button>`

  return `
    <div class="topbar"></div>
    ${buildHeader()}
    ${tokenSymbol ? `<div class="tk"><b>${tokenSymbol}</b> ${tokenName}</div>` : ""}
    <div class="vb"><h1>${escapeHtml(label)}</h1></div>
    <div class="sr"><span class="n"><b class="ant-score" data-target="${score}">0</b> / 1000</span><div class="dots">${dots}</div></div>
    <div class="sbar"><div class="sbar-fill" data-w="${barW}"></div></div>
    <div class="sum">${summary}</div>
    <div class="sep"></div>
    <div class="ss">${siSell}${siMint}${siFreeze}${siLP}${siLiq}</div>
    <div class="ai-panel" id="ant-ai-summary"></div>
    <div class="fo">${dexLink}${analysisLink}${aiBtn}</div>
  `
}
