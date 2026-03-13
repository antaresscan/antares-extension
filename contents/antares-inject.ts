import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API = "https://antares-extension.vercel.app/api/scan"
const ANALYSIS_PAGE = "https://antares-extension.vercel.app/token.html"
const LS_PREFIX = "antares_scan_"

const RISK_COLORS: Record<string, string> = {
  SAFE:    "#00e5b0",
  CAUTION: "#f5d000",
  DANGER:  "#ff5f5f",
  RUG:     "#ff2244"
}
const RISK_RGBA: Record<string, string> = {
  SAFE:    "0,229,176",
  CAUTION: "245,208,0",
  DANGER:  "255,95,95",
  RUG:     "255,34,68"
}
const RISK_LABELS: Record<string, string> = {
  SAFE: "SAFE", CAUTION: "CAUTION", DANGER: "DANGER", RUG: "RUG PULL"
}

const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
const WALKER_LIMIT = 500
const CACHE_TTL = 90_000

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

function fmt(mc: number): string {
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`
  if (mc >= 1_000_000)     return `$${(mc / 1_000_000).toFixed(2)}M`
  if (mc >= 1_000)         return `$${(mc / 1_000).toFixed(1)}K`
  return `$${mc.toFixed(0)}`
}

// ─── STYLES ────────────────────────────────────────────────────────────────
// Exact copy of demo-brutal-v3-floating-box CSS, scoped under #antares-box
function injectStyles() {
  if (document.getElementById("_ant_styles")) return
  const s = document.createElement("style")
  s.id = "_ant_styles"
  s.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap');

#antares-box {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  width: 280px;
  background: #141417;
  border: 1px solid #1f1f22;
  padding: 0;
  overflow: hidden;
  display: none;
  opacity: 0;
  transform: translateY(18px);
  transition: opacity .25s, transform .25s, border-color .25s, box-shadow .25s;
  font-family: 'IBM Plex Mono', ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 13px;
  color: #d8d8d8;
  animation: none;
}
#antares-box.visible {
  animation: _ant_appear .45s cubic-bezier(.22,1,.36,1) both;
}
@keyframes _ant_appear {
  from { opacity: 0; transform: translateY(18px); }
  to   { opacity: 1; transform: translateY(0); }
}

#antares-box .bline {
  position: absolute; top: 0; left: 0; right: 0; height: 3px; z-index: 2;
}
#antares-box .inner { padding: 16px; }
#antares-box .head {
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;
}
#antares-box .brand {
  font-size: 9px; letter-spacing: .3em; color: #3a3a3f; text-transform: uppercase;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
}
#antares-box .x {
  color: #2e2e33; cursor: pointer; font-size: 16px; line-height: 1;
  transition: color .15s, transform .15s;
}
#antares-box .x:hover { color: #d8d8d8; transform: rotate(90deg); }

#antares-box .risk {
  font-family: 'Bebas Neue', 'Arial Black', Impact, sans-serif;
  font-weight: 400; font-size: 36px; line-height: 1;
  letter-spacing: .04em; margin-bottom: 5px;
}

#antares-box .score-row {
  display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px;
}
#antares-box .score { font-size: 11px; color: #4a4a50; }
#antares-box .score strong { color: #aaa; }
#antares-box .mcap { font-size: 11px; color: #383840; }

#antares-box .bar {
  height: 3px; background: #1c1c1f; margin-bottom: 14px; overflow: hidden;
}
#antares-box .bar-f {
  height: 100%; width: 0%;
  transition: width 1.1s cubic-bezier(.22,1,.36,1);
}

#antares-box .meta {
  display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 12px;
}
#antares-box .meta div {
  padding: 7px 9px; background: #111114; border: 1px solid #1c1c1f; border-radius: 2px;
}
#antares-box .meta span {
  display: block; font-size: 9px; color: #3a3a3f;
  letter-spacing: .1em; text-transform: uppercase; margin-bottom: 2px;
}
#antares-box .meta strong { font-size: 12px; color: #bbb; }

#antares-box .flags-wrap { margin-bottom: 12px; }
#antares-box .flag {
  font-size: 11px; color: #505058;
  padding: 4px 0 4px 10px; border-left: 2px solid;
  margin-top: 3px;
  transition: color .15s, padding-left .15s;
}
#antares-box .flag:hover { color: #bbb; padding-left: 14px; }

#antares-box .toggle {
  display: block; width: 100%; padding: 8px 16px;
  background: transparent; border: none; border-top: 1px solid #1c1c1f;
  font: 600 9px/1 'IBM Plex Mono', ui-monospace, monospace;
  letter-spacing: .2em; color: #383840; text-transform: uppercase;
  cursor: pointer; transition: color .15s, background .15s; text-align: left;
}
#antares-box .toggle:hover { color: #bbb; background: #111114; }

#antares-box .extra { display: none; padding: 2px 16px 12px; }
#antares-box .extra.open {
  display: block;
  animation: _ant_fadeIn .2s ease;
}
@keyframes _ant_fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: none; }
}
#antares-box .extra-row {
  display: flex; justify-content: space-between;
  font-size: 10px; color: #3a3a3f;
  padding: 4px 0; border-bottom: 1px solid #171719;
}
#antares-box .extra-row span:last-child { color: #777; }

#antares-box .actions {
  display: flex; gap: 10px; padding: 10px 16px;
  border-top: 1px solid #1c1c1f; background: #111114;
}
#antares-box .actions a {
  font-size: 10px; color: #3a3a3f; text-decoration: none;
  letter-spacing: .05em; text-transform: uppercase; transition: color .15s;
}
#antares-box .actions a:hover { color: #d8d8d8; }

#antares-box .scanning {
  display: flex; align-items: center; gap: 8px;
  color: #4a4a50; font-size: 12px; padding: 4px 0;
}
#antares-box .scanning .dot {
  width: 7px; height: 7px; border-radius: 50%; background: #3a3a3f;
  display: inline-block;
  animation: _ant_pulse 1.2s infinite;
}
@keyframes _ant_pulse  { 0%,100%{opacity:1} 50%{opacity:.15} }
@keyframes _ant_rugline { 0%,100%{opacity:1} 50%{opacity:.4} }
`
  ;(document.head || document.documentElement).appendChild(s)
}

