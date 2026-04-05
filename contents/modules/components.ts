import type { ScanResponseFlag, ScanResponseData } from "../../shared/types"
import { RISK_CLASS, LABELS, ANALYSIS_PAGE, SVG_MOVE, SVG_CLOSE, VERDICT_COLORS } from "./constants"
import { state } from "./state"
import { SHADOW_CSS, injectFonts } from "./styles"
import { initDrag } from "./drag"

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
  // Inject font stylesheet inside shadow DOM to prevent host-page font overrides
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
  state.shadow?.querySelector("#ant-close")?.addEventListener("click", () => {
    state.manuallyDismissed = true; hideBox()
  }, { once: true })
  state.shadow?.querySelector("#ant-hist-btn")?.addEventListener("click", toggleHistory)
}

export function toggleHistory() {
  const panel = state.shadow?.querySelector("#ant-hist") as HTMLElement | null
  if (!panel) return
  if (panel.classList.contains("open")) { panel.classList.remove("open"); return }
  panel.innerHTML = `<div class="hist-item">Loading...</div>`
  panel.classList.add("open")
  try {
    chrome.runtime.sendMessage({ type: "GET_HISTORY" }, (response) => {
      if (chrome.runtime.lastError) {
        panel.innerHTML = `<div class="hist-item">Extension reloaded \u2014 refresh page</div>`
        return
      }
      if (!response?.ok || !response.history?.length) {
        panel.innerHTML = `<div class="hist-item">No recent scans</div>`
        return
      }
      const items = (response.history as Array<{ ca: string; symbol: string; risk: string; score: number; ts: number }>)
        .map((h) => {
          const rClass = (h.risk || "").toLowerCase()
          return `<div class="hist-item ${rClass}">
  ${escapeHtml(h.symbol || "")}&nbsp;&nbsp;${escapeHtml(h.risk || "")}&nbsp;&nbsp;${h.score}/1000&nbsp;&nbsp;${formatTimeAgo(h.ts)}
</div>`
        }).join("")
      panel.innerHTML = items
    })
  } catch (e: unknown) {
    console.warn("[antares] runtime unavailable", e)
    panel.innerHTML = `<div class="hist-item">Extension reloaded \u2014 refresh page</div>`
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
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`
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
  return `<div class="hdr">
<span class="logo">ANTARES</span>
<span class="hdr-actions">${SVG_MOVE}${SVG_CLOSE}</span>
</div>`
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
    `<span class="dot${i < dotsCount ? " on" : ""}"></span>`
  ).join("")

  const allFlags = (data.flags || []).filter((f: ScanResponseFlag) => f.severity !== "bonus")
  const flagCount = allFlags.length
  const critCount = allFlags.filter((f: ScanResponseFlag) => f.severity === "critical").length
  let summary = ""
  if (flagCount === 0) summary = "No issues found"
  else if (critCount > 0) summary = `${flagCount} flags \u2014 ${critCount} critical`
  else summary = `${flagCount} flags detected`

  // Security indicators
  const boolSI = (siLabel: string, val: unknown, invert = false) => {
    if (val === null || val === undefined)
      return `<span class="si"><span class="si-label">${escapeHtml(siLabel)}</span> <b>\u2014</b></span>`
    const yes = invert ? !val : !!val
    return `<span class="si ${yes ? "y" : "n"}"><span class="si-label">${escapeHtml(siLabel)}</span> <b>${yes ? "\u2713" : "\u2717"}</b></span>`
  }

  const siSell = `<span class="si ${data.honeypot ? "n" : "y"}"><span class="si-label">Sell</span> <b>${data.honeypot ? "\u2717" : "\u2713"}</b></span>`
  const siMint = boolSI("Mint", data.mintAuthority, true)
  const siFreeze = boolSI("Freeze", data.freezeAuthority, true)
  const siLP = boolSI("LP Lock", data.lpBurned ?? data.lpLocked)
  const liqDisplay = liq !== null ? formatMcap(liq) : "\u2014"
  const siLiq = `<span class="si"><span class="si-label">Liq</span> <b${liq !== null && liq > 50000 ? ' class="y"' : ""}>${liqDisplay}</b></span>`

  const rawDexUrl = data.pair?.url
  const safeDexUrl = rawDexUrl && /^https?:\/\//i.test(rawDexUrl) ? rawDexUrl : ""
  const dexLink = safeDexUrl
    ? `<a class="btn" href="${escapeHtml(safeDexUrl)}" target="_blank" rel="noopener">DexScreener</a>`
    : ""
  const analysisLink = `<a class="btn" href="${ANALYSIS_PAGE}?ca=${encodeURIComponent(mint)}" target="_blank" rel="noopener">Full Analysis \u2192</a>`

  return `
${buildHeader()}
${tokenSymbol ? `<div class="token-id"><b>${tokenSymbol}</b> ${tokenName}</div>` : ""}
<h2 class="verdict">${label}</h2>
<div class="sbar"><div class="sbar-fill" data-w="${barW}"></div></div>
<div class="score-line"> <span class="ant-score" data-target="${score}">0</span> / 1000 </div>
<div class="dots">${dots}</div>
<div class="summary">${summary}</div>
${data.aiSummary ? `<div class="ai-summary"><div class="ai-title">AI Summary</div><div class="ai-text">${escapeHtml(data.aiSummary)}</div></div>` : ""}
<div class="si-row">${siSell}${siMint}${siFreeze}${siLP}${siLiq}</div>
<div class="actions">${dexLink}${analysisLink}<button class="btn" id="ant-hist-btn">History</button></div>
<div id="ant-hist" class="hist"></div>
`
}
