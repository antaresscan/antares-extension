import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API           = "https://antares-extension.vercel.app/api/scan"
const ANALYSIS_PAGE = "https://antares-extension.vercel.app/token.html"
const LS_PREFIX     = "antares_scan_"
const CACHE_TTL     = 90_000

const COLORS: Record<string, { main: string; rgba: string }> = {
  SAFE:    { main: "#00e5b0", rgba: "0,229,176" },
  CAUTION: { main: "#f5d000", rgba: "245,208,0" },
  DANGER:  { main: "#ff5f5f", rgba: "255,95,95" },
  RUG:     { main: "#ff2244", rgba: "255,34,68" }
}

const LABELS: Record<string, string> = {
  SAFE: "SAFE", CAUTION: "CAUTION", DANGER: "DANGER", RUG: "RUG PULL"
}

const SOL_ADDR     = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
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

function isValid(addr: string): boolean {
  if (addr.length < 32 || addr.length > 44) return false
  if (IGNORE.has(addr)) return false
  if (/^[A-Z]+$/.test(addr)) return false
  if (/^[0-9]+$/.test(addr)) return false
  return true
}

// ── CSS complet de la démo overlay-1 ───────────────────────────────────────────────────────
const SHADOW_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:host {
  all: initial;
  display: block;
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  width: 280px;
  pointer-events: none;
  font-family: 'IBM Plex Mono', monospace;
}

#box {
  pointer-events: auto;
  width: 280px;
  background: #141417;
  border: 1px solid #1f1f22;
  overflow: hidden;
  position: relative;
  display: none;
  opacity: 0;
  transform: translateY(18px);
  transition: opacity .25s ease, transform .25s ease, border-color .25s, box-shadow .25s;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 13px;
  color: #d8d8d8;
  line-height: 1.4;
}

/* ── barre couleur top ── */
.bline {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 3px;
  z-index: 2;
}

/* ── inner padding ── */
.inner { padding: 16px; }

/* ── header ── */
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.brand {
  font-size: 9px;
  letter-spacing: .3em;
  color: #3a3a3f;
  text-transform: uppercase;
  font-family: 'IBM Plex Mono', monospace;
}
.x {
  color: #2e2e33;
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  transition: color .15s, transform .15s;
  user-select: none;
}
.x:hover { color: #d8d8d8; transform: rotate(90deg); }

/* ── verdict ── */
.risk {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 36px;
  font-weight: 400;
  line-height: 1;
  letter-spacing: .04em;
  margin-bottom: 5px;
}

/* ── score row ── */
.score-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 10px;
}
.score {
  font-size: 11px;
  color: #4a4a50;
  font-family: 'IBM Plex Mono', monospace;
}
.score strong { color: #aaa; font-weight: 600; }
.mcap {
  font-size: 11px;
  color: #383840;
  font-family: 'IBM Plex Mono', monospace;
}

/* ── barre score ── */
.bar {
  height: 3px;
  background: #1c1c1f;
  margin-bottom: 14px;
  overflow: hidden;
}
.bar-f {
  height: 100%;
  width: 0%;
  transition: width 1.1s cubic-bezier(.22,1,.36,1);
}

/* ── meta grid ── */
.meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
  margin-bottom: 12px;
}
.meta div {
  padding: 7px 9px;
  background: #111114;
  border: 1px solid #1c1c1f;
  border-radius: 2px;
}
.meta span {
  display: block;
  font-size: 9px;
  color: #3a3a3f;
  letter-spacing: .1em;
  text-transform: uppercase;
  margin-bottom: 2px;
  font-family: 'IBM Plex Mono', monospace;
}
.meta strong {
  display: block;
  font-size: 12px;
  color: #bbb;
  font-weight: 600;
  font-family: 'IBM Plex Mono', monospace;
}