// ─── HTML BUILDER ──────────────────────────────────────────────────────────
function buildResult(data: any, ca: string): string {
  const color  = RISK_COLORS[data.risk] || "#6b7280"
  const rgba   = RISK_RGBA[data.risk]   || "107,114,128"
  const label  = RISK_LABELS[data.risk] || data.risk
  const mint   = data.resolvedMint || ca

  const mc      = data.pair?.marketCap || data.pair?.fdv
  const liq     = data.pair?.liquidity?.usd
  const holders = data.pair?.holders
  const conf    = typeof data.confidence === "number" ? data.confidence : null
  const barW    = Math.min((data.score || 0) / 10, 100)

  const metaCells = [
    mc      ? `<div><span>Market Cap</span><strong>${fmt(mc)}</strong></div>` : "",
    liq     ? `<div><span>Liquidity</span><strong>${fmt(liq)}</strong></div>` : "",
    holders ? `<div><span>Holders</span><strong>${(holders as number).toLocaleString()}</strong></div>` : "",
    conf !== null ? `<div><span>Confidence</span><strong>${conf}%</strong></div>` : "",
  ].filter(Boolean).join("")

  const flags = (data.flags as any[] || [])
    .filter(f => {
      const lbl = (f.label || f) as string
      return !lbl.toLowerCase().includes("unavailable") && f.severity !== "bonus"
    })
    .slice(0, 4)
    .map(f => `<div class="flag" style="border-color:rgba(${rgba},.22)">${f.label || f}</div>`)
    .join("")

  const srcRows = (data.sources_used as string[] || ["DexScreener","RugCheck","GoPlus","Helius RPC"])
    .map(s => `<div class="extra-row"><span>${s}</span><span>\u2713 Used</span></div>`)
    .join("")

  const dexLink = data.pair?.url
    ? `<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer">\u2197 DexScreener</a>`
    : ""
  const fullLink = `<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer">\u2197 Full Analysis</a>`

  const isRug = data.risk === "RUG"
  const blineStyle = isRug
    ? `background:${color};animation:_ant_rugline 2s ease infinite`
    : `background:${color}`

  return `
<div class="bline" style="${blineStyle}"></div>
<div class="inner">
  <div class="head">
    <span class="brand">ANTARES</span>
    <span class="x" id="_ant_close">\u00d7</span>
  </div>
  <div class="risk" style="color:${color}">${label}</div>
  <div class="score-row">
    <span class="score">Score <strong>${data.score}</strong> / 1000</span>
    <span class="mcap">${mc ? fmt(mc) : ""}</span>
  </div>
  <div class="bar"><div class="bar-f" style="background:${color};width:${barW}%"></div></div>
  ${metaCells ? `<div class="meta">${metaCells}</div>` : ""}
  ${flags     ? `<div class="flags-wrap">${flags}</div>` : ""}
</div>
<button class="toggle" id="_ant_toggle">\u25b8 Source details</button>
<div class="extra" id="_ant_extra">${srcRows}</div>
<div class="actions">${dexLink}${fullLink}</div>
`
}

