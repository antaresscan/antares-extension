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

// ── cache ────────────────────────────────────────────────────────────────
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

// ── helpers ───────────────────────────────────────────────────────────────
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

// ── styles ────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById("antares-brutal-styles")) return
  const link = document.createElement("link")
  link.rel  = "stylesheet"
  link.href = "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap"
  document.head?.appendChild(link)

  const style = document.createElement("style")
  style.id = "antares-brutal-styles"
  style.textContent = `
/* reset ALL children to avoid host page CSS bleed */
#antares-box,#antares-box *{
  all:unset;
  box-sizing:border-box !important;
}

#antares-box{
  display:none !important;
  position:fixed !important;
  bottom:20px !important;
  right:20px !important;
  z-index:2147483647 !important;
  width:280px !important;
  background:#141417 !important;
  border:1px solid #1f1f22 !important;
  padding:0 !important;
  overflow:hidden !important;
  opacity:0 !important;
  transform:translateY(18px) !important;
  font-family:'IBM Plex Mono',monospace !important;
  font-size:13px !important;
  color:#d8d8d8 !important;
  line-height:1.4 !important;
  transition:opacity .25s,transform .25s,border-color .25s,box-shadow .25s !important;
}

#antares-box .bline{
  display:block !important;
  position:absolute !important;
  top:0 !important;left:0 !important;right:0 !important;
  height:3px !important;
  z-index:2 !important;
}

#antares-box .inner{
  display:block !important;
  padding:16px !important;
}

#antares-box .head{
  display:flex !important;
  justify-content:space-between !important;
  align-items:center !important;
  margin-bottom:12px !important;
}

#antares-box .brand{
  display:block !important;
  font-size:9px !important;
  letter-spacing:.3em !important;
  color:#3a3a3f !important;
  text-transform:uppercase !important;
  font-family:'IBM Plex Mono',monospace !important;
  font-weight:400 !important;
}

#antares-box .x{
  display:block !important;
  color:#2e2e33 !important;
  cursor:pointer !important;
  font-size:18px !important;
  line-height:1 !important;
  font-family:'IBM Plex Mono',monospace !important;
  transition:color .15s !important;
}
#antares-box .x:hover{ color:#d8d8d8 !important; }

#antares-box .risk{
  display:block !important;
  font-family:'Bebas Neue',sans-serif !important;
  font-size:36px !important;
  font-weight:400 !important;
  line-height:1 !important;
  letter-spacing:.04em !important;
  margin-bottom:5px !important;
}

#antares-box .score-row{
  display:flex !important;
  justify-content:space-between !important;
  align-items:baseline !important;
  margin-bottom:10px !important;
}

#antares-box .score{
  display:block !important;
  font-size:11px !important;
  color:#4a4a50 !important;
  font-family:'IBM Plex Mono',monospace !important;
  font-weight:400 !important;
}
#antares-box .score strong{
  color:#aaa !important;
  font-weight:600 !important;
}

#antares-box .mcap{
  display:block !important;
  font-size:11px !important;
  color:#383840 !important;
  font-family:'IBM Plex Mono',monospace !important;
}

#antares-box .bar{
  display:block !important;
  height:3px !important;
  background:#1c1c1f !important;
  margin-bottom:14px !important;
  overflow:hidden !important;
}
#antares-box .bar-f{
  display:block !important;
  height:100% !important;
  transition:width 1.1s cubic-bezier(.22,1,.36,1) !important;
}

#antares-box .meta{
  display:grid !important;
  grid-template-columns:1fr 1fr !important;
  gap:5px !important;
  margin-bottom:12px !important;
}
#antares-box .meta div{
  display:block !important;
  padding:7px 9px !important;
  background:#111114 !important;
  border:1px solid #1c1c1f !important;
  border-radius:2px !important;
}
#antares-box .meta span{
  display:block !important;
  font-size:9px !important;
  color:#3a3a3f !important;
  letter-spacing:.1em !important;
  text-transform:uppercase !important;
  margin-bottom:2px !important;
  font-family:'IBM Plex Mono',monospace !important;
  font-weight:400 !important;
}
#antares-box .meta strong{
  display:block !important;
  font-size:12px !important;
  color:#bbb !important;
  font-weight:600 !important;
  font-family:'IBM Plex Mono',monospace !important;
}

#antares-box .flags-wrap{
  display:block !important;
  margin-bottom:12px !important;
}
#antares-box .flag{
  display:block !important;
  font-size:11px !important;
  color:#505058 !important;
  padding:4px 0 4px 10px !important;
  border-left:2px solid !important;
  margin-top:3px !important;
  font-family:'IBM Plex Mono',monospace !important;
  font-weight:400 !important;
  transition:color .15s,padding-left .15s !important;
}
#antares-box .flag:hover{ color:#bbb !important; padding-left:14px !important; }

#antares-box .toggle{
  display:block !important;
  width:100% !important;
  padding:8px 16px !important;
  background:transparent !important;
  border:none !important;
  border-top:1px solid #1c1c1f !important;
  font-size:9px !important;
  font-weight:600 !important;
  font-family:'IBM Plex Mono',monospace !important;
  letter-spacing:.2em !important;
  color:#383840 !important;
  text-transform:uppercase !important;
  cursor:pointer !important;
  text-align:left !important;
  transition:color .15s,background .15s !important;
}
#antares-box .toggle:hover{ color:#bbb !important; background:#111114 !important; }

#antares-box .extra{ display:none !important; padding:2px 16px 12px !important; }
#antares-box .extra.open{ display:block !important; }
#antares-box .extra-row{
  display:flex !important;
  justify-content:space-between !important;
  font-size:10px !important;
  color:#3a3a3f !important;
  padding:4px 0 !important;
  border-bottom:1px solid #171719 !important;
  font-family:'IBM Plex Mono',monospace !important;
}
#antares-box .extra-row span:last-child{ color:#777 !important; }

#antares-box .actions{
  display:flex !important;
  gap:10px !important;
  padding:10px 16px !important;
  border-top:1px solid #1c1c1f !important;
  background:#111114 !important;
}
#antares-box .actions a{
  display:block !important;
  font-size:10px !important;
  color:#3a3a3f !important;
  text-decoration:none !important;
  letter-spacing:.05em !important;
  text-transform:uppercase !important;
  cursor:pointer !important;
  font-family:'IBM Plex Mono',monospace !important;
  font-weight:400 !important;
  transition:color .15s !important;
}
#antares-box .actions a:hover{ color:#d8d8d8 !important; }
#antares-box .actions a.primary{ margin-left:auto !important; }

#antares-box .scanning{
  display:flex !important;
  align-items:center !important;
  gap:8px !important;
  color:#4a4a50 !important;
  font-size:12px !important;
  padding:4px 0 !important;
  font-family:'IBM Plex Mono',monospace !important;
}
#antares-box .scanning .dot{
  display:inline-block !important;
  width:7px !important;
  height:7px !important;
  border-radius:50% !important;
  background:#3a3a3f !important;
  animation:ant-pulse 1.2s infinite !important;
}

@keyframes ant-pulse{0%,100%{opacity:1}50%{opacity:.15}}
@keyframes ant-rugline{0%,100%{opacity:1}50%{opacity:.4}}
  `
  document.head?.appendChild(style)
}

