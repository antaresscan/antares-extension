import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API = "https://antares-extension.vercel.app/api/scan"
const ANALYSIS_PAGE = "https://antares-extension.vercel.app/token.html"
const LS_PREFIX = "antares_scan_"
const LS_TTL = 90_000

const COLORS: Record<string, string> = {
  SAFE: "#22c55e",
  CAUTION: "#f97316",
  DANGER: "#ef4444",
  RUG: "#dc2626"
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

function getCached(ca: string): any | null {
  const e = scanCache.get(ca)
  if (!e) return null
  if (Date.now() - e.ts > CACHE_TTL) { scanCache.delete(ca); return null }
  return e.data
}

function saveToLS(ca: string, data: any) {
  try {
    localStorage.setItem(LS_PREFIX + ca, JSON.stringify({ data, ts: Date.now() }))
  } catch(_) {}
}

function formatMcap(mc: number): string {
  if (mc >= 1_000_000_000) return `$${(mc / 1_000_000_000).toFixed(2)}B`
  if (mc >= 1_000_000) return `$${(mc / 1_000_000).toFixed(2)}M`
  if (mc >= 1_000) return `$${(mc / 1_000).toFixed(1)}K`
  return `$${mc.toFixed(0)}`
}

function buildResult(data: any, ca: string): string {
  const color = COLORS[data.risk] || "#6b7280"
  const displayCA = data.resolvedMint || ca
  const mint = data.resolvedMint || ca
  const flags = (data.flags || [])
    .filter((f: any) => !((f.label || f) as string).toLowerCase().includes("unavailable"))
    .slice(0, 4)
    .map((f: any) =>
      `<div style="font-size:11px;color:#666;margin-top:4px;padding-left:8px;border-left:2px solid ${color}55">${f.label || f}</div>`
    ).join("")
  const mc = data.pair?.marketCap || data.pair?.fdv
  const mcLine = mc ? `<div style="color:#888;font-size:11px;margin-bottom:2px">MCap <strong style="color:#ccc">${formatMcap(mc)}</strong></div>` : ""
  const analysisLink = `<div style="margin-top:8px;padding-top:6px;border-top:1px solid #1a1a1a"><a href="${ANALYSIS_PAGE}?ca=${mint}" target="_blank" rel="noopener noreferrer" style="color:${color};font-size:10px;text-decoration:none">&#8599; Full Analysis</a></div>`
  return header(color) + `
    <div style="font-size:28px;font-weight:800;color:${color};letter-spacing:1px;margin-bottom:2px">${data.risk}</div>
    ${mcLine}
    <div style="color:#333;font-size:10px;margin-bottom:6px">${displayCA.slice(0,4)}&hellip;${displayCA.slice(-4)}</div>
    ${flags}
    ${analysisLink}
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

  const add = (addr: string, pts: number) => {
    if (!isValid(addr)) return
    scores.set(addr, (scores.get(addr) || 0) + pts)
  }

  // Priority 1: data attributes
  for (const el of document.querySelectorAll(
    "[data-address],[data-token],[data-mint],[data-ca],[data-contract],[data-token-address],[data-mint-address]"
  )) {
    for (const attr of ["data-address","data-token","data-mint","data-ca","data-contract","data-token-address","data-mint-address"]) {
      for (const m of ((el.getAttribute(attr) || "").match(SOL_ADDR) || [])) add(m, 200)
    }
  }

  // Priority 2: explorer links
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || ""
    if (/solscan\.io\/token|solscan\.io\/address|explorer\.solana\.com\/address|solana\.fm\/address/.test(href)) {
      for (const m of (href.match(SOL_ADDR) || [])) add(m, 180)
    }
  }

  // Priority 3: URL itself (fast, no DOM walk needed)
  for (const m of (url.match(SOL_ADDR) || [])) add(m, 60)

  // Priority 4: TreeWalker capped at WALKER_LIMIT nodes
  if (scores.size === 0) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
    let node: Node | null
    let count = 0
    while ((node = walker.nextNode()) && count < WALKER_LIMIT) {
      count++
      const t = (node.textContent || "").trim()
      if (t.length >= 32 && t.length <= 50) {
        for (const m of (t.match(SOL_ADDR) || [])) add(m, 120)
      }
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
  lastCA = ""
  manuallyDismissed = false
  scanInFlight = false
  hideBox()
}

function ensureBox(): HTMLDivElement {
  if (box && document.body.contains(box)) return box
  box = document.createElement("div")
  box.id = "antares-box"
  Object.assign(box.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "2147483647",
    background: "#0d0d0d",
    border: "1px solid #333",
    borderRadius: "12px",
    padding: "12px 16px",
    fontFamily: "'SF Mono','Fira Code',monospace",
    fontSize: "13px",
    color: "#fff",
    minWidth: "220px",
    maxWidth: "290px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.8)",
    display: "none",
    transition: "opacity 0.22s ease, transform 0.22s ease",
    opacity: "0",
    transform: "translateY(10px)"
  })
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

function header(color: string) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-weight:700;font-size:11px;letter-spacing:2.5px;color:${color}">ANTARES</span><span id="antares-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">&times;</span></div>`
}

async function scan(ca: string) {
  if (!ca) return
  if (ca === lastCA && box && box.style.display !== "none") return
  if (manuallyDismissed && ca === lastCA) return
  if (scanInFlight) return

  if (ca !== lastCA) {
    manuallyDismissed = false
    lastCA = ca
  }

  const cached = getCached(ca)
  if (cached) {
    const el = ensureBox()
    const color = COLORS[cached.risk] || "#6b7280"
    el.style.border = `1px solid ${color}66`
    el.style.boxShadow = `0 8px 32px rgba(0,0,0,0.8),0 0 20px ${color}18`
    el.innerHTML = buildResult(cached, ca)
    showBox(el)
    attachClose()
    return
  }

  scanInFlight = true
  const el = ensureBox()
  showBox(el)
  el.innerHTML = header("#6b7280") + `
    <div style="color:#444;font-size:10px;margin-bottom:8px">${ca.slice(0,4)}&hellip;${ca.slice(-4)}</div>
    <div style="color:#666;font-size:12px;display:flex;align-items:center;gap:6px">
      <span style="width:7px;height:7px;border-radius:50%;background:#6b7280;display:inline-block;animation:ap 1s infinite"></span>Scanning&hellip;
    </div>
    <style>@keyframes ap{0%,100%{opacity:1}50%{opacity:.2}}</style>
  `
  attachClose()

  try {
    const res = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json()
    if (lastCA !== ca) { scanInFlight = false; return }

    scanCache.set(ca, { data, ts: Date.now() })
    saveToLS(ca, data)

    const color = COLORS[data.risk] || "#6b7280"
    el.style.border = `1px solid ${color}66`
    el.style.boxShadow = `0 8px 32px rgba(0,0,0,0.8),0 0 20px ${color}18`
    el.innerHTML = buildResult(data, ca)
    attachClose()
  } catch (e) {
    if (lastCA !== ca) { scanInFlight = false; return }
    el.innerHTML = header("#6b7280") + `<div style="color:#ef4444;font-size:12px">API Error</div>`
    attachClose()
  }
  scanInFlight = false
}

function poll() {
  const ca = findBestAddress()
  if (!ca) return
  scan(ca)
}

// Initial poll on page load
poll()
// Delayed retry for lazy-loaded pages
setTimeout(poll, 2000)

const onNav = () => {
  resetState()
  // Two polls after navigation: one fast, one delayed for lazy content
  setTimeout(poll, 400)
  setTimeout(poll, 2000)
}

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