// ─── UTILITY ───────────────────────────────────────────────────────────────
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
  const add = (addr: string, pts: number) => {
    if (!isValid(addr)) return
    scores.set(addr, (scores.get(addr) || 0) + pts)
  }

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
      if (t.length >= 32 && t.length <= 50) for (const m of (t.match(SOL_ADDR) || [])) add(m, 120)
    }
  }
  if (scores.size === 0) return ""
  for (const [addr, s] of scores) {
    if (addr.endsWith("pump")) scores.set(addr, s + 100)
    if (/[A-Z]/.test(addr) && /[a-z]/.test(addr)) scores.set(addr, (scores.get(addr) || 0) + 30)
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

// ─── BOX LIFECYCLE ─────────────────────────────────────────────────────────
let lastCA = ""
let box: HTMLDivElement | null = null
let hideTO: ReturnType<typeof setTimeout> | null = null
let dismissed = false
let inFlight  = false

function hideBox() {
  if (!box) return
  box.style.opacity = "0"
  box.style.transform = "translateY(18px)"
  if (hideTO) clearTimeout(hideTO)
  hideTO = setTimeout(() => { if (box) box.style.display = "none" }, 250)
}

function resetState() { lastCA = ""; dismissed = false; inFlight = false; hideBox() }

function ensureBox(): HTMLDivElement {
  injectStyles()
  if (box && document.body.contains(box)) return box
  box = document.createElement("div")
  box.id = "antares-box"
  document.body.appendChild(box)
  return box
}

function showBox(el: HTMLDivElement) {
  if (hideTO) clearTimeout(hideTO)
  el.style.display = "block"
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.opacity = "1"
    el.style.transform = "translateY(0)"
  }))
}

function wire() {
  const close  = document.getElementById("_ant_close")
  const toggle = document.getElementById("_ant_toggle")
  const extra  = document.getElementById("_ant_extra")
  if (close)  close.onclick  = () => { dismissed = true; hideBox() }
  if (toggle && extra) {
    toggle.onclick = () => {
      const open = extra.classList.toggle("open")
      toggle.textContent = open ? "\u25be Source details" : "\u25b8 Source details"
    }
  }
}

function applyRisk(el: HTMLDivElement, risk: string) {
  const rgba = RISK_RGBA[risk] || "107,114,128"
  el.style.borderColor = risk === "RUG" ? "#2a1519" : "#1f1f22"
  el.style.boxShadow   = `0 6px 30px rgba(${rgba},.04)`
}

// ─── SCAN ──────────────────────────────────────────────────────────────────
async function scan(ca: string) {
  if (!ca) return
  if (ca === lastCA && box && box.style.display !== "none") return
  if (dismissed && ca === lastCA) return
  if (inFlight) return
  if (ca !== lastCA) { dismissed = false; lastCA = ca }

  const cached = getCached(ca)
  if (cached) {
    const el = ensureBox()
    applyRisk(el, cached.risk)
    el.innerHTML = buildResult(cached, ca)
    showBox(el); wire(); return
  }

  inFlight = true
  const el = ensureBox()
  el.style.borderColor = "#1f1f22"
  el.style.boxShadow   = "0 6px 30px rgba(0,0,0,.5)"
  el.innerHTML = `
<div class="bline" style="background:#3a3a3f"></div>
<div class="inner">
  <div class="head">
    <span class="brand">ANTARES</span>
    <span class="x" id="_ant_close">\u00d7</span>
  </div>
  <div class="scanning"><span class="dot"></span>Scanning\u2026</div>
</div>`
  showBox(el)
  ;(document.getElementById("_ant_close") as HTMLElement).onclick = () => { dismissed = true; hideBox() }

  try {
    const res  = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error(String(res.status))
    const data = await res.json()
    if (lastCA !== ca) { inFlight = false; return }
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    applyRisk(el, data.risk)
    el.innerHTML = buildResult(data, ca)
    wire()
  } catch {
    if (lastCA !== ca) { inFlight = false; return }
    el.innerHTML = `
<div class="bline" style="background:#ff5f5f"></div>
<div class="inner">
  <div class="head">
    <span class="brand">ANTARES</span>
    <span class="x" id="_ant_close">\u00d7</span>
  </div>
  <div style="color:#ff5f5f;font-size:12px;padding:4px 0">API Error \u2014 retry later</div>
</div>`
    ;(document.getElementById("_ant_close") as HTMLElement).onclick = () => { dismissed = true; hideBox() }
  }
  inFlight = false
}

// ─── POLLING & NAVIGATION ──────────────────────────────────────────────────
function poll() { const ca = findBestAddress(); if (ca) scan(ca) }

poll()
setTimeout(poll, 2000)

const onNav = () => { resetState(); setTimeout(poll, 400); setTimeout(poll, 2000) }

let lastUrl = location.href
new MutationObserver(() => {
  if (location.href !== lastUrl) { lastUrl = location.href; onNav() }
}).observe(document.documentElement, { childList: true, subtree: true })

const _push    = history.pushState.bind(history)
const _replace = history.replaceState.bind(history)
history.pushState    = (...a) => { _push(...a);    onNav() }
history.replaceState = (...a) => { _replace(...a); onNav() }
window.addEventListener("popstate", onNav)
