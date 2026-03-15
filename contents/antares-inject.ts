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

// inject Google Fonts in document <head> once (shadow DOM @import doesn't work)
function injectFonts() {
  if (document.getElementById("antares-fonts")) return
  const link = document.createElement("link")
  link.id   = "antares-fonts"
  link.rel  = "stylesheet"
  link.href = "https://fonts.googleapis.com/css2?family=Bebas+Neue&family=IBM+Plex+Mono:wght@400;600;700&display=swap"
  document.head.appendChild(link)
}

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

// ── SHADOW CSS v6 — visual overhaul (CSS only, no functional changes) ────────────
const SHADOW_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

@keyframes ant-pulse { 0%,100%{opacity:1} 50%{opacity:.15} }
@keyframes ant-flicker-safe    { 0%,100%{text-shadow:0 0 30px rgba(0,229,176,.4),0 0 80px rgba(0,229,176,.15)} 50%{text-shadow:0 0 50px rgba(0,229,176,.7),0 0 120px rgba(0,229,176,.3)} }
@keyframes ant-flicker-caution { 0%,100%{text-shadow:0 0 30px rgba(245,208,0,.4),0 0 80px rgba(245,208,0,.15)} 50%{text-shadow:0 0 50px rgba(245,208,0,.7),0 0 120px rgba(245,208,0,.3)} }
@keyframes ant-flicker-danger  { 0%,100%{text-shadow:0 0 30px rgba(255,95,95,.4),0 0 80px rgba(255,95,95,.15)} 50%{text-shadow:0 0 50px rgba(255,95,95,.7),0 0 120px rgba(255,95,95,.3)} }
@keyframes ant-flicker-rug     { 0%,100%{text-shadow:0 0 30px rgba(255,34,68,.5),0 0 80px rgba(255,34,68,.2)} 50%{text-shadow:0 0 60px rgba(255,34,68,.9),0 0 140px rgba(255,34,68,.4)} }
@keyframes ant-glitch {
  0%,89%,100%{transform:translateX(0);opacity:0}
  91%{transform:translateX(-3px);opacity:.5}
  93%{transform:translateX(3px);opacity:.4}
  95%{transform:translateX(-1px);opacity:.3}
  97%{transform:translateX(0);opacity:0}
}

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
  display: none;
  opacity: 0;
  transform: translateY(18px);
  transition: opacity .25s ease, transform .25s ease;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  line-height: 1.4;
  border-radius: 4px;
}