// ── HTML builders ─────────────────────────────────────────────────────
function buildResult(data: any, ca: string): string {
  const c     = COLORS[data.risk] || { main: "#6b7280", rgba: "107,114,128" }
  const label = LABELS[data.risk] || data.risk
  const mint  = data.resolvedMint || ca

  const mc      = data.pair?.marketCap || data.pair?.fdv
  const liq     = data.pair?.liquidity?.usd
  const holders = data.pair?.holders
  const conf    = typeof data.confidence === "number" ? data.confidence : null
  const barW    = (data.score || 0) / 10

  const metaCells = [
    mc      ? `<div><span>Market Cap</span><strong>${formatMcap(mc)}</strong></div>` : "",
    liq     ? `<div><span>Liquidity</span><strong>${formatMcap(liq)}</strong></div>` : "",
    holders ? `<div><span>Holders</span><strong>${holders.toLocaleString()}</strong></div>` : "",
    conf !== null ? `<div><span>Confidence</span><strong>${conf}%</strong></div>` : "",
  ].filter(Boolean).join("")

  const flags = (data.flags || [])
    .filter((f: any) => {
      const lbl = (f.label || f) as string
      return !lbl.toLowerCase().includes("unavailable") && f.severity !== "bonus"
    })
    .slice(0, 4)
    .map((f: any) => {
      const lbl = f.label || f
      return `<div class="flag" style="border-color:rgba(${c.rgba},.2)">${lbl}</div>`
    }).join("")

  const sourceNames = data.sources_used || ["DexScreener", "RugCheck", "GoPlus", "Helius RPC"]
  const sourceRows  = sourceNames.map((s: string) =>
    `<div class="extra-row"><span>${s}</span><span>✓ Used</span></div>`
  ).join("")

  const dexLink      = data.pair?.url
    ? `<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer">↗ DexScreener</a>`
    : ""
  const analysisLink = `<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer" class="primary">↗ Full Analysis</a>`

  const blineStyle = data.risk === "RUG"
    ? `background:${c.main};animation:ant-rugline 2s ease infinite`
    : `background:${c.main}`

  return `
    <div class="bline" style="${blineStyle}"></div>
    <div class="inner">
      <div class="head">
        <span class="brand">ANTARES</span>
        <span class="x" id="antares-close">×</span>
      </div>
      <div class="risk" style="color:${c.main}">${label}</div>
      <div class="score-row">
        <span class="score">Score <strong>${data.score}</strong> / 1000</span>
        <span class="mcap">${mc ? formatMcap(mc) : ""}</span>
      </div>
      <div class="bar"><div class="bar-f" style="background:${c.main};width:${barW}%"></div></div>
      ${metaCells ? `<div class="meta">${metaCells}</div>` : ""}
      ${flags     ? `<div class="flags-wrap">${flags}</div>` : ""}
    </div>
    <button class="toggle" id="antares-toggle">▸ Source details</button>
    <div class="extra" id="antares-extra">${sourceRows}</div>
    <div class="actions">${dexLink}${analysisLink}</div>
  `
}

