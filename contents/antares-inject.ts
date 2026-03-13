import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API = "https://antares-extension.vercel.app/api/scan"
const ANALYSIS_PAGE = "https://antares-extension.vercel.app/token.html"
const LS_PREFIX = "antares_scan_"

const COLORS: Record<string, string> = {
  SAFE:    "#00e5b0",
  CAUTION: "#f5d000",
  DANGER:  "#ff5f5f",
  RUG:     "#ff2244"
}

const LABELS: Record<string, string> = {
  SAFE:    "SAFE",
  CAUTION: "CAUTION",
  DANGER:  "DANGER",
  RUG:     "RUG PULL"
}

const RISK_CLASS: Record<string, string> = {
  SAFE:    "safe",
  CAUTION: "caution",
  DANGER:  "danger",
  RUG:     "rug"
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

// ─── Shadow DOM ───────────────────────────────────────────────────────────────
let host: HTMLDivElement | null = null
let shadow: ShadowRoot | null = null

const BOX_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap');

:host {
  all: initial;
  position: fixed;
  inset: 0;
  width: 0;
  height: 0;
  z-index: 2147483647;
  pointer-events: none;
  contain: layout style paint;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root { --c-safe:#00e5b0; --c-caution:#f5d000; --c-danger:#ff5f5f; --c-rug:#ff2244 }

.box {
  pointer-events: auto;
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 280px;
  background: #141417;
  border: 1px solid #1f1f22;
  padding: 0;
  overflow: hidden;
  transition: border-color .25s, box-shadow .25s, opacity .22s ease, transform .22s ease;
  animation: appear .45s cubic-bezier(.22,1,.36,1) both;
  display: none;
  opacity: 0;
  transform: translateY(10px);
  font-family: 'IBM Plex Mono', 'SF Mono', monospace;
  font-size: 13px;
  color: #d8d8d8;
}
.box.visible { display: block; }
.box.shown { opacity: 1; transform: translateY(0); }
@keyframes appear { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:none} }
.box:hover { border-color: #2a2a2f; box-shadow: 0 6px 30px rgba(0,0,0,.5); }

/* color line top */
.bline { position: absolute; top: 0; left: 0; right: 0; height: 3px; z-index: 2; }

.inner { padding: 16px; }

/* header */
.head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.brand { font-size: 9px; letter-spacing: .3em; color: #3a3a3f; text-transform: uppercase; font-family: 'IBM Plex Mono', monospace; }
.x { color: #2e2e33; cursor: pointer; font-size: 16px; line-height: 1; transition: color .15s, transform .15s; }
.x:hover { color: #d8d8d8; transform: rotate(90deg); }

/* verdict */
.risk { font: 400 36px/1 'Bebas Neue', sans-serif; letter-spacing: .04em; margin-bottom: 5px; }

/* score row */
.score-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.score { font-size: 11px; color: #4a4a50; font-family: 'IBM Plex Mono', monospace; }
.score strong { color: #aaa; }
.mcap { font-size: 11px; color: #383840; font-family: 'IBM Plex Mono', monospace; }

/* bar */
.bar { height: 3px; background: #1c1c1f; margin-bottom: 14px; overflow: hidden; }
.bar-f { height: 100%; width: 0%; transition: width 1.1s cubic-bezier(.22,1,.36,1); }

/* meta grid */
.meta { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 12px; }
.meta div { padding: 7px 9px; background: #111114; border: 1px solid #1c1c1f; }
.meta span { display: block; font-size: 9px; color: #3a3a3f; letter-spacing: .1em; text-transform: uppercase; margin-bottom: 2px; font-family: 'IBM Plex Mono', monospace; }
.meta strong { font-size: 12px; color: #bbb; font-family: 'IBM Plex Mono', monospace; }

/* flags */
.flags-wrap { margin-bottom: 12px; }
.flag { font-size: 11px; color: #505058; padding: 4px 0 4px 10px; border-left: 2px solid; margin-top: 3px; transition: color .15s, padding-left .15s; font-family: 'IBM Plex Mono', monospace; }
.flag:hover { color: #bbb; padding-left: 14px; }

/* source details toggle */
.toggle { display: block; width: 100%; padding: 8px 16px; background: transparent; border: none; border-top: 1px solid #1c1c1f; font: 600 9px/1 'IBM Plex Mono', monospace; letter-spacing: .2em; color: #383840; text-transform: uppercase; cursor: pointer; transition: color .15s, background .15s; text-align: left; }
.toggle:hover { color: #bbb; background: #111114; }
.extra { display: none; padding: 2px 16px 12px; }
.extra.open { display: block; }
.extra-row { display: flex; justify-content: space-between; font-size: 10px; color: #3a3a3f; padding: 4px 0; border-bottom: 1px solid #171719; font-family: 'IBM Plex Mono', monospace; }
.extra-row span:last-child { color: #777; }

/* actions footer */
.actions { display: flex; gap: 10px; padding: 10px 16px; border-top: 1px solid #1c1c1f; background: #111114; }
.actions a { font-size: 10px; color: #3a3a3f; text-decoration: none; letter-spacing: .05em; text-transform: uppercase; transition: color .15s; font-family: 'IBM Plex Mono', monospace; }
.actions a:hover { color: #d8d8d8; }
.actions a.primary { margin-left: auto; font-weight: 700; }

/* color variants */
.box.safe .bline { background: var(--c-safe, #00e5b0); }
.box.safe .risk  { color: var(--c-safe, #00e5b0); }
.box.safe .bar-f { background: var(--c-safe, #00e5b0); }
.box.safe .flag  { border-color: rgba(0,229,176,.2); }
.box.safe:hover  { box-shadow: 0 6px 30px rgba(0,229,176,.04); }

.box.caution .bline { background: var(--c-caution, #f5d000); }
.box.caution .risk  { color: var(--c-caution, #f5d000); }
.box.caution .bar-f { background: var(--c-caution, #f5d000); }
.box.caution .flag  { border-color: rgba(245,208,0,.18); }

.box.danger .bline { background: var(--c-danger, #ff5f5f); }
.box.danger .risk  { color: var(--c-danger, #ff5f5f); }
.box.danger .bar-f { background: var(--c-danger, #ff5f5f); }
.box.danger .flag  { border-color: rgba(255,95,95,.18); }

.box.rug { border-color: #2a1519; }
.box.rug .bline { background: var(--c-rug, #ff2244); animation: rugline 2s ease infinite; }
@keyframes rugline { 0%,100%{opacity:1} 50%{opacity:.4} }
.box.rug .risk  { color: var(--c-rug, #ff2244); }
.box.rug .bar-f { background: var(--c-rug, #ff2244); }
.box.rug .flag  { border-color: rgba(255,34,68,.18); }
.box.rug:hover  { box-shadow: 0 6px 30px rgba(255,34,68,.06), 0 0 0 1px rgba(255,34,68,.08); }

/* scanning state */
@keyframes ant-pulse { 0%,100%{opacity:1} 50%{opacity:.15} }
.scanning { display: flex; align-items: center; gap: 8px; color: #555; font-size: 11px; padding: 12px 0; font-family: 'IBM Plex Mono', monospace; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #555; display: inline-block; animation: ant-pulse 1.2s infinite; }
`

function ensureHost() {
  if (host && document.documentElement.contains(host)) return
  host = document.createElement("div")
  shadow = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = BOX_CSS
  shadow.appendChild(style)
  document.documentElement.appendChild(host)
}

function getBox(): HTMLDivElement {
  ensureHost()
  let b = shadow!.querySelector(".box") as HTMLDivElement | null
  if (!b) {
    b = document.createElement("div")
    b.className = "box"
    shadow!.appendChild(b)
  }
  return b
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildResult(data: any, ca: string): string {
  const riskClass = RISK_CLASS[data.risk] || "danger"
  const label     = LABELS[data.risk]    || data.risk
  const displayCA = data.resolvedMint || ca
  const mint      = data.resolvedMint || ca
  const score     = data.score ?? 0
  const barWidth  = Math.round(score / 10)

  const mc      = data.pair?.marketCap || data.pair?.fdv
  const liq     = data.pair?.liquidity?.usd
  const holders = data.holders ?? data.pair?.holders
  const conf    = typeof data.confidence === "number" ? data.confidence : null

  const metaHtml = (mc || liq || holders || conf !== null) ? `
    <div class="meta">
      ${mc      ? `<div><span>Market Cap</span><strong>${formatMcap(mc)}</strong></div>` : ""}
      ${liq     ? `<div><span>Liquidity</span><strong>${formatMcap(liq)}</strong></div>` : ""}
      ${holders ? `<div><span>Holders</span><strong>${Number(holders).toLocaleString()}</strong></div>` : ""}
      ${conf !== null ? `<div><span>Confidence</span><strong>${conf}%</strong></div>` : ""}
    </div>` : ""

  const flagsHtml = (data.flags || [])
    .filter((f: any) => {
      const lbl = (f.label || f) as string
      return !lbl.toLowerCase().includes("unavailable") && f.severity !== "bonus"
    })
    .slice(0, 4)
    .map((f: any) => `<div class="flag">${f.label || f}</div>`)
    .join("")

  const sources = data.sources || {}
  const extraRows = Object.entries(sources)
    .map(([k, v]) => `<div class="extra-row"><span>${k}</span><span>${v}</span></div>`)
    .join("")

  const dexLink = data.pair?.url
    ? `<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer">&#8599; DexScreener</a>`
    : ""
  const analysisLink = `<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer" class="primary">&#8599; Full Analysis</a>`

  return `
    <div class="bline"></div>
    <div class="inner">
      <div class="head">
        <span class="brand">ANTARES</span>
        <span class="x" id="antares-close">&times;</span>
      </div>
      <div class="risk">${label}</div>
      <div class="score-row">
        <span class="score">Score <strong>${score}</strong> / 1000</span>
        ${mc ? `<span class="mcap">${formatMcap(mc)}</span>` : ""}
      </div>
      <div class="bar"><div class="bar-f" data-w="${barWidth}"></div></div>
      ${metaHtml}
      ${flagsHtml ? `<div class="flags-wrap">${flagsHtml}</div>` : ""}
      ${extraRows ? `
        <button class="toggle" id="antares-toggle">&#9658; Source details</button>
        <div class="extra" id="antares-extra">${extraRows}</div>
      ` : ""}
    </div>
    <div class="actions">
      ${dexLink}
      ${analysisLink}
    </div>
  `
}

// ─── Visibility ───────────────────────────────────────────────────────────────

let hideTimeout: ReturnType<typeof setTimeout> | null = null

function hideBox() {
  const b = getBox()
  b.classList.remove("shown")
  if (hideTimeout) clearTimeout(hideTimeout)
  hideTimeout = setTimeout(() => { b.classList.remove("visible") }, 250)
}

function showBox(b: HTMLDivElement) {
  if (hideTimeout) clearTimeout(hideTimeout)
  b.classList.add("visible")
  requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add("shown")))
  // animate bar
  setTimeout(() => {
    const bar = b.querySelector(".bar-f") as HTMLDivElement | null
    if (bar) bar.style.width = (bar.dataset.w || "0") + "%"
  }, 120)
}

function attachClose() {
  const btn = shadow!.getElementById("antares-close")
  if (btn) btn.onclick = () => { manuallyDismissed = true; hideBox() }
  const tog = shadow!.getElementById("antares-toggle")
  const ext = shadow!.getElementById("antares-extra")
  if (tog && ext) tog.onclick = () => {
    const open = ext.classList.toggle("open")
    tog.textContent = (open ? "\u25BE " : "\u25B8 ") + "Source details"
  }
}

function applyRiskClass(b: HTMLDivElement, risk: string) {
  b.classList.remove("safe", "caution", "danger", "rug")
  b.classList.add(RISK_CLASS[risk] || "danger")
}

// ─── State ────────────────────────────────────────────────────────────────────

let lastCA = ""
let manuallyDismissed = false
let scanInFlight = false

function resetState() {
  lastCA = ""; manuallyDismissed = false; scanInFlight = false; hideBox()
}

// ─── Scan ─────────────────────────────────────────────────────────────────────

async function scan(ca: string) {
  if (!ca) return
  const b = getBox()
  if (ca === lastCA && b.classList.contains("visible")) return
  if (manuallyDismissed && ca === lastCA) return
  if (scanInFlight) return
  if (ca !== lastCA) { manuallyDismissed = false; lastCA = ca }

  const cached = getCached(ca)
  if (cached) {
    applyRiskClass(b, cached.risk)
    b.innerHTML = buildResult(cached, ca)
    showBox(b); attachClose(); return
  }

  scanInFlight = true
  b.className = "box"
  b.innerHTML = `
    <div class="bline" style="background:#2a2a2f"></div>
    <div class="inner">
      <div class="head"><span class="brand">ANTARES</span><span class="x" id="antares-close">&times;</span></div>
      <div class="scanning"><span class="dot"></span>Scanning&hellip;</div>
    </div>
  `
  showBox(b); attachClose()

  try {
    const res = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json()
    if (lastCA !== ca) { scanInFlight = false; return }
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    applyRiskClass(b, data.risk)
    b.innerHTML = buildResult(data, ca)
    showBox(b); attachClose()
  } catch (_e) {
    if (lastCA !== ca) { scanInFlight = false; return }
    b.innerHTML = `
      <div class="bline" style="background:#ff5f5f"></div>
      <div class="inner">
        <div class="head"><span class="brand">ANTARES</span><span class="x" id="antares-close">&times;</span></div>
        <div style="color:#ff5f5f;font-family:'IBM Plex Mono',monospace;font-size:12px;padding:4px 0">API Error — retry later</div>
      </div>
    `
    attachClose()
  }
  scanInFlight = false
}

// ─── Address detection ────────────────────────────────────────────────────────

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

// ─── Poll / navigation ────────────────────────────────────────────────────────

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
