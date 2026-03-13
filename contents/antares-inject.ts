import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API = "https://antares-extension.vercel.app/api/scan"
const ANALYSIS_PAGE = "https://antares-extension.vercel.app/token.html"
const LS_PREFIX = "antares_scan_"

const COLORS: Record<string, string> = {
  SAFE: "#22c55e",
  CAUTION: "#f97316",
  DANGER: "#ef4444",
  RUG: "#dc2626"
}

const LABELS: Record<string, string> = {
  SAFE: "SAFE",
  CAUTION: "CAUTION",
  DANGER: "DANGER",
  RUG: "RUG PULL"
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
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(2)}M`
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(1)}K`
  return `$${mc.toFixed(0)}`
}

function injectStyles() {
  if (document.getElementById("antares-styles")) return
  const style = document.createElement("style")
  style.id = "antares-styles"
  style.textContent = `
    #antares-box {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      background: #0a0a0a;
      border-radius: 12px;
      padding: 14px 16px;
      font-family: 'SF Mono','Fira Code','Fira Mono',monospace;
      font-size: 13px;
      color: #fff;
      min-width: 230px;
      max-width: 300px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.9);
      display: none;
      transition: opacity 0.22s ease, transform 0.22s ease;
      opacity: 0;
      transform: translateY(10px);
    }
    .ant-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid #1a1a1a;
    }
    .ant-logo {
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 3px;
      text-transform: uppercase;
    }
    .ant-close {
      cursor: pointer;
      color: #444;
      font-size: 18px;
      line-height: 1;
      transition: color 0.15s;
    }
    .ant-close:hover { color: #888; }
    .ant-verdict {
      font-size: 22px;
      font-weight: 900;
      letter-spacing: 1.5px;
      margin-bottom: 6px;
      text-transform: uppercase;
    }
    .ant-score-row {
      display: flex;
      align-items: baseline;
      gap: 4px;
      margin-bottom: 8px;
    }
    .ant-score-val {
      font-size: 28px;
      font-weight: 800;
      line-height: 1;
    }
    .ant-score-max {
      font-size: 12px;
      color: #333;
    }
    .ant-score-label {
      font-size: 10px;
      color: #555;
      margin-left: auto;
    }
    .ant-stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 10px;
      margin-bottom: 8px;
    }
    .ant-stat {
      display: flex;
      flex-direction: column;
    }
    .ant-stat-label {
      font-size: 9px;
      color: #444;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ant-stat-val {
      font-size: 12px;
      color: #ccc;
      font-weight: 700;
    }
    .ant-conf-bar {
      width: 100%;
      height: 2px;
      background: #1a1a1a;
      border-radius: 1px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .ant-conf-fill {
      height: 100%;
      border-radius: 1px;
      transition: width 0.6s ease;
    }
    .ant-flags {
      margin-bottom: 8px;
    }
    .ant-flag {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 11px;
      color: #666;
      margin-bottom: 3px;
      padding-left: 6px;
      border-left-width: 2px;
      border-left-style: solid;
    }
    .ant-flag-icon { flex-shrink: 0; font-size: 10px; }
    .ant-sep {
      height: 1px;
      background: #111;
      margin-bottom: 8px;
    }
    .ant-footer {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .ant-link {
      font-size: 10px;
      text-decoration: none;
      color: #444;
      transition: color 0.15s;
    }
    .ant-link:hover { color: #888; }
    .ant-link-primary {
      font-size: 10px;
      text-decoration: none;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-left: auto;
      transition: opacity 0.15s;
    }
    .ant-link-primary:hover { opacity: 0.75; }
    .ant-ca {
      font-size: 9px;
      color: #2a2a2a;
      margin-bottom: 6px;
      font-family: monospace;
    }
    @keyframes ant-pulse { 0%,100%{opacity:1} 50%{opacity:.15} }
    .ant-scanning {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #555;
      font-size: 12px;
      padding: 4px 0;
    }
    .ant-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #555;
      display: inline-block;
      animation: ant-pulse 1.2s infinite;
    }
  `
  document.head?.appendChild(style)
}

