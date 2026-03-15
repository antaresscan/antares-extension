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

// ── SHADOW CSS v7 — same visuals, full !important isolation ─────────────────
const SHADOW_CSS = `
*,*::before,*::after{box-sizing:border-box!important;margin:0!important;padding:0!important}

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

/* ── :host — coupe l'héritage CSS de la page ── */
:host {
  all: initial!important;
  display: block!important;
  position: fixed!important;
  bottom: 20px!important;
  right: 20px!important;
  z-index: 2147483647!important;
  font-family: 'IBM Plex Mono',monospace!important;
  pointer-events: none!important;
}

.box {
  pointer-events: auto!important;
  width: 290px!important;
  overflow: hidden!important;
  position: relative!important;
  display: none!important;
  opacity: 0!important;
  transform: translateY(18px)!important;
  transition: opacity .25s ease, transform .25s ease!important;
  font-family: 'IBM Plex Mono',monospace!important;
  font-size: 12px!important;
  line-height: 1.4!important;
  border-radius: 4px!important;
  color: #c8c8d0!important;
  -webkit-font-smoothing: antialiased!important;
}

.box.safe    { background:linear-gradient(180deg,#0b100f 0%,#090b0a 100%)!important; border:1px solid rgba(0,229,176,.18)!important;  box-shadow:0 0 0 1px rgba(0,229,176,.06), 0 20px 60px rgba(0,0,0,.85), 0 0 40px rgba(0,229,176,.05)!important; }
.box.caution { background:linear-gradient(180deg,#0e0d0a 0%,#0a0a09 100%)!important; border:1px solid rgba(245,208,0,.15)!important;   box-shadow:0 0 0 1px rgba(245,208,0,.05),  0 20px 60px rgba(0,0,0,.85), 0 0 40px rgba(245,208,0,.04)!important; }
.box.danger  { background:linear-gradient(180deg,#0e0a0a 0%,#0a0909 100%)!important; border:1px solid rgba(255,95,95,.18)!important;   box-shadow:0 0 0 1px rgba(255,95,95,.06),   0 20px 60px rgba(0,0,0,.85), 0 0 40px rgba(255,95,95,.05)!important; }
.box.rug     { background:linear-gradient(180deg,#110709 0%,#090707 100%)!important; border:1px solid rgba(255,34,68,.22)!important;   box-shadow:0 0 0 1px rgba(255,34,68,.08),   0 20px 60px rgba(0,0,0,.9),  0 0 50px rgba(255,34,68,.08)!important; }

.box.safe::before,   .box.safe::after,
.box.caution::before,.box.caution::after,
.box.danger::before, .box.danger::after,
.box.rug::before,    .box.rug::after {
  content:''!important;
  position:absolute!important;
  width:10px!important; height:10px!important;
  border-style:solid!important;
  background:none!important;
  z-index:10!important;
  pointer-events:none!important;
}
.box.safe::before,   .box.caution::before, .box.danger::before, .box.rug::before  { top:0!important;    left:0!important;  border-width:1px 0 0 1px!important; }
.box.safe::after,    .box.caution::after,  .box.danger::after,  .box.rug::after   { bottom:0!important; right:0!important; border-width:0 1px 1px 0!important; }
.box.safe::before,    .box.safe::after    { border-color:rgba(0,229,176,.35)!important; }
.box.caution::before, .box.caution::after { border-color:rgba(245,208,0,.3)!important; }
.box.danger::before,  .box.danger::after  { border-color:rgba(255,95,95,.35)!important; }
.box.rug::before,     .box.rug::after     { border-color:rgba(255,34,68,.4)!important; }

.topbar { height:2px!important; position:relative!important; display:block!important; }
.topbar::after { content:''!important; position:absolute!important; top:0!important; left:0!important; right:0!important; bottom:0!important; background:inherit!important; filter:blur(4px)!important; opacity:.8!important; }
.box.safe    .topbar { background:linear-gradient(90deg,transparent,#00e5b0,transparent)!important; }
.box.caution .topbar { background:linear-gradient(90deg,transparent,#f5d000,transparent)!important; }
.box.danger  .topbar { background:linear-gradient(90deg,transparent,#ff5f5f,transparent)!important; }
.box.rug     .topbar { background:linear-gradient(90deg,transparent,#ff2244,transparent)!important; }

.hd { display:flex!important; justify-content:space-between!important; align-items:center!important; padding:10px 14px 0!important; }

.brand {
  font-size:8px!important;
  letter-spacing:.55em!important;
  text-transform:uppercase!important;
  font-family:'IBM Plex Mono',monospace!important;
  font-weight:600!important;
  line-height:1!important;
}
.box.safe    .brand { color:#00c890!important; text-shadow:0 0 10px rgba(0,229,176,.4)!important; }
.box.caution .brand { color:#c8a800!important; text-shadow:0 0 10px rgba(245,208,0,.35)!important; }
.box.danger  .brand { color:#cc5555!important; text-shadow:0 0 10px rgba(255,95,95,.4)!important; }
.box.rug     .brand { color:#cc3344!important; text-shadow:0 0 12px rgba(255,34,68,.5)!important; }

.x {
  font-size:16px!important;
  color:#555!important;
  cursor:pointer!important;
  transition:color .15s!important;
  line-height:1!important;
  background:none!important;
  border:none!important;
  font-family:'IBM Plex Mono',monospace!important;
  padding:0!important;
  margin:0!important;
  display:inline-block!important;
}
.x:hover { color:#ccc!important; }

.tk {
  padding:0 14px!important;
  margin-top:6px!important;
  font-size:10px!important;
  color:#888!important;
  letter-spacing:.06em!important;
  white-space:nowrap!important;
  overflow:hidden!important;
  text-overflow:ellipsis!important;
  font-family:'IBM Plex Mono',monospace!important;
  display:block!important;
  line-height:1.4!important;
}
.tk b { color:#ddd!important; font-weight:700!important; font-family:'IBM Plex Mono',monospace!important; }

.vb { padding:0 14px 4px!important; position:relative!important; z-index:1!important; display:block!important; }
.vb h1 {
  font-family:'Bebas Neue','Arial Black',sans-serif!important;
  font-size:46px!important;
  line-height:.88!important;
  font-weight:400!important;
  letter-spacing:.04em!important;
  position:relative!important;
  display:block!important;
  margin:0!important;
  padding:0!important;
  background:none!important;
  border:none!important;
  text-transform:none!important;
}
.box.safe    .vb h1 { color:#00e5b0!important; animation:ant-flicker-safe    3.5s ease-in-out infinite!important; }
.box.caution .vb h1 { color:#f5d000!important; animation:ant-flicker-caution 3.5s ease-in-out infinite!important; }
.box.danger  .vb h1 { color:#ff5f5f!important; animation:ant-flicker-danger  3.5s ease-in-out infinite!important; }
.box.rug     .vb h1 { color:#ff2244!important; animation:ant-flicker-rug     3s   ease-in-out infinite!important; }

.box.rug    .vb h1::before, .box.rug    .vb h1::after,
.box.danger .vb h1::before, .box.danger .vb h1::after {
  content:attr(data-label)!important;
  position:absolute!important; left:0!important; top:0!important;
  font-family:'Bebas Neue','Arial Black',sans-serif!important;
  font-size:46px!important; line-height:.88!important; letter-spacing:.04em!important;
  animation:ant-glitch 7s infinite!important;
  pointer-events:none!important;
  background:none!important;
}
.box.rug    .vb h1::before { color:#ff2244!important; clip-path:polygon(0 30%,100% 30%,100% 50%,0 50%)!important; transform:translateX(-2px)!important; opacity:.5!important; }
.box.rug    .vb h1::after  { color:#ff2244!important; clip-path:polygon(0 58%,100% 58%,100% 72%,0 72%)!important; transform:translateX(2px)!important;  opacity:.4!important; animation-delay:.15s!important; }
.box.danger .vb h1::before { color:#ff5f5f!important; clip-path:polygon(0 30%,100% 30%,100% 50%,0 50%)!important; transform:translateX(-2px)!important; opacity:.4!important; }
.box.danger .vb h1::after  { color:#ff5f5f!important; clip-path:polygon(0 58%,100% 58%,100% 72%,0 72%)!important; transform:translateX(2px)!important;  opacity:.3!important; animation-delay:.1s!important; }

.sr { display:flex!important; align-items:center!important; gap:8px!important; padding:4px 14px 0!important; }
.sr .n { font-size:11px!important; color:#666!important; font-weight:600!important; font-family:'IBM Plex Mono',monospace!important; line-height:1!important; }
.sr .n b { color:#ddd!important; font-size:13px!important; font-weight:700!important; font-family:'IBM Plex Mono',monospace!important; }

.dots { display:flex!important; gap:3px!important; align-items:center!important; }
.dt { width:5px!important; height:5px!important; border-radius:50%!important; display:inline-block!important; flex-shrink:0!important; }
.dt.off { background:#222226!important; }
.box.safe    .dt.on { background:#00e5b0!important; box-shadow:0 0 6px rgba(0,229,176,.6)!important; }
.box.caution .dt.on { background:#f5d000!important; box-shadow:0 0 6px rgba(245,208,0,.6)!important; }
.box.danger  .dt.on { background:#ff5f5f!important; box-shadow:0 0 6px rgba(255,95,95,.6)!important; }
.box.rug     .dt.on { background:#ff2244!important; box-shadow:0 0 6px rgba(255,34,68,.7)!important; }

.sbar { margin:6px 14px 0!important; height:2px!important; background:#181818!important; border-radius:1px!important; overflow:hidden!important; display:block!important; }
.sbar-fill { height:100%!important; border-radius:1px!important; width:0%!important; transition:width 1.4s cubic-bezier(.22,1,.36,1)!important; display:block!important; }
.box.safe    .sbar-fill { background:linear-gradient(90deg,#00e5b055,#00e5b0)!important; box-shadow:0 0 6px rgba(0,229,176,.5)!important; }
.box.caution .sbar-fill { background:linear-gradient(90deg,#f5d00044,#f5d000)!important; box-shadow:0 0 6px rgba(245,208,0,.5)!important; }
.box.danger  .sbar-fill { background:linear-gradient(90deg,#ff5f5f44,#ff5f5f)!important; box-shadow:0 0 6px rgba(255,95,95,.5)!important; }
.box.rug     .sbar-fill { background:linear-gradient(90deg,#ff224444,#ff2244)!important; box-shadow:0 0 8px rgba(255,34,68,.6)!important; }

.sum { padding:8px 14px 0!important; font-size:9.5px!important; letter-spacing:.03em!important; font-family:'IBM Plex Mono',monospace!important; display:block!important; line-height:1.4!important; }
.box.safe    .sum { color:#3a9070!important; }
.box.caution .sum { color:#a89020!important; }
.box.danger  .sum { color:#cc5555!important; }
.box.rug     .sum { color:#cc4455!important; }

.sep { height:1px!important; margin:8px 14px!important; display:block!important; }
.box.safe    .sep { background:rgba(0,229,176,.08)!important; }
.box.caution .sep { background:rgba(245,208,0,.07)!important; }
.box.danger  .sep { background:rgba(255,95,95,.08)!important; }
.box.rug     .sep { background:rgba(255,34,68,.08)!important; }

.fl { padding:2px 14px 6px!important; display:block!important; }
.f {
  display:flex!important;
  align-items:flex-start!important;
  gap:8px!important;
  padding:6px 0!important;
  font-size:10.5px!important;
  line-height:1.5!important;
  font-family:'IBM Plex Mono',monospace!important;
  color:#888!important;
  background:none!important;
  border:none!important;
  border-bottom:none!important;
}
.f+.f { border-top:1px solid rgba(255,255,255,.03)!important; }
.ic {
  width:15px!important; height:15px!important; min-width:15px!important;
  border-radius:50%!important;
  display:flex!important;
  align-items:center!important;
  justify-content:center!important;
  font-size:7.5px!important;
  flex-shrink:0!important;
  margin-top:2px!important;
  font-family:'IBM Plex Mono',monospace!important;
  font-weight:700!important;
  border:none!important;
}
.ic.r { background:rgba(255,60,80,.15)!important; color:#ff5f5f!important; }
.ic.y { background:rgba(245,208,0,.12)!important; color:#f5d000!important; }
.ic.g { background:rgba(0,229,176,.1)!important;  color:#00e5b0!important; }
.f.cr .ft-txt { color:#e07070!important; }
.f.wr .ft-txt { color:#d4b040!important; }
.f.ok .ft-txt { color:#559970!important; }
.ft-txt { font-size:10.5px!important; line-height:1.5!important; font-family:'IBM Plex Mono',monospace!important; }

.ss { display:flex!important; margin:0 14px!important; border-radius:3px!important; overflow:hidden!important; }
.box.safe    .ss { background:#090b0a!important; border:1px solid rgba(0,229,176,.1)!important; }
.box.caution .ss { background:#0a0a08!important; border:1px solid rgba(245,208,0,.08)!important; }
.box.danger  .ss { background:#0a0909!important; border:1px solid rgba(255,95,95,.1)!important; }
.box.rug     .ss { background:#0a0808!important; border:1px solid rgba(255,34,68,.12)!important; }

.si { flex:1!important; text-align:center!important; padding:8px 2px!important; position:relative!important; display:block!important; }
.si+.si::before { content:''!important; position:absolute!important; left:0!important; top:20%!important; height:60%!important; width:1px!important; }
.box.safe    .si+.si::before { background:rgba(0,229,176,.1)!important; }
.box.caution .si+.si::before { background:rgba(245,208,0,.08)!important; }
.box.danger  .si+.si::before { background:rgba(255,95,95,.1)!important; }
.box.rug     .si+.si::before { background:rgba(255,34,68,.1)!important; }

.si span {
  display:block!important;
  font-size:8px!important;
  color:#777!important;
  letter-spacing:.12em!important;
  text-transform:uppercase!important;
  margin-bottom:3px!important;
  font-family:'IBM Plex Mono',monospace!important;
  font-weight:400!important;
  line-height:1!important;
}
.si b {
  font-size:11px!important;
  letter-spacing:.02em!important;
  font-weight:700!important;
  font-family:'IBM Plex Mono',monospace!important;
  display:block!important;
  line-height:1!important;
  background:none!important;
}
.si b.y { color:#00e5b0!important; text-shadow:0 0 8px rgba(0,229,176,.4)!important; }
.si b.n { color:#ff5f5f!important; text-shadow:0 0 8px rgba(255,95,95,.4)!important; }
.si b.w { color:#f5d000!important;  text-shadow:0 0 6px rgba(245,208,0,.4)!important; }

.fo { display:flex!important; margin:8px 14px 10px!important; gap:4px!important; }
.fo a {
  flex:1!important;
  display:block!important;
  padding:9px!important;
  font-size:8.5px!important;
  color:#aaa!important;
  letter-spacing:.1em!important;
  text-transform:uppercase!important;
  text-decoration:none!important;
  text-align:center!important;
  border-radius:2px!important;
  transition:.2s!important;
  font-family:'IBM Plex Mono',monospace!important;
  font-weight:400!important;
  line-height:1!important;
  position:relative!important;
  overflow:hidden!important;
  cursor:pointer!important;
  background:none!important;
}
.fo a::before {
  content:''!important;
  position:absolute!important; inset:0!important;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.04),transparent)!important;
  transform:translateX(-100%)!important;
  transition:transform .5s!important;
}
.fo a:hover::before { transform:translateX(100%)!important; }
.box.safe    .fo a { border:1px solid rgba(0,229,176,.12)!important; }
.box.caution .fo a { border:1px solid rgba(245,208,0,.1)!important; }
.box.danger  .fo a { border:1px solid rgba(255,95,95,.12)!important; }
.box.rug     .fo a { border:1px solid rgba(255,34,68,.15)!important; }
.fo a:hover { color:#fff!important; }
.fo a.warn  { color:#ff7070!important; }
.fo a.warn:hover { background:rgba(255,34,68,.05)!important; }

.scanning {
  display:flex!important;
  align-items:center!important;
  gap:8px!important;
  color:#777!important;
  font-size:12px!important;
  padding:12px 14px!important;
  font-family:'IBM Plex Mono',monospace!important;
  line-height:1!important;
}
.dot {
  display:inline-block!important;
  width:7px!important; height:7px!important;
  border-radius:50%!important;
  background:#444!important;
  animation:ant-pulse 1.2s infinite!important;
  flex-shrink:0!important;
}
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
  // Inline style as extra shield — prevents page CSS from overriding host before shadow attaches
  host.setAttribute("style",
    "all:initial;display:block;position:fixed;bottom:20px;right:20px;" +
    "z-index:2147483647;pointer-events:none;font-family:monospace"
  )
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
