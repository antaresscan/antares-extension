import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API = "https://antares-extension.vercel.app/api/scan"
const ANALYSIS_PAGE = "https://antares-extension.vercel.app/token.html"
const LS_PREFIX = "antares_scan_"

const COLORS: Record<string, string> = {
  SAFE:    "#22c55e",
  CAUTION: "#f97316",
  DANGER:  "#ef4444",
  RUG:     "#dc2626"
}

const LABELS: Record<string, string> = {
  SAFE:    "SAFE",
  CAUTION: "CAUTION",
  DANGER:  "DANGER",
  RUG:     "RUG PULL"
}

const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
const WALKER_LIMIT = 500

const IGNORE = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "TokenzQdBNbequAOoiqaLs8AA6CRCmvsembyniztzCFm",
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
])

const CACHE_TTL = 90_000
const scanCache = new Map<string, { data: any; ts: number }>()

;(function hydrateCacheFromLS() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(LS_PREFIX)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw)
      if (!parsed?.data || !parsed?.ts) continue
      if (Date.now() - parsed.ts > CACHE_TTL) { localStorage.removeItem(key); continue }
      scanCache.set(key.slice(LS_PREFIX.length), { data: parsed.data, ts: parsed.ts })
    }
  } catch (_) {}
})()

function getCached(ca: string): any | null {
  const e = scanCache.get(ca)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL) { scanCache.delete(ca); return null }
  return e.data
}

function saveToLS(ca: string, data: any) {
  try { localStorage.setItem(LS_PREFIX + ca, JSON.stringify({ data, ts: Date.now() })) } catch (_) {}
}