.box.safe    { background:linear-gradient(180deg,#0b100f 0%,#090b0a 100%); border:1px solid rgba(0,229,176,.18);  box-shadow:0 0 0 1px rgba(0,229,176,.06), 0 20px 60px rgba(0,0,0,.85), 0 0 40px rgba(0,229,176,.05); }
.box.caution { background:linear-gradient(180deg,#0e0d0a 0%,#0a0a09 100%); border:1px solid rgba(245,208,0,.15);  box-shadow:0 0 0 1px rgba(245,208,0,.05), 0 20px 60px rgba(0,0,0,.85), 0 0 40px rgba(245,208,0,.04); }
.box.danger  { background:linear-gradient(180deg,#0e0a0a 0%,#0a0909 100%); border:1px solid rgba(255,95,95,.18);  box-shadow:0 0 0 1px rgba(255,95,95,.06),  0 20px 60px rgba(0,0,0,.85), 0 0 40px rgba(255,95,95,.05); }
.box.rug     { background:linear-gradient(180deg,#110709 0%,#090707 100%); border:1px solid rgba(255,34,68,.22);  box-shadow:0 0 0 1px rgba(255,34,68,.08),  0 20px 60px rgba(0,0,0,.9),  0 0 50px rgba(255,34,68,.08); }

/* corner accents per risk */
.box.safe::before,   .box.safe::after,
.box.caution::before,.box.caution::after,
.box.danger::before, .box.danger::after,
.box.rug::before,    .box.rug::after {
  content:'';
  position:absolute;
  width:10px; height:10px;
  border-style:solid;
  z-index:10;
  pointer-events:none;
}
.box.safe::before,   .box.caution::before, .box.danger::before, .box.rug::before  { top:0;    left:0;  border-width:1px 0 0 1px; }
.box.safe::after,    .box.caution::after,  .box.danger::after,  .box.rug::after   { bottom:0; right:0; border-width:0 1px 1px 0; }
.box.safe::before,    .box.safe::after    { border-color:rgba(0,229,176,.35); }
.box.caution::before, .box.caution::after { border-color:rgba(245,208,0,.3); }
.box.danger::before,  .box.danger::after  { border-color:rgba(255,95,95,.35); }
.box.rug::before,     .box.rug::after     { border-color:rgba(255,34,68,.4); }

/* topbar with glow */
.topbar { height:2px; position:relative; }
.topbar::after { content:''; position:absolute; top:0; left:0; right:0; bottom:0; background:inherit; filter:blur(4px); opacity:.8; }
.box.safe    .topbar { background:linear-gradient(90deg,transparent,#00e5b0,transparent); }
.box.caution .topbar { background:linear-gradient(90deg,transparent,#f5d000,transparent); }
.box.danger  .topbar { background:linear-gradient(90deg,transparent,#ff5f5f,transparent); }
.box.rug     .topbar { background:linear-gradient(90deg,transparent,#ff2244,transparent); }

.hd { display:flex; justify-content:space-between; align-items:center; padding:10px 14px 0; }
.brand { font-size:8px; letter-spacing:.55em; text-transform:uppercase; font-family:'IBM Plex Mono',monospace; }
.box.safe    .brand { color:#00c890; text-shadow:0 0 10px rgba(0,229,176,.4); }
.box.caution .brand { color:#c8a800; text-shadow:0 0 10px rgba(245,208,0,.35); }
.box.danger  .brand { color:#cc5555; text-shadow:0 0 10px rgba(255,95,95,.4); }
.box.rug     .brand { color:#cc3344; text-shadow:0 0 12px rgba(255,34,68,.5); }

.x { font-size:16px; color:#555; cursor:pointer; transition:color .15s; line-height:1; background:none; border:none; font-family:'IBM Plex Mono',monospace; }
.x:hover { color:#ccc; }

.tk { padding:0 14px; margin-top:6px; font-size:10px; color:#888; letter-spacing:.06em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:'IBM Plex Mono',monospace; }
.tk b { color:#ddd; font-weight:700; }

.vb { padding:0 14px 4px; position:relative; z-index:1; }
.vb h1 { font-family:'Bebas Neue','Arial Black',sans-serif; font-size:46px; line-height:.88; font-weight:400; letter-spacing:.04em; position:relative; }
.box.safe    .vb h1 { color:#00e5b0; animation:ant-flicker-safe    3.5s ease-in-out infinite; }
.box.caution .vb h1 { color:#f5d000; animation:ant-flicker-caution 3.5s ease-in-out infinite; }
.box.danger  .vb h1 { color:#ff5f5f; animation:ant-flicker-danger  3.5s ease-in-out infinite; }
.box.rug     .vb h1 { color:#ff2244; animation:ant-flicker-rug     3s   ease-in-out infinite; }

/* glitch lines on h1 for danger/rug */
.box.rug    .vb h1::before, .box.rug    .vb h1::after,
.box.danger .vb h1::before, .box.danger .vb h1::after {
  content:attr(data-label);
  position:absolute; left:0; top:0;
  font-family:'Bebas Neue','Arial Black',sans-serif;
  font-size:46px; line-height:.88; letter-spacing:.04em;
  animation:ant-glitch 7s infinite;
  pointer-events:none;
}
.box.rug    .vb h1::before { color:#ff2244; clip-path:polygon(0 30%,100% 30%,100% 50%,0 50%); transform:translateX(-2px); opacity:.5; }
.box.rug    .vb h1::after  { color:#ff2244; clip-path:polygon(0 58%,100% 58%,100% 72%,0 72%); transform:translateX(2px);  opacity:.4; animation-delay:.15s; }
.box.danger .vb h1::before { color:#ff5f5f; clip-path:polygon(0 30%,100% 30%,100% 50%,0 50%); transform:translateX(-2px); opacity:.4; }
.box.danger .vb h1::after  { color:#ff5f5f; clip-path:polygon(0 58%,100% 58%,100% 72%,0 72%); transform:translateX(2px);  opacity:.3; animation-delay:.1s; }

.sr { display:flex; align-items:center; gap:8px; padding:4px 14px 0; }
.sr .n { font-size:11px; color:#666; font-weight:600; font-family:'IBM Plex Mono',monospace; }
.sr .n b { color:#ddd; font-size:13px; }
.dots { display:flex; gap:3px; align-items:center; }
.dt { width:5px; height:5px; border-radius:50%; }
.dt.off { background:#222226; }
.box.safe    .dt.on { background:#00e5b0; box-shadow:0 0 6px rgba(0,229,176,.6); }
.box.caution .dt.on { background:#f5d000; box-shadow:0 0 6px rgba(245,208,0,.6); }
.box.danger  .dt.on { background:#ff5f5f; box-shadow:0 0 6px rgba(255,95,95,.6); }
.box.rug     .dt.on { background:#ff2244; box-shadow:0 0 6px rgba(255,34,68,.7); }

.sbar { margin:6px 14px 0; height:2px; background:#181818; border-radius:1px; overflow:hidden; }
.sbar-fill { height:100%; border-radius:1px; width:0%; transition:width 1.4s cubic-bezier(.22,1,.36,1); }
.box.safe    .sbar-fill { background:linear-gradient(90deg,#00e5b055,#00e5b0); box-shadow:0 0 6px rgba(0,229,176,.5); }
.box.caution .sbar-fill { background:linear-gradient(90deg,#f5d00044,#f5d000); box-shadow:0 0 6px rgba(245,208,0,.5); }
.box.danger  .sbar-fill { background:linear-gradient(90deg,#ff5f5f44,#ff5f5f); box-shadow:0 0 6px rgba(255,95,95,.5); }
.box.rug     .sbar-fill { background:linear-gradient(90deg,#ff224444,#ff2244); box-shadow:0 0 8px rgba(255,34,68,.6); }

.sum { padding:8px 14px 0; font-size:9.5px; letter-spacing:.03em; font-family:'IBM Plex Mono',monospace; }
.box.safe    .sum { color:#3a9070; }
.box.caution .sum { color:#a89020; }
.box.danger  .sum { color:#cc5555; }
.box.rug     .sum { color:#cc4455; }

.sep { height:1px; margin:8px 14px; }
.box.safe    .sep { background:rgba(0,229,176,.08); }
.box.caution .sep { background:rgba(245,208,0,.07); }
.box.danger  .sep { background:rgba(255,95,95,.08); }
.box.rug     .sep { background:rgba(255,34,68,.08); }

.fl { padding:2px 14px 6px; }
.f { display:flex; align-items:flex-start; gap:8px; padding:6px 0; font-size:10.5px; line-height:1.5; font-family:'IBM Plex Mono',monospace; }
.f+.f { border-top:1px solid rgba(255,255,255,.03); }
.ic { width:15px; height:15px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:7.5px; flex-shrink:0; margin-top:2px; }
.ic.r { background:rgba(255,60,80,.15); color:#ff5f5f; }
.ic.y { background:rgba(245,208,0,.12); color:#f5d000; }
.ic.g { background:rgba(0,229,176,.1);  color:#00e5b0; }
.f.cr .ft-txt { color:#e07070; }
.f.wr .ft-txt { color:#d4b040; }
.f.ok .ft-txt { color:#559970; }

.ss { display:flex; margin:0 14px; border-radius:3px; overflow:hidden; }
.box.safe    .ss { background:#090b0a; border:1px solid rgba(0,229,176,.1); }
.box.caution .ss { background:#0a0a08; border:1px solid rgba(245,208,0,.08); }
.box.danger  .ss { background:#0a0909; border:1px solid rgba(255,95,95,.1); }
.box.rug     .ss { background:#0a0808; border:1px solid rgba(255,34,68,.12); }
.si { flex:1; text-align:center; padding:8px 2px; position:relative; }
.si+.si::before { content:''; position:absolute; left:0; top:20%; height:60%; width:1px; }
.box.safe    .si+.si::before { background:rgba(0,229,176,.1); }
.box.caution .si+.si::before { background:rgba(245,208,0,.08); }
.box.danger  .si+.si::before { background:rgba(255,95,95,.1); }
.box.rug     .si+.si::before { background:rgba(255,34,68,.1); }
.si span { display:block; font-size:8px; color:#777; letter-spacing:.12em; text-transform:uppercase; margin-bottom:3px; font-family:'IBM Plex Mono',monospace; }
.si b { font-size:11px; letter-spacing:.02em; font-weight:700; font-family:'IBM Plex Mono',monospace; }
.si b.y { color:#00e5b0; text-shadow:0 0 8px rgba(0,229,176,.4); }
.si b.n { color:#ff5f5f; text-shadow:0 0 8px rgba(255,95,95,.4); }
.si b.w { color:#f5d000; text-shadow:0 0 6px rgba(245,208,0,.4); }

.fo { display:flex; margin:8px 14px 10px; gap:4px; }
.fo a {
  flex:1; display:block; padding:9px;
  font-size:8.5px; color:#aaa; letter-spacing:.1em;
  text-transform:uppercase; text-decoration:none; text-align:center;
  border-radius:2px; transition:.2s;
  font-family:'IBM Plex Mono',monospace;
  position:relative; overflow:hidden;
}
.fo a::before {
  content:'';
  position:absolute; inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.04),transparent);
  transform:translateX(-100%);
  transition:transform .5s;
}
.fo a:hover::before { transform:translateX(100%); }
.box.safe    .fo a { border:1px solid rgba(0,229,176,.12); }
.box.caution .fo a { border:1px solid rgba(245,208,0,.1); }
.box.danger  .fo a { border:1px solid rgba(255,95,95,.12); }
.box.rug     .fo a { border:1px solid rgba(255,34,68,.15); }
.fo a:hover { color:#fff; }
.fo a.warn  { color:#ff7070; }
.fo a.warn:hover { background:rgba(255,34,68,.05); }

@keyframes ant-pulse { 0%,100%{opacity:1} 50%{opacity:.15} }
.scanning { display:flex; align-items:center; gap:8px; color:#777; font-size:12px; padding:12px 14px; font-family:'IBM Plex Mono',monospace; }
.dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:#444; animation:ant-pulse 1.2s infinite; }
`

// ── Shadow DOM ──────────────────────────────────────────────────────────────

let host: HTMLElement | null = null
let shadow: ShadowRoot | null = null
let boxEl: HTMLDivElement | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null
let lastCA            = ""
let manuallyDismissed = false
let scanInFlight      = false

function createHost() {
  injectFonts()
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
  const liq       = data.liquidity ?? data.pair?.liquidity?.usd ?? null
  const conf      = typeof data.confidence === "number" ? data.confidence : null
  const score     = data.score || 0
  const barW      = Math.min(100, Math.round(score / 10))

  const tokenName   = data.tokenName   || data.pair?.baseToken?.name   || ""
  const tokenSymbol = data.tokenSymbol || data.pair?.baseToken?.symbol || ""

  if (boxEl) boxEl.className = `box ${riskClass}`

  const dotsCount = Math.round((score / 1000) * 5)
  const dots = Array.from({length: 5}, (_, i) =>
    `<div class="dt ${i < dotsCount ? 'on' : 'off'}"></div>`
  ).join("")

  const flagCount = (data.flags || []).filter((f: any) => f.severity !== "bonus").length
  const critCount = (data.flags || []).filter((f: any) => f.severity === "critical").length
  let summary = ""
  if (flagCount === 0) summary = "All sources agree \u2014 no issues found"
  else if (critCount > 0) summary = `${flagCount} flags \u2014 ${critCount} critical \u2014 Conf. ${conf ?? "?"}%`
  else summary = `${flagCount} flags detected \u2014 Conf. ${conf ?? "?"}%`

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

  const mintAuth   = data.mintAuthority   ?? null
  const freezeAuth = data.freezeAuthority ?? null
  const lpStatus   = data.lpBurned === true ? "BURN" : data.lpLocked ? "LOCK" : "NO"
  const sellOk     = data.honeypot === false || data.risk !== "RUG"

  const siSell   = `<div class="si"><span>Sell</span><b class="${sellOk ? 'y' : 'n'}">${sellOk ? '&#10003;' : '&#10005;'}</b></div>`
  const siMint   = `<div class="si"><span>Mint</span><b class="${mintAuth ? 'n' : 'y'}">${mintAuth ? 'ON' : 'OFF'}</b></div>`
  const siFreeze = `<div class="si"><span>Freeze</span><b class="${freezeAuth ? 'n' : 'y'}">${freezeAuth ? 'ON' : 'OFF'}</b></div>`
  const siLP     = `<div class="si"><span>LP</span><b class="${lpStatus === 'NO' ? 'n' : lpStatus === 'BURN' ? 'y' : 'w'}">${lpStatus}</b></div>`
  const siLiq    = liq ? `<div class="si"><span>Liq</span><b class="${liq < 5000 ? 'n' : liq < 30000 ? 'w' : 'y'}">${formatMcap(liq)}</b></div>` : ""

  const isDangerous = riskClass === "danger" || riskClass === "rug"
  const dexLink      = data.pair?.url
    ? `<a href="${data.pair.url}" target="_blank" rel="noopener noreferrer">&#8599; DexScreener</a>`
    : ""
  const analysisLink = `<a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer"${isDangerous ? ' class="warn"' : ''}>Full Analysis &rarr;</a>`

  return `
    <div class="topbar"></div>
    <div class="hd"><span class="brand">ANTARES</span><button class="x" id="ant-close">&times;</button></div>
    ${tokenSymbol ? `<div class="tk"><b>${tokenSymbol}</b> ${tokenName}</div>` : ""}
    <div class="vb"><h1 data-label="${label}">${label}</h1></div>
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
      <div style="color:#ff5f5f;font-size:12px;padding:12px 14px;font-family:'IBM Plex Mono',monospace">API Error &mdash; retry later</div>
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
