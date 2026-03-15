import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API           = "https://antares-extension.vercel.app/api/scan"
const ANALYSIS_PAGE = "https://antares-extension.vercel.app/token.html"
const LS_PREFIX     = "antares_scan_"
const CACHE_TTL     = 90_000

const RISK_CLASS: Record<string, string> = {
  SAFE:    "safe",
  CAUTION: "caution",
  DANGER:  "danger",
  RUG:     "rug"
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

// ── SHADOW CSS v5 ──────────────────────────────────────────────────────────
const SHADOW_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:host {
  all: initial;
  display: block;
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483647;
  font-family: 'IBM Plex Mono', monospace;
  pointer-events: none;
}

.box {
  pointer-events: auto;
  width: 290px;
  overflow: hidden;
  position: relative;
  border: 1px solid rgba(255,255,255,.04);
  box-shadow: 0 40px 80px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.02) inset;
  display: none;
  opacity: 0;
  transform: translateY(18px);
  transition: opacity .25s ease, transform .25s ease;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  line-height: 1.4;
}

.box::before {
  content: '';
  position: absolute;
  top: -60px; left: 50%;
  transform: translateX(-50%);
  width: 180px; height: 100px;
  border-radius: 50%;
  filter: blur(60px);
  opacity: .08;
  z-index: 0;
  pointer-events: none;
}