function formatMcap(mc: number): string {
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`
  if (mc >= 1_000_000)     return `$${(mc / 1_000_000).toFixed(2)}M`
  if (mc >= 1_000)         return `$${(mc / 1_000).toFixed(1)}K`
  return `$${mc.toFixed(0)}`
}

// ─── Shadow DOM host ─────────────────────────────────────────────────────────
let host: HTMLDivElement | null = null
let shadow: ShadowRoot | null = null

// ALL styles live here — completely isolated from the host page
const BOX_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap');

  :host {
    all: initial;
    position: fixed;
    /* full-viewport anchor so nothing on the host page can shift us */
    inset: 0;
    width: 0;
    height: 0;
    z-index: 2147483647;
    pointer-events: none;
    contain: layout style paint;
  }

  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  #antares-box {
    pointer-events: auto;
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    width: 300px;

    background: #0d0d0f;
    border: 1px solid #1f1f22;
    border-radius: 0;

    font-family: 'IBM Plex Mono', 'SF Mono', 'Fira Code', monospace;
    font-size: 13px;
    color: #d8d8d8;
    line-height: 1.4;

    display: none;
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.22s ease, transform 0.22s ease;
  }

  /* ── Header ── */
  .ant-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px 9px;
    border-bottom: 1px solid #1a1a1d;
  }
  .ant-logo {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .3em;
    text-transform: uppercase;
  }
  .ant-close {
    cursor: pointer;
    color: #2e2e33;
    font-size: 18px;
    line-height: 1;
    transition: color .15s, transform .15s;
    pointer-events: auto;
  }
  .ant-close:hover { color: #d8d8d8; transform: rotate(90deg); }

  /* ── Body ── */
  .ant-body { padding: 12px 14px; }

  .ant-verdict {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
    margin-bottom: 4px;
    line-height: 1;
  }

  .ant-score-row {
    display: flex;
    align-items: baseline;
    gap: 4px;
    margin-bottom: 10px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: #4a4a50;
  }
  .ant-score-row strong { color: #aaa; font-weight: 600; }
  .ant-mcap { margin-left: auto; font-size: 11px; color: #383840; }

  /* ── Progress bar ── */
  .ant-bar {
    height: 3px;
    background: #1c1c1f;
    margin-bottom: 10px;
    overflow: hidden;
  }
  .ant-bar-f {
    height: 100%;
    width: 0%;
    transition: width 1.1s cubic-bezier(.22,1,.36,1);
  }

  /* ── Stats grid ── */
  .ant-stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 5px;
    margin-bottom: 10px;
  }
  .ant-stat {
    padding: 7px 9px;
    background: #111114;
    border: 1px solid #1c1c1f;
  }
  .ant-stat-label {
    display: block;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    color: #3a3a3f;
    letter-spacing: .1em;
    text-transform: uppercase;
    margin-bottom: 2px;
  }
  .ant-stat-val {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: #bbb;
    font-weight: 600;
  }

  /* ── Flags ── */
  .ant-flags { margin-bottom: 10px; }
  .ant-flag {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: #505058;
    padding: 3px 0 3px 10px;
    border-left: 2px solid;
    margin-top: 3px;
  }

  /* ── Footer ── */
  .ant-footer {
    display: flex;
    gap: 10px;
    padding: 8px 14px;
    border-top: 1px solid #1c1c1f;
    background: #111114;
  }
  .ant-link {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: #3a3a3f;
    text-decoration: none;
    letter-spacing: .05em;
    text-transform: uppercase;
    transition: color .15s;
  }
  .ant-link:hover { color: #d8d8d8; }
  .ant-link-primary {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    font-weight: 700;
    text-decoration: none;
    letter-spacing: .05em;
    text-transform: uppercase;
    margin-left: auto;
    transition: opacity .15s;
  }
  .ant-link-primary:hover { opacity: .75; }

  /* ── Scanning state ── */
  @keyframes ant-pulse { 0%,100%{opacity:1} 50%{opacity:.15} }
  .ant-scanning {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #555;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    padding: 12px 14px;
  }
  .ant-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #555;
    display: inline-block;
    animation: ant-pulse 1.2s infinite;
  }

  .ant-ca {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    color: #2a2a2a;
    padding: 0 14px 8px;
  }
`

function ensureHost() {
  if (host && document.documentElement.contains(host)) return
  host = document.createElement("div")
  shadow = host.attachShadow({ mode: "open" })

  const style = document.createElement("style")
  style.textContent = BOX_CSS
  shadow.appendChild(style)

  // Mount on <html>, not <body> — survives body replacements on SPAs
  document.documentElement.appendChild(host)
}

function getBox(): HTMLDivElement {
  ensureHost()
  let b = shadow!.getElementById("antares-box") as HTMLDivElement | null
  if (!b) {
    b = document.createElement("div")
    b.id = "antares-box"
    shadow!.appendChild(b)
  }
  return b
}

// ─── Build HTML ──────────────────────────────────────────────────────────────

function buildResult(data: any, ca: string): string {
  const color = COLORS[data.risk] || "#6b7280"
  const label = LABELS[data.risk] || data.risk
  const displayCA = data.resolvedMint || ca
  const mint = data.resolvedMint || ca

  const mc      = data.pair?.marketCap || data.pair?.fdv
  const liq     = data.pair?.liquidity?.usd
  const holders = data.holders ?? data.pair?.holders
  const conf    = typeof data.confidence === "number" ? data.confidence : null
  const score   = data.score ?? 0

  const barWidth = Math.round(score / 10)

  const statsHtml = `
    <div class="ant-stats">
      ${mc      ? `<div class="ant-stat"><span class="ant-stat-label">Market Cap</span><span class="ant-stat-val">${formatMcap(mc)}</span></div>` : ""}
      ${liq     ? `<div class="ant-stat"><span class="ant-stat-label">Liquidity</span><span class="ant-stat-val">${formatMcap(liq)}</span></div>` : ""}
      ${holders ? `<div class="ant-stat"><span class="ant-stat-label">Holders</span><span class="ant-stat-val">${Number(holders).toLocaleString()}</span></div>` : ""}
      ${conf !== null ? `<div class="ant-stat"><span class="ant-stat-label">Confidence</span><span class="ant-stat-val">${conf}%</span></div>` : ""}
    </div>`

  const flagsHtml = (data.flags || [])
    .filter((f: any) => {
      const lbl = (f.label || f) as string
      return !lbl.toLowerCase().includes("unavailable") && f.severity !== "bonus"
    })
    .slice(0, 4)
    .map((f: any) => {
      const lbl = f.label || f
      return `<div class="ant-flag" style="border-left-color:${color}33">${lbl}</div>`
    }).join("")

  const dexLink = data.pair?.url
    ? `<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer" class="ant-link">&#8599; DexScreener</a>`
    : ""
  const analysisLink = `<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer" class="ant-link-primary" style="color:${color}">&#8599; Full Analysis</a>`

  return `
    <div class="ant-header">
      <span class="ant-logo" style="color:${color}">ANTARES</span>
      <span id="antares-close" class="ant-close">&times;</span>
    </div>
    <div class="ant-body">
      <div class="ant-verdict" style="color:${color}">${label}</div>
      <div class="ant-score-row">
        <span>Score <strong>${score}</strong> / 1000</span>
        ${mc ? `<span class="ant-mcap">${formatMcap(mc)}</span>` : ""}
      </div>
      <div class="ant-bar"><div class="ant-bar-f" data-w="${barWidth}" style="background:${color}"></div></div>
      ${statsHtml}
      ${flagsHtml ? `<div class="ant-flags">${flagsHtml}</div>` : ""}
    </div>
    <div class="ant-ca">${displayCA.slice(0,4)}&hellip;${displayCA.slice(-4)}</div>
    <div class="ant-footer">
      ${dexLink}
      ${analysisLink}
    </div>
  `
}

// ─── Box visibility ──────────────────────────────────────────────────────────

let hideTimeout: ReturnType<typeof setTimeout> | null = null

function hideBox() {
  const b = getBox()
  b.style.opacity = "0"
  b.style.transform = "translateY(10px)"
  if (hideTimeout) clearTimeout(hideTimeout)
  hideTimeout = setTimeout(() => { b.style.display = "none" }, 250)
}

function showBox(b: HTMLDivElement) {
  if (hideTimeout) clearTimeout(hideTimeout)
  b.style.display = "block"
  requestAnimationFrame(() => requestAnimationFrame(() => {
    b.style.opacity = "1"
    b.style.transform = "translateY(0)"
  }))
  // animate bar
  requestAnimationFrame(() => {
    const bar = b.querySelector(".ant-bar-f") as HTMLDivElement | null
    if (bar) setTimeout(() => { bar.style.width = (bar.dataset.w || "0") + "%" }, 120)
  })
}

function attachClose() {
  const btn = shadow!.getElementById("antares-close")
  if (btn) btn.onclick = () => { manuallyDismissed = true; hideBox() }
}

function applyVerdictBorder(b: HTMLDivElement, color: string) {
  b.style.border = `1px solid ${color}55`
  b.style.boxShadow = `0 8px 40px rgba(0,0,0,0.9), 0 0 24px ${color}14`
}

// ─── State ───────────────────────────────────────────────────────────────────

let lastCA = ""
let manuallyDismissed = false
let scanInFlight = false

function resetState() {
  lastCA = ""; manuallyDismissed = false; scanInFlight = false; hideBox()
}

// ─── Scan ────────────────────────────────────────────────────────────────────

async function scan(ca: string) {
  if (!ca) return
  const b = getBox()
  if (ca === lastCA && b.style.display !== "none") return
  if (manuallyDismissed && ca === lastCA) return
  if (scanInFlight) return
  if (ca !== lastCA) { manuallyDismissed = false; lastCA = ca }

  const cached = getCached(ca)
  if (cached) {
    applyVerdictBorder(b, COLORS[cached.risk] || "#6b7280")
    b.innerHTML = buildResult(cached, ca)
    showBox(b); attachClose(); return
  }

  scanInFlight = true
  b.style.border = "1px solid #1f1f22"
  b.style.boxShadow = "0 8px 40px rgba(0,0,0,0.9)"
  b.innerHTML = `
    <div class="ant-header">
      <span class="ant-logo" style="color:#444">ANTARES</span>
      <span id="antares-close" class="ant-close">&times;</span>
    </div>
    <div class="ant-scanning"><span class="ant-dot"></span>Scanning&hellip;</div>
  `
  showBox(b); attachClose()

  try {
    const res = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json()
    if (lastCA !== ca) { scanInFlight = false; return }
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    applyVerdictBorder(b, COLORS[data.risk] || "#6b7280")
    b.innerHTML = buildResult(data, ca)
    showBox(b); attachClose()
  } catch (_e) {
    if (lastCA !== ca) { scanInFlight = false; return }
    b.innerHTML = `
      <div class="ant-header">
        <span class="ant-logo" style="color:#444">ANTARES</span>
        <span id="antares-close" class="ant-close">&times;</span>
      </div>
      <div style="color:#ef4444;font-family:'IBM Plex Mono',monospace;font-size:12px;padding:12px 14px">API Error — retry later</div>
    `
    attachClose()
  }
  scanInFlight = false
}

// ─── Address detection ───────────────────────────────────────────────────────

function isValid(addr: string): boolean {
  if (addr.length < 32 || addr.length > 44) return false
  if (IGNORE.has(addr)) return false
  if (/^[A-Z]+$/.test(addr)) return false
  if (/^[0-9]+$/.test(addr)) return false
  return true
}

function findBestAddress(): string {
  if (window.location.hostname.includes("photon") && !window.location.pathname.includes("/lp/")) return ""
  const scores = new Map<string, number>()
  const url = window.location.href
  const add = (addr: string, pts: number) => { if (!isValid(addr)) return; scores.set(addr, (scores.get(addr) || 0) + pts) }

  for (const el of document.querySelectorAll("[data-address],[data-token],[data-mint],[data-ca],[data-contract],[data-token-address],[data-mint-address]")) {
    for (const attr of ["data-address","data-token","data-mint","data-ca","data-contract","data-token-address","data-mint-address"]) {
      for (const m of ((el.getAttribute(attr) || "").match(SOL_ADDR) || [])) add(m, 200)
    }
  }
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || ""
    if (/solscan\.io\/token|solscan\.io\/address|explorer\.solana\.com\/address|solana\.fm\/address/.test(href)) {
      for (const m of (href.match(SOL_ADDR) || [])) add(m, 180)
    }
  }
  for (const m of (url.match(SOL_ADDR) || [])) add(m, 60)
  if (scores.size === 0) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
    let node: Node | null, count = 0
    while ((node = walker.nextNode()) && count < WALKER_LIMIT) {
      count++
      const t = (node.textContent || "").trim()
      if (t.length >= 32 && t.length <= 50) { for (const m of (t.match(SOL_ADDR) || [])) add(m, 120) }
    }
  }
  if (scores.size === 0) return ""
  for (const [addr, s] of scores) {
    if (addr.endsWith("pump")) scores.set(addr, s + 100)
    if (/[A-Z]/.test(addr) && /[a-z]/.test(addr)) scores.set(addr, (scores.get(addr) || 0) + 30)
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

// ─── Poll / navigation ───────────────────────────────────────────────────────

function poll() { const ca = findBestAddress(); if (!ca) return; scan(ca) }

poll()
setTimeout(poll, 2000)

const onNav = () => { resetState(); setTimeout(poll, 400); setTimeout(poll, 2000) }

let lastUrl = window.location.href
new MutationObserver(() => {
  const cur = window.location.href
  if (cur !== lastUrl) { lastUrl = cur; onNav() }
}).observe(document.documentElement, { childList: true, subtree: true })

const _push = history.pushState.bind(history)
const _replace = history.replaceState.bind(history)
history.pushState    = (...args) => { _push(...args);    onNav() }
history.replaceState = (...args) => { _replace(...args); onNav() }
window.addEventListener("popstate", onNav)