// ── DOM ───────────────────────────────────────────────────────────────────
let lastCA            = ""
let box: HTMLDivElement | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null
let manuallyDismissed = false
let scanInFlight      = false

function hideBox() {
  if (!box) return
  box.style.opacity   = "0"
  box.style.transform = "translateY(18px)"
  if (hideTimeout) clearTimeout(hideTimeout)
  hideTimeout = setTimeout(() => { if (box) box.style.display = "none" }, 250)
}

function resetState() { lastCA = ""; manuallyDismissed = false; scanInFlight = false; hideBox() }

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
  el.style.cssText = `display:block !important;opacity:1 !important;transform:translateY(0) !important;`
}

function attachClose() {
  const btn = document.getElementById("antares-close")
  if (btn) btn.onclick = () => { manuallyDismissed = true; hideBox() }
}

function attachToggle() {
  const btn   = document.getElementById("antares-toggle")
  const extra = document.getElementById("antares-extra")
  if (btn && extra) {
    btn.onclick = () => {
      const isOpen = extra.classList.contains("open")
      extra.classList.toggle("open")
      btn.textContent = isOpen ? "▸ Source details" : "▾ Source details"
    }
  }
}

function applyRiskStyle(el: HTMLDivElement, risk: string) {
  const c = COLORS[risk] || { main: "#6b7280", rgba: "107,114,128" }
  el.style.borderColor = risk === "RUG" ? "#2a1519" : "#1f1f22"
  el.style.boxShadow   = `0 6px 30px rgba(${c.rgba},.06)`
}

// ── scan ──────────────────────────────────────────────────────────────────
async function scan(ca: string) {
  if (!ca) return
  if (ca === lastCA && box && box.style.display !== "none") return
  if (manuallyDismissed && ca === lastCA) return
  if (scanInFlight) return
  if (ca !== lastCA) { manuallyDismissed = false; lastCA = ca }

  const cached = getCached(ca)
  if (cached) {
    const el = ensureBox()
    applyRiskStyle(el, cached.risk)
    el.innerHTML = buildResult(cached, ca)
    showBox(el); attachClose(); attachToggle(); return
  }

  scanInFlight = true
  const el = ensureBox()
  el.style.borderColor = "#1f1f22"
  el.style.boxShadow   = "none"
  el.innerHTML = `
    <div class="bline" style="background:#3a3a3f"></div>
    <div class="inner">
      <div class="head">
        <span class="brand">ANTARES</span>
        <span class="x" id="antares-close">×</span>
      </div>
      <div class="scanning"><span class="dot"></span>Scanning…</div>
    </div>
  `
  showBox(el); attachClose()

  try {
    const res  = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json()
    if (lastCA !== ca) { scanInFlight = false; return }
    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)
    applyRiskStyle(el, data.risk)
    el.innerHTML = buildResult(data, ca)
    showBox(el); attachClose(); attachToggle()
  } catch (e) {
    if (lastCA !== ca) { scanInFlight = false; return }
    el.innerHTML = `
      <div class="bline" style="background:#ff5f5f"></div>
      <div class="inner">
        <div class="head">
          <span class="brand">ANTARES</span>
          <span class="x" id="antares-close">×</span>
        </div>
        <div style="color:#ff5f5f;font-size:12px;padding:4px 0;font-family:'IBM Plex Mono',monospace;display:block">API Error — retry later</div>
      </div>
    `
    showBox(el); attachClose()
  }
  scanInFlight = false
}

// ── address detection ────────────────────────────────────────────────────
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

// ── init ───────────────────────────────────────────────────────────────────
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