.box.safe   { background: linear-gradient(180deg,#0b100f 0%,#090b0a 100%); }
.box.caution{ background: linear-gradient(180deg,#0e0d0a 0%,#0a0a09 100%); }
.box.danger { background: linear-gradient(180deg,#0e0a0a 0%,#0a0909 100%); }
.box.rug    { background: linear-gradient(180deg,#100809 0%,#0a0808 100%); }

.box.safe::before   { background: #00e5b0; }
.box.caution::before{ background: #f5d000; }
.box.danger::before { background: #ff5f5f; }
.box.rug::before    { background: #ff2244; }

.topbar { height: 2px; }
.box.safe    .topbar { background: linear-gradient(90deg,transparent,#00e5b0,transparent); }
.box.caution .topbar { background: linear-gradient(90deg,transparent,#f5d000,transparent); }
.box.danger  .topbar { background: linear-gradient(90deg,transparent,#ff5f5f,transparent); }
.box.rug     .topbar { background: linear-gradient(90deg,transparent,#ff2244,transparent); }

.hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px 0;
}
.brand {
  font-size: 6px;
  color: #2a2a30;
  letter-spacing: .55em;
  text-transform: uppercase;
}
.x {
  font-size: 11px;
  color: #2a2a30;
  cursor: pointer;
  transition: color .15s;
  line-height: 1;
  background: none;
  border: none;
  font-family: inherit;
}
.x:hover { color: #555; }

.tk {
  padding: 0 14px;
  margin-top: 6px;
  font-size: 9px;
  color: #2a2a30;
  letter-spacing: .08em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tk b { color: #444; font-weight: 600; }

.vb { padding: 0 14px 4px; position: relative; z-index: 1; }
.vb h1 { font: 400 46px/.88 'Bebas Neue', sans-serif; letter-spacing: .04em; }
.box.safe    .vb h1 { color: #00e5b0; text-shadow: 0 0 30px rgba(0,229,176,.15); }
.box.caution .vb h1 { color: #f5d000; text-shadow: 0 0 30px rgba(245,208,0,.12); }
.box.danger  .vb h1 { color: #ff5f5f; text-shadow: 0 0 30px rgba(255,95,95,.15); }
.box.rug     .vb h1 { color: #ff2244; text-shadow: 0 0 40px rgba(255,34,68,.2); }

.sr { display: flex; align-items: center; gap: 8px; padding: 0 14px; }
.sr .n { font-size: 10px; color: #333; font-weight: 600; }
.sr .n b { color: #777; }
.dots { display: flex; gap: 2px; align-items: center; }
.dt { width: 4px; height: 4px; border-radius: 50%; }
.dt.on  { background: #00e5b0; }
.dt.off { background: #151517; }

.sbar { margin: 6px 14px 0; height: 2px; background: #101012; border-radius: 1px; overflow: hidden; }
.sbar-fill { height: 100%; border-radius: 1px; width: 0%; transition: width 1.1s cubic-bezier(.22,1,.36,1); }
.box.safe    .sbar-fill { background: linear-gradient(90deg,#00e5b055,#00e5b0); }
.box.caution .sbar-fill { background: linear-gradient(90deg,#f5d00044,#f5d000); }
.box.danger  .sbar-fill { background: linear-gradient(90deg,#ff5f5f44,#ff5f5f); }
.box.rug     .sbar-fill { background: linear-gradient(90deg,#ff224444,#ff2244); }

.sum { padding: 8px 14px 0; font-size: 8.5px; letter-spacing: .04em; }
.box.safe    .sum { color: #1e3a30; }
.box.caution .sum { color: #3a3520; }
.box.danger  .sum { color: #3a2020; }
.box.rug     .sum { color: #3a1818; }

.sep { height: 1px; margin: 8px 14px; background: #0e0e10; }

.fl { padding: 2px 14px 6px; }
.f { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0; font-size: 10.5px; line-height: 1.5; }
.f + .f { border-top: 1px solid #0c0c0e; }
.ic {
  width: 15px; height: 15px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 7.5px; flex-shrink: 0; margin-top: 2px; font-style: normal;
}
.ic.r { background: rgba(255,60,80,.08); color: #ff5f5f; }
.ic.y { background: rgba(245,208,0,.06);  color: #bfa000; }
.ic.g { background: rgba(0,229,176,.06);  color: #00c89a; }
.ft-txt { color: #555; }
.ft-txt em { font-style: normal; font-weight: 700; color: #888; }
.f.cr .ft-txt { color: #996060; }
.f.wr .ft-txt { color: #8a7a40; }
.f.ok .ft-txt { color: #334a40; }

.ss {
  display: flex;
  margin: 0 14px;
  background: #09090b;
  border-radius: 3px;
  overflow: hidden;
}
.si { flex: 1; text-align: center; padding: 7px 2px; position: relative; }
.si + .si::before {
  content: '';
  position: absolute; left: 0; top: 25%; height: 50%; width: 1px;
  background: #0e0e10;
}
.si span {
  display: block; font-size: 5.5px; color: #1e1e22;
  letter-spacing: .16em; text-transform: uppercase; margin-bottom: 3px;
}
.si b { font-size: 9px; letter-spacing: .02em; font-weight: 700; }
.si b.y { color: #00e5b0; }
.si b.n { color: #ff5f5f; }
.si b.w { color: #f5d000; }

.fo { display: flex; margin: 8px 14px 10px; gap: 4px; }
.fo a {
  flex: 1; display: block; padding: 8px;
  font-size: 7px; color: #222; letter-spacing: .14em;
  text-transform: uppercase; text-decoration: none; text-align: center;
  border: 1px solid #111114; border-radius: 2px; transition: .2s;
}
.fo a:hover { color: #888; border-color: #1e1e22; background: rgba(255,255,255,.01); }
.fo a.warn  { border-color: rgba(255,95,95,.1); color: #4a2020; }
.fo a.warn:hover { border-color: rgba(255,95,95,.2); color: #ff5f5f; background: rgba(255,95,95,.03); }

@keyframes ant-pulse { 0%,100%{opacity:1} 50%{opacity:.15} }
.scanning { display:flex; align-items:center; gap:8px; color:#888890; font-size:12px; padding:12px 14px; }
.dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#5a5a62; animation:ant-pulse 1.2s infinite; }
`

// ── Shadow DOM ───────────────────────────────────────────────────────────────

let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let boxEl: HTMLDivElement | null = null
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
  boxEl = document.createElement("div")
  boxEl.className = "box"
  shadow.appendChild(boxEl)
}

new MutationObserver(() => {
  if (!host || !document.documentElement.contains(host)) createHost()
}).observe(document.documentElement, { childList: true, subtree: false })

function getBox(): HTMLDivElement {
  if (!host || !document.documentElement.contains(host)) createHost()
  return boxEl!
}

function hideBox() {
  if (!boxEl) return
  boxEl.style.opacity   = "0"
  boxEl.style.transform = "translateY(18px)"
  if (hideTimeout) clearTimeout(hideTimeout)
  hideTimeout = setTimeout(() => { if (boxEl) boxEl.style.display = "none" }, 250)
}

function showBox() {
  if (!host || !document.documentElement.contains(host)) createHost()
  const el = boxEl!
  if (hideTimeout) clearTimeout(hideTimeout)
  el.style.display = "block"
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.style.opacity   = "1"
    el.style.transform = "translateY(0)"
  }))
}

function resetState() { lastCA = ""; manuallyDismissed = false; scanInFlight = false; hideBox() }

function attachClose() {
  shadow?.querySelector("#ant-close")?.addEventListener("click", () => { manuallyDismissed = true; hideBox() }, { once: true })
}

// ── HTML builders ─────────────────────────────────────────────────────────────
function buildResult(data: any, ca: string): string {
  const riskClass = RISK_CLASS[data.risk] || "danger"
  const label     = LABELS[data.risk] || data.risk
  const mint      = data.resolvedMint || ca
  const mc        = data.marketCap ?? data.pair?.marketCap ?? data.pair?.fdv ?? null
  const liq       = data.liquidity ?? data.pair?.liquidity?.usd ?? null
  const holders   = data.holders ?? null
  const conf      = typeof data.confidence === "number" ? data.confidence : null
  const score     = data.score || 0
  const barW      = Math.min(100, Math.round(score / 10))

  const tokenName   = data.tokenName   || data.pair?.baseToken?.name   || ""
  const tokenSymbol = data.tokenSymbol || data.pair?.baseToken?.symbol || ""

  if (boxEl) boxEl.className = `box ${riskClass}`

  // dots (5 dots, filled proportional to score/1000)
  const dotsCount = Math.round((score / 1000) * 5)
  const dots = Array.from({length: 5}, (_, i) =>
    `<div class="dt ${i < dotsCount ? 'on' : 'off'}"></div>`
  ).join("")

  // summary line
  const flagCount = (data.flags || []).filter((f: any) => f.severity !== "bonus").length
  const critCount = (data.flags || []).filter((f: any) => f.severity === "critical").length
  let summary = ""
  if (flagCount === 0) summary = "All sources agree — no issues found"
  else if (critCount > 0) summary = `${flagCount} flags — ${critCount} critical — Conf. ${conf ?? "?"}%`
  else summary = `${flagCount} flags detected — Conf. ${conf ?? "?"}%`

  // flags
  const flags = (data.flags || [])
    .filter((f: any) => { const l = (f.label || f) as string; return !l.toLowerCase().includes("unavailable") && f.severity !== "bonus" })
    .slice(0, 4)
    .map((f: any) => {
      const sev = f.severity || "warning"
      const cls = sev === "critical" ? "cr" : "wr"
      const icCls = sev === "critical" ? "r" : "y"
      const ico = sev === "critical" ? "&#10005;" : "!"
      return `<div class="f ${cls}"><div class="ic ${icCls}">${ico}</div><div class="ft-txt">${f.label || f}</div></div>`
    })
    .join("")

  const noFlags = flags === "" ? `<div class="f ok"><div class="ic g">&#10003;</div><div class="ft-txt">No critical flags detected</div></div>` : flags

  // safety strip — use API data
  const mintAuth   = data.mintAuthority   ?? null
  const freezeAuth = data.freezeAuthority ?? null
  const lpStatus   = data.lpBurned === true ? "BURN" : data.lpLocked ? "LOCK" : "NO"
  const sellOk     = data.honeypot === false || data.risk !== "RUG"

  const siSell   = `<div class="si"><span>Sell</span><b class="${sellOk ? 'y' : 'n'}">${sellOk ? '&#10003;' : '&#10005;'}</b></div>`
  const siMint   = `<div class="si"><span>Mint</span><b class="${mintAuth ? 'n' : 'y'}">${mintAuth ? 'ON' : 'OFF'}</b></div>`
  const siFreeze = `<div class="si"><span>Freeze</span><b class="${freezeAuth ? 'n' : 'y'}">${freezeAuth ? 'ON' : 'OFF'}</b></div>`
  const siLP     = `<div class="si"><span>LP</span><b class="${lpStatus === 'NO' ? 'n' : lpStatus === 'BURN' ? 'y' : 'w'}">${lpStatus}</b></div>`
  const siLiq    = liq ? `<div class="si"><span>Liq</span><b class="${liq < 5000 ? 'n' : liq < 30000 ? 'w' : 'y'}">${formatMcap(liq)}</b></div>` : ""

  // footer links
  const isDangerous = riskClass === "danger" || riskClass === "rug"
  const dexLink      = data.pair?.url
    ? `<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer">&#8599; DexScreener</a>`
    : ""
  const analysisLink = `<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer"${isDangerous ? ' class="warn"' : ''}>Full Analysis &rarr;</a>`

  return `
    <div class="topbar"></div>
    <div class="hd"><span class="brand">ANTARES</span><button class="x" id="ant-close">&times;</button></div>
    ${tokenSymbol ? `<div class="tk"><b>${tokenSymbol}</b> ${tokenName}</div>` : ""}
    <div class="vb"><h1>${label}</h1></div>
    <div class="sr"><span class="n"><b>${score}</b> / 1000</span><div class="dots">${dots}</div></div>
    <div class="sbar"><div class="sbar-fill" data-w="${barW}"></div></div>
    <div class="sum">${summary}</div>
    <div class="sep"></div>
    <div class="fl">${noFlags}</div>
    <div class="sep"></div>
    <div class="ss">${siSell}${siMint}${siFreeze}${siLP}${siLiq}</div>
    <div class="fo">${dexLink}${analysisLink}</div>
  `
}

// ── scan ──────────────────────────────────────────────────────────────────────
async function scan(ca: string) {
  if (!ca) return
  const el = getBox()
  if (ca === lastCA && el.style.display !== "none") return
  if (manuallyDismissed && ca === lastCA) return
  if (scanInFlight) return
  if (ca !== lastCA) { manuallyDismissed = false; lastCA = ca }

  const cached = getCached(ca)
  if (cached) {
    el.innerHTML = buildResult(cached, ca)
    showBox()
    requestAnimationFrame(() => {
      el.querySelectorAll(".sbar-fill").forEach((b: any) => setTimeout(() => { b.style.width = b.dataset.w + "%" }, 250))
    })
    attachClose(); return
  }

  scanInFlight = true
  if (boxEl) boxEl.className = "box"
  el.innerHTML = `
    <div class="topbar" style="background:linear-gradient(90deg,transparent,#3a3a3f,transparent)"></div>
    <div class="hd"><span class="brand">ANTARES</span><button class="x" id="ant-close">&times;</button></div>
    <div class="scanning"><span class="dot"></span>Scanning&hellip;</div>
  `
  showBox(); attachClose()

  try {
    const res  = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json()
    if (lastCA !== ca) { scanInFlight = false; return }
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    el.innerHTML = buildResult(data, ca)
    showBox()
    requestAnimationFrame(() => {
      el.querySelectorAll(".sbar-fill").forEach((b: any) => setTimeout(() => { b.style.width = b.dataset.w + "%" }, 250))
    })
    attachClose()
  } catch (_e) {
    if (lastCA !== ca) { scanInFlight = false; return }
    if (boxEl) boxEl.className = "box danger"
    el.innerHTML = `
      <div class="topbar"></div>
      <div class="hd"><span class="brand">ANTARES</span><button class="x" id="ant-close">&times;</button></div>
      <div style="color:#ff5f5f;font-size:12px;padding:12px 14px">API Error &mdash; retry later</div>
    `
    showBox(); attachClose()
  }
  scanInFlight = false
}

// ── address detection ─────────────────────────────────────────────────────────
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

// ── init ──────────────────────────────────────────────────────────────────────
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