/* ── flags ── */
.flags-wrap { margin-bottom: 12px; }
.flag {
  font-size: 11px;
  color: #505058;
  padding: 4px 0 4px 10px;
  border-left: 2px solid;
  margin-top: 3px;
  font-family: 'IBM Plex Mono', monospace;
  transition: color .15s, padding-left .15s;
}
.flag:hover { color: #bbb; padding-left: 14px; }

/* ── source details ── */
.toggle {
  display: block;
  width: 100%;
  padding: 8px 16px;
  background: transparent;
  border: none;
  border-top: 1px solid #1c1c1f;
  font-size: 9px;
  font-weight: 600;
  font-family: 'IBM Plex Mono', monospace;
  letter-spacing: .2em;
  color: #383840;
  text-transform: uppercase;
  cursor: pointer;
  text-align: left;
  transition: color .15s, background .15s;
}
.toggle:hover { color: #bbb; background: #111114; }
.extra { display: none; padding: 2px 16px 12px; }
.extra.open { display: block; }
.extra-row {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #3a3a3f;
  padding: 4px 0;
  border-bottom: 1px solid #171719;
  font-family: 'IBM Plex Mono', monospace;
}
.extra-row span:last-child { color: #777; }

/* ── actions footer ── */
.actions {
  display: flex;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid #1c1c1f;
  background: #111114;
}
.actions a {
  font-size: 10px;
  color: #3a3a3f;
  text-decoration: none;
  letter-spacing: .05em;
  text-transform: uppercase;
  font-family: 'IBM Plex Mono', monospace;
  transition: color .15s;
}
.actions a:hover { color: #d8d8d8; }
.actions a.primary { margin-left: auto; font-weight: 700; }

/* ── scanning ── */
@keyframes ant-pulse { 0%,100%{opacity:1} 50%{opacity:.15} }
@keyframes ant-rugline { 0%,100%{opacity:1} 50%{opacity:.4} }
.scanning {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #4a4a50;
  font-size: 12px;
  padding: 4px 0;
  font-family: 'IBM Plex Mono', monospace;
}
.dot {
  display: inline-block;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #3a3a3f;
  animation: ant-pulse 1.2s infinite;
}
`

// ── Shadow DOM ─────────────────────────────────────────────────────────────────────────

let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let innerBox: HTMLDivElement | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null
let lastCA            = ""
let manuallyDismissed = false
let scanInFlight      = false

function createHost() {
  document.getElementById("antares-host")?.remove()
  host = document.createElement("div")
  host.id = "antares-host"
  document.documentElement.appendChild(host)
  shadow = host.attachShadow({ mode: "open" })
  const styleEl = document.createElement("style")
  styleEl.textContent = SHADOW_CSS
  shadow.appendChild(styleEl)
  innerBox = document.createElement("div")
  innerBox.id = "box"
  shadow.appendChild(innerBox)
}

new MutationObserver(() => {
  if (!host || !document.documentElement.contains(host)) createHost()
}).observe(document.documentElement, { childList: true, subtree: false })

function getBox(): HTMLDivElement {
  if (!host || !document.documentElement.contains(host)) createHost()
  return innerBox!
}

function hideBox() {
  if (!innerBox) return
  innerBox.style.opacity   = "0"
  innerBox.style.transform = "translateY(18px)"
  if (hideTimeout) clearTimeout(hideTimeout)
  hideTimeout = setTimeout(() => { if (innerBox) innerBox.style.display = "none" }, 250)
}

function showBox() {
  if (!host || !document.documentElement.contains(host)) createHost()
  const el = innerBox!
  if (hideTimeout) clearTimeout(hideTimeout)
  el.style.display = "block"
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.opacity   = "1"
    el.style.transform = "translateY(0)"
  }))
}

function resetState() { lastCA = ""; manuallyDismissed = false; scanInFlight = false; hideBox() }

function attachClose() {
  shadow?.getElementById("ant-close")?.addEventListener("click", () => { manuallyDismissed = true; hideBox() }, { once: true })
}

function attachToggle() {
  const btn   = shadow?.getElementById("ant-toggle")
  const extra = shadow?.getElementById("ant-extra")
  if (btn && extra) btn.addEventListener("click", () => {
    const open = extra.classList.toggle("open")
    btn.textContent = (open ? "\u25BE " : "\u25B8 ") + "Source details"
  }, { once: true })
}

function applyRiskBorder(risk: string) {
  if (!innerBox) return
  const c = COLORS[risk] || { main: "#6b7280", rgba: "107,114,128" }
  innerBox.style.borderColor = risk === "RUG" ? "#2a1519" : `rgba(${c.rgba},.35)`
  innerBox.style.boxShadow   = `0 6px 30px rgba(${c.rgba},.06)`
}

// ── HTML builder ─────────────────────────────────────────────────────────────────────
function buildResult(data: any, ca: string): string {
  const c       = COLORS[data.risk] || { main: "#6b7280", rgba: "107,114,128" }
  const label   = LABELS[data.risk] || data.risk
  const mint    = data.resolvedMint || ca
  const mc      = data.pair?.marketCap || data.pair?.fdv
  const liq     = data.pair?.liquidity?.usd
  const holders = data.pair?.holders
  const conf    = typeof data.confidence === "number" ? data.confidence : null
  const barW    = Math.round((data.score || 0) / 10)

  const metaCells = [
    mc      ? `<div><span>Market Cap</span><strong>${formatMcap(mc)}</strong></div>` : "",
    liq     ? `<div><span>Liquidity</span><strong>${formatMcap(liq)}</strong></div>` : "",
    holders ? `<div><span>Holders</span><strong>${Number(holders).toLocaleString()}</strong></div>` : "",
    conf !== null ? `<div><span>Confidence</span><strong>${conf}%</strong></div>` : "",
  ].filter(Boolean).join("")

  const flags = (data.flags || [])
    .filter((f: any) => { const l = (f.label || f) as string; return !l.toLowerCase().includes("unavailable") && f.severity !== "bonus" })
    .slice(0, 4)
    .map((f: any) => `<div class="flag" style="border-color:rgba(${c.rgba},.2)">${f.label || f}</div>`)
    .join("")

  const sourceRows = (data.sources_used || ["DexScreener", "RugCheck", "GoPlus", "Helius RPC"])
    .map((s: string) => `<div class="extra-row"><span>${s}</span><span>&#10003; Used</span></div>`).join("")

  const dexLink      = data.pair?.url ? `<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer">&#8599; DexScreener</a>` : ""
  const analysisLink = `<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer" class="primary">&#8599; Full Analysis</a>`
  const blineStyle   = data.risk === "RUG" ? `background:${c.main};animation:ant-rugline 2s ease infinite` : `background:${c.main}`

  return `
    <div class="bline" style="${blineStyle}"></div>
    <div class="inner">
      <div class="head"><span class="brand">ANTARES</span><span class="x" id="ant-close">&times;</span></div>
      <div class="risk" style="color:${c.main}">${label}</div>
      <div class="score-row">
        <span class="score">Score <strong>${data.score}</strong> / 1000</span>
        ${mc ? `<span class="mcap">${formatMcap(mc)}</span>` : ""}
      </div>
      <div class="bar"><div class="bar-f" style="background:${c.main};width:${barW}%"></div></div>
      ${metaCells ? `<div class="meta">${metaCells}</div>` : ""}
      ${flags ? `<div class="flags-wrap">${flags}</div>` : ""}
    </div>
    <button class="toggle" id="ant-toggle">&#9658; Source details</button>
    <div class="extra" id="ant-extra">${sourceRows}</div>
    <div class="actions">${dexLink}${analysisLink}</div>
  `
}

// ── scan ─────────────────────────────────────────────────────────────────────────────
async function scan(ca: string) {
  if (!ca) return
  const el = getBox()
  if (ca === lastCA && el.style.display !== "none") return
  if (manuallyDismissed && ca === lastCA) return
  if (scanInFlight) return
  if (ca !== lastCA) { manuallyDismissed = false; lastCA = ca }

  const cached = getCached(ca)
  if (cached) {
    applyRiskBorder(cached.risk)
    el.innerHTML = buildResult(cached, ca)
    showBox(); attachClose(); attachToggle(); return
  }

  scanInFlight = true
  el.style.borderColor = "#1f1f22"
  el.style.boxShadow   = "none"
  el.innerHTML = `
    <div class="bline" style="background:#3a3a3f"></div>
    <div class="inner">
      <div class="head"><span class="brand">ANTARES</span><span class="x" id="ant-close">&times;</span></div>
      <div class="scanning"><span class="dot"></span>Scanning&hellip;</div>
    </div>
  `
  showBox(); attachClose()

  try {
    const res  = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json()
    if (lastCA !== ca) { scanInFlight = false; return }
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    applyRiskBorder(data.risk)
    el.innerHTML = buildResult(data, ca)
    showBox(); attachClose(); attachToggle()
  } catch (_e) {
    if (lastCA !== ca) { scanInFlight = false; return }
    el.innerHTML = `
      <div class="bline" style="background:#ff5f5f"></div>
      <div class="inner">
        <div class="head"><span class="brand">ANTARES</span><span class="x" id="ant-close">&times;</span></div>
        <div style="color:#ff5f5f;font-size:12px;padding:4px 0;font-family:'IBM Plex Mono',monospace">API Error &mdash; retry later</div>
      </div>
    `
    showBox(); attachClose()
  }
  scanInFlight = false
}

// ── address detection ─────────────────────────────────────────────────────────────────
function findBestAddress(): string {
  if (window.location.hostname.includes("photon") && !window.location.pathname.includes("/lp/")) return ""
  const scores = new Map<string, number>()
  const url    = window.location.href
  const add    = (addr: string, pts: number) => { if (!isValid(addr)) return; scores.set(addr, (scores.get(addr) || 0) + pts) }
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

// ── init ────────────────────────────────────────────────────────────────────────────────
createHost()

function poll() { const ca = findBestAddress(); if (!ca) return; scan(ca) }
poll()
setTimeout(poll, 2000)

const onNav = () => { resetState(); setTimeout(poll, 400); setTimeout(poll, 2000) }

let lastUrl = window.location.href
new MutationObserver(() => {
  const cur = window.location.href
  if (cur !== lastUrl) { lastUrl = cur; onNav() }
}).observe(document.documentElement, { childList: true, subtree: true })

const _push    = history.pushState.bind(history)
const _replace = history.replaceState.bind(history)
history.pushState    = (...args) => { _push(...args);    onNav() }
history.replaceState = (...args) => { _replace(...args); onNav() }
window.addEventListener("popstate", onNav)