function buildResult(data: any, ca: string): string {
  const color = COLORS[data.risk] || "#6b7280"
  const label = LABELS[data.risk] || data.risk
  const displayCA = data.resolvedMint || ca
  const mint = data.resolvedMint || ca

  const mc = data.pair?.marketCap || data.pair?.fdv
  const liq = data.pair?.liquidity?.usd
  const holders = data.pair?.holders
  const conf = typeof data.confidence === "number" ? data.confidence : null

  const statsHtml = (mc || liq || holders) ? `
    <div class="ant-stats">
      ${mc ? `<div class="ant-stat"><span class="ant-stat-label">Market Cap</span><span class="ant-stat-val">${formatMcap(mc)}</span></div>` : ""}
      ${liq ? `<div class="ant-stat"><span class="ant-stat-label">Liquidity</span><span class="ant-stat-val">${formatMcap(liq)}</span></div>` : ""}
      ${holders ? `<div class="ant-stat"><span class="ant-stat-label">Holders</span><span class="ant-stat-val">${holders.toLocaleString()}</span></div>` : ""}
      ${conf !== null ? `<div class="ant-stat"><span class="ant-stat-label">Confidence</span><span class="ant-stat-val" style="color:${color}">${conf}%</span></div>` : ""}
    </div>` : ""

  const confBarHtml = conf !== null ? `
    <div class="ant-conf-bar">
      <div class="ant-conf-fill" style="width:${conf}%;background:${color}"></div>
    </div>` : ""

  const flagsHtml = (data.flags || [])
    .filter((f: any) => {
      const lbl = (f.label || f) as string
      return !lbl.toLowerCase().includes("unavailable") && f.severity !== "bonus"
    })
    .slice(0, 4)
    .map((f: any) => {
      const lbl = f.label || f
      const isGood = f.severity === "info" || lbl.startsWith("✓") || lbl.startsWith("LP")
      const icon = isGood ? "✓" : "⚠"
      const iconColor = isGood ? color : "#ef4444"
      return `<div class="ant-flag" style="border-left-color:${color}22"><span class="ant-flag-icon" style="color:${iconColor}">${icon}</span><span>${lbl}</span></div>`
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
    <div class="ant-verdict" style="color:${color}">${label}</div>
    <div class="ant-score-row">
      <span class="ant-score-val" style="color:${color}">${data.score}</span>
      <span class="ant-score-max">/1000</span>
      <span class="ant-score-label">Score</span>
    </div>
    ${statsHtml}
    ${confBarHtml}
    ${flagsHtml ? `<div class="ant-flags">${flagsHtml}</div>` : ""}
    <div class="ant-ca">${displayCA.slice(0,4)}&hellip;${displayCA.slice(-4)}</div>
    <div class="ant-sep"></div>
    <div class="ant-footer">
      ${dexLink}
      ${analysisLink}
    </div>
  `
}

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

let lastCA = ""
let box: HTMLDivElement | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null
let manuallyDismissed = false
let scanInFlight = false

function hideBox() {
  if (!box) return
  box.style.opacity = "0"
  box.style.transform = "translateY(10px)"
  if (hideTimeout) clearTimeout(hideTimeout)
  hideTimeout = setTimeout(() => { if (box) box.style.display = "none" }, 250)
}

function resetState() {
  lastCA = ""; manuallyDismissed = false; scanInFlight = false; hideBox()
}

function ensureBox(): HTMLDivElement {
  injectStyles()
  if (box && document.body.contains(box)) return box
  box = document.createElement("div")
  box.id = "antares-box"
  document.body.appendChild(box)
  return box
}

function showBox(el: HTMLDivElement) {
  if (hideTimeout) clearTimeout(hideTimeout)
  el.style.display = "block"
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.opacity = "1"
    el.style.transform = "translateY(0)"
  }))
}

function attachClose() {
  const btn = document.getElementById("antares-close")
  if (btn) btn.onclick = () => { manuallyDismissed = true; hideBox() }
}

function applyVerdictBorder(el: HTMLDivElement, color: string) {
  el.style.border = `1px solid ${color}55`
  el.style.boxShadow = `0 8px 40px rgba(0,0,0,0.9), 0 0 24px ${color}14`
}

async function scan(ca: string) {
  if (!ca) return
  if (ca === lastCA && box && box.style.display !== "none") return
  if (manuallyDismissed && ca === lastCA) return
  if (scanInFlight) return
  if (ca !== lastCA) { manuallyDismissed = false; lastCA = ca }

  const cached = getCached(ca)
  if (cached) {
    const el = ensureBox()
    applyVerdictBorder(el, COLORS[cached.risk] || "#6b7280")
    el.innerHTML = buildResult(cached, ca)
    showBox(el); attachClose(); return
  }

  scanInFlight = true
  const el = ensureBox()
  el.style.border = "1px solid #1f1f1f"
  el.style.boxShadow = "0 8px 40px rgba(0,0,0,0.9)"
  el.innerHTML = `
    <div class="ant-header">
      <span class="ant-logo" style="color:#444">ANTARES</span>
      <span id="antares-close" class="ant-close">&times;</span>
    </div>
    <div class="ant-ca">${ca.slice(0,4)}&hellip;${ca.slice(-4)}</div>
    <div class="ant-scanning">
      <span class="ant-dot"></span>Scanning&hellip;
    </div>
  `
  showBox(el); attachClose()

  try {
    const res = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json()
    if (lastCA !== ca) { scanInFlight = false; return }
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    applyVerdictBorder(el, COLORS[data.risk] || "#6b7280")
    el.innerHTML = buildResult(data, ca)
    attachClose()
  } catch (e) {
    if (lastCA !== ca) { scanInFlight = false; return }
    el.innerHTML = `
      <div class="ant-header">
        <span class="ant-logo" style="color:#444">ANTARES</span>
        <span id="antares-close" class="ant-close">&times;</span>
      </div>
      <div style="color:#ef4444;font-size:12px;padding:4px 0">API Error — retry later</div>
    `
    attachClose()
  }
  scanInFlight = false
}

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
history.pushState = (...args) => { _push(...args); onNav() }
history.replaceState = (...args) => { _replace(...args); onNav() }
window.addEventListener("popstate", onNav)
