import type { ScanResponseFlag, ScanResponseData } from "../../shared/types"
import { RISK_CLASS, LABELS, ANALYSIS_PAGE, SVG_MOVE, SVG_CLOSE, VERDICT_COLORS } from "./constants"
import { state, scanCache } from "./state"
import { SHADOW_CSS, injectFonts } from "./styles"
import { initDrag } from "./drag"
import { encodeHashPayload } from "../../shared/hash-payload"
import { logger } from "../../shared/logger"

// ─── HTML ESCAPE UTILITY ──────────────────────────────────────────────────────
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

export function attachClose() {
  state.shadow?.querySelector("#ant-close")?.addEventListener("click", () => { state.manuallyDismissed = true; hideBox() }, { once: true })
  state.shadow?.querySelector("#ant-hist-btn")?.addEventListener("click", toggleHistory)
}

/**
 * Attaches the smart-tab handler to the Full Analysis button.
 *
 * New behaviour (Solution 4):
 * 1. Encode the cached scan result as a base64url hash payload
 * 2. Look for an existing tab already open on this token's analysis page
 *    - If found: focus it and reload with the fresh hash (0 extra tabs)
 *    - If not found: open exactly one new tab with the hash embedded
 *
 * The token.html page reads this hash and renders instantly at 0ms,
 * no network request needed.
 */
export function attachAnalysisBtn(mint: string) {
  const btn = state.shadow?.querySelector("#ant-full-analysis")
  if (!btn) return
  btn.addEventListener("click", (e) => {
    e.preventDefault()
    const cacheEntry = scanCache.get(mint)
    const hashFragment = cacheEntry ? encodeHashPayload(cacheEntry.data as unknown as Record<string, unknown>) : ""
    const baseUrl = `${ANALYSIS_PAGE}?ca=${encodeURIComponent(mint)}`
    const urlWithHash = hashFragment ? `${baseUrl}#data=${hashFragment}` : baseUrl
    try {
      chrome.tabs.query({ url: `${ANALYSIS_PAGE}*` }, (tabs) => {
        if (chrome.runtime.lastError) {
          void chrome.tabs.create({ url: urlWithHash })
          return
        }
        const existing = tabs.find((t) =>
          typeof t.url === "string" && t.url.includes(`ca=${encodeURIComponent(mint)}`)
        )
        if (existing?.id !== undefined && existing.windowId !== undefined) {
          void chrome.tabs.update(existing.id, { active: true, url: urlWithHash })
          void chrome.windows.update(existing.windowId, { focused: true })
        } else {
          void chrome.tabs.create({ url: urlWithHash })
        }
      })
    } catch {
      void chrome.tabs.create({ url: urlWithHash })
    }
  }, { once: true })
}

/**
 * Injects a subtle 'CACHED · Xm ago' badge in the overlay footer
 * to inform the user that the result came from local storage, not a live API call.
 */
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

export function toggleHistory() {
  const panel = state.shadow?.querySelector("#ant-hist") as HTMLElement | null
  if (!panel) return
  if (panel.classList.contains("open")) {
    panel.classList.remove("open")
    return
  }
  panel.innerHTML = `<div style="color:#555;font-size:9px;padding:6px 0;font-family:'IBM Plex Mono',monospace">Loading...</div>`
  panel.classList.add("open")
  try {
    chrome.runtime.sendMessage({ type: "GET_HISTORY" }, (response) => {
      if (chrome.runtime.lastError) {
        panel.innerHTML = `<div style="color:#444;font-size:9px;padding:6px 0;font-family:'IBM Plex Mono',monospace">Extension reloaded \u2014 refresh page</div>`
        return
      }
      if (!response?.ok || !response.history?.length) {
        panel.innerHTML = `<div style="color:#444;font-size:9px;padding:6px 0;font-family:'IBM Plex Mono',monospace">No recent scans</div>`
        return
      }
      const items = (response.history as Array<{ ca: string; symbol: string; risk: string; score: number; ts: number }>)
        .map((h) => {
          const rClass = (h.risk || "").toLowerCase()
          return `<div class="hist-item">
            <span class="hist-sym">${escapeHtml(h.symbol || "")}</span>
            <span class="hist-risk ${rClass}">${escapeHtml(h.risk || "")}</span>
            <span class="hist-score">${h.score}/1000</span>
            <span class="hist-time">${formatTimeAgo(h.ts)}</span>
          </div>`
        }).join("")
      panel.innerHTML = items
    })
  } catch (e: unknown) {
    logger.warn("runtime unavailable", e)
    panel.innerHTML = `<div style="color:#444;font-size:9px;padding:6px 0;font-family:'IBM Plex Mono',monospace">Extension reloaded \u2014 refresh page</div>`
  }
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
      return `<div class="si"><span>LP Lock</span><b class="n">\u2717</b></div>`
    })()
      const rawDexUrl = data.pair?.url
  const safeDexUrl = rawDexUrl && /^https?:\/\//i.test(rawDexUrl) ? rawDexUrl : ""
  const dexLink = safeDexUrl
    ? `<a href="${escapeHtml(safeDexUrl)}" target="_blank" rel="noopener noreferrer">DexScreener</a>`
    : ""
  const analysisLink = `<a href="#" id="ant-full-analysis" data-ca="${encodeURIComponent(mint)}"${isDangerous ? ' class="warn"' : ''}>Full Analysis \u2192</a>`

  return `
    <div class="topbar"></div>
    ${buildHeader()}
    ${tokenSymbol ? `<div class="tk"><b>${tokenSymbol}</b> ${tokenName}</div>` : ""}
    <div class="vb"><h1>${label}</h1></div>
    <div class="sr"><span class="n"><b class="ant-score" data-target="${score}">0</b> / 1000</span><div class="dots">${dots}</div></div>
    <div class="sbar"><div class="sbar-fill" data-w="${barW}"></div></div>
    <div class="sum">${summary}</div>
    ${data.aiSummary ? `<div class="antares-ai-summary" style="margin-top:8px;font-family:'IBM Plex Mono',monospace;font-size:11px;opacity:0.7"><div style="font-size:9px;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin-bottom:2px">AI Summary</div>${escapeHtml(data.aiSummary)}</div>` : ""}
    <div class="sep"></div>
    <div class="ss">${siSell}${siMint}${siFreeze}${siLP}${siLiq}</div>
    <div class="hist-panel" id="ant-hist"></div>
    <div class="fo">${dexLink}${analysisLink}<button class="hist-btn" id="ant-hist-btn">History</button></div>
  `
}
