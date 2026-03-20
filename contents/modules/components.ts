import type { ScanResponseFlag, ScanResponseData } from "../../shared/types"
import { RISK_CLASS, LABELS, ANALYSIS_PAGE, SVG_MOVE, SVG_CLOSE, VERDICT_COLORS } from "./constants"
import { state } from "./state"
import { SHADOW_CSS, injectFonts } from "./styles"
import { initDrag } from "./drag"

export function formatMcap(mc: number): string {
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
  state.boxEl.style.opacity   = "0"
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
    el.style.opacity   = "1"
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
  state.shadow?.querySelector("#ant-stealth")?.addEventListener("click", () => {
    try {
      chrome.storage.local.set({ antares_stealth: true })
    } catch (e: unknown) { console.warn("[antares]", e) }
    state.stealthMode = true
    hideBox()
  }, { once: true })
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
  chrome.runtime.sendMessage({ type: "GET_HISTORY" }, (response) => {
    if (!response?.ok || !response.history?.length) {
      panel.innerHTML = `<div style="color:#444;font-size:9px;padding:6px 0;font-family:'IBM Plex Mono',monospace">No recent scans</div>`
      return
    }
    const items = (response.history as Array<{ ca: string; symbol: string; risk: string; score: number; ts: number }>)
      .map((h) => {
        const rClass = (h.risk || "").toLowerCase()
        return `<div class="hist-item">
          <span class="hist-sym">${h.symbol}</span>
          <span class="hist-risk ${rClass}">${h.risk}</span>
          <span class="hist-score">${h.score}/1000</span>
          <span class="hist-time">${formatTimeAgo(h.ts)}</span>
        </div>`
      }).join("")
    panel.innerHTML = items
  })
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
  return `<div class="hd"><span class="brand">ANTARES</span><div class="hd-right"><button class="stealth-btn" id="ant-stealth" title="Enable stealth mode (badge only)">&#128065;</button><span class="drag-icon">${SVG_MOVE}</span><button class="x" id="ant-close">${SVG_CLOSE}</button></div></div>`
}

export function buildResult(data: ScanResponseData, ca: string): string {
  const riskClass = RISK_CLASS[data.risk] || "danger"
  const label     = LABELS[data.risk] || data.risk
  const mint      = data.resolvedMint || ca
  const liq       = data.liquidity ?? data.pair?.liquidity?.usd ?? null
  const conf      = typeof data.confidence === "number" ? data.confidence : null
  const score     = data.score || 0
  const barW      = Math.min(100, Math.round(score / 10))

  const tokenName   = data.tokenName   || data.pair?.baseToken?.name   || ""
  const tokenSymbol = data.tokenSymbol || data.pair?.baseToken?.symbol || ""

  if (state.boxEl) state.boxEl.className = `box ${riskClass}`

  const dotsCount = Math.round((score / 1000) * 5)
  const dots = Array.from({length: 5}, (_, i) =>
    `<div class="dt ${i < dotsCount ? 'on' : 'off'}"></div>`
  ).join("")

  const flagCount = (data.flags || []).filter((f: ScanResponseFlag) => f.severity !== "bonus").length
  const critCount = (data.flags || []).filter((f: ScanResponseFlag) => f.severity === "critical").length
  let summary = ""
  if (flagCount === 0) summary = "All sources agree \u2014 no issues found"
  else if (critCount > 0) summary = `${flagCount} flags \u2014 ${critCount} critical \u2014 Conf. ${conf ?? "?"}%`
  else summary = `${flagCount} flags \u2014 Conf. ${conf ?? "?"}%`

  const flagsHtml = (data.flags || []).slice(0, 8).map((f: ScanResponseFlag) => {
    const cls = f.severity === "critical" ? "cr" : f.severity === "warning" ? "wr" : "ok"
    const ic  = f.severity === "critical" ? "r"  : f.severity === "warning" ? "y"  : "g"
    const sym = f.severity === "critical" ? "\u2717" : f.severity === "warning" ? "!" : "\u2713"
    return `<div class="f ${cls}"><span class="ic ${ic}">${sym}</span><span class="ft-txt">${f.label}</span></div>`
  }).join("")
  const noFlags = flagsHtml || `<div class="f ok"><span class="ic g">\u2713</span><span class="ft-txt">No significant risks detected</span></div>`

  const boolSI = (label: string, val: unknown, invert = false) => {
    if (val === null || val === undefined) return `<div class="si"><span>${label}</span><b style="color:#333">\u2014</b></div>`
    const yes = invert ? !val : !!val
    return `<div class="si"><span>${label}</span><b class="${yes ? "y" : "n"}">${yes ? "\u2713" : "\u2717"}</b></div>`
  }

  const siSell   = `<div class="si"><span>Sell</span><b class="${data.honeypot ? "n" : "y"}">${data.honeypot ? "\u2717" : "\u2713"}</b></div>`
  const siMint   = boolSI("Mint", data.mintAuthority, true)
  const siFreeze = boolSI("Freeze", data.freezeAuthority, true)
  const siLP     = boolSI("LP Lock", data.lpBurned ?? data.lpLocked)
  const siLiq    = `<div class="si"><span>Liq</span><b${liq !== null && liq < 5000 ? ' class="n"' : liq !== null && liq > 50000 ? ' class="y"' : ""}>${liq !== null ? formatMcap(liq) : "\u2014"}</b></div>`

  const isDangerous = data.risk === "RUG" || data.risk === "DANGER"
  const dexLink = data.pair?.url
    ? `<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer">DexScreener</a>`
    : ""
  const analysisLink = `<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer"${isDangerous ? ' class="warn"' : ''}>Full Analysis &rarr;</a>`

  const sparkline = buildSparkline(data.candles as Array<{ close: number }> | undefined, data.risk as string)

  return `
    <div class="topbar"></div>
    ${buildHeader()}
    ${tokenSymbol ? `<div class="tk"><b>${tokenSymbol}</b> ${tokenName}</div>` : ""}
    <div class="vb"><h1>${label}</h1></div>
    <div class="sr"><span class="n"><b class="ant-score" data-target="${score}">0</b> / 1000</span><div class="dots">${dots}</div></div>
    <div class="sbar"><div class="sbar-fill" data-w="${barW}"></div></div>
    ${sparkline}
    <div class="sum">${summary}</div>
    <div class="sep"></div>
    <div class="fl">${noFlags}</div>
    <div class="sep"></div>
    <div class="ss">${siSell}${siMint}${siFreeze}${siLP}${siLiq}</div>
    <div class="hist-panel" id="ant-hist"></div>
    <div class="fo">${dexLink}${analysisLink}<button class="hist-btn" id="ant-hist-btn">History</button></div>
  `
}
