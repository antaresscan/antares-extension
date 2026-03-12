import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API = "https://antares-extension.vercel.app/api/scan"
const CACHE_TTL = 60_000 // 60s cache per CA

const COLORS: Record<string, string> = {
  SAFE: "#22c55e",
  CAUTION: "#f97316",
  DANGER: "#ef4444",
  RUG: "#dc2626"
}

const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g

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

function isValid(addr: string): boolean {
  if (addr.length < 32 || addr.length > 44) return false
  if (IGNORE.has(addr)) return false
  if (/^[A-Z]+$/.test(addr)) return false
  if (/^[0-9]+$/.test(addr)) return false
  return true
}

function urlHasTokenAddress(): string {
  const path = window.location.pathname + window.location.search
  const matches = path.match(SOL_ADDR) || []
  const valid = matches.filter(isValid)
  if (valid.length === 0) return ""
  return valid.find(a => a.endsWith("pump"))
    || valid.find(a => /[A-Z]/.test(a) && /[a-z]/.test(a))
    || valid[0]
}

function findBestAddress(): string {
  const urlAddr = urlHasTokenAddress()
  if (!urlAddr) return ""

  const scores = new Map<string, number>()
  const url = window.location.href

  const add = (addr: string, pts: number) => {
    if (!isValid(addr)) return
    scores.set(addr, (scores.get(addr) || 0) + pts)
  }

  for (const el of document.querySelectorAll(
    "[data-address],[data-token],[data-mint],[data-ca],[data-contract],[data-token-address],[data-mint-address]"
  )) {
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

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = (node.textContent || "").trim()
    if (t.length >= 32 && t.length <= 50) {
      for (const m of (t.match(SOL_ADDR) || [])) add(m, 120)
    }
  }

  for (const m of (url.match(SOL_ADDR) || [])) add(m, 60)

  if (scores.size === 0) return urlAddr

  for (const [addr, s] of scores) {
    if (addr.endsWith("pump")) scores.set(addr, s + 100)
    if (/[A-Z]/.test(addr) && /[a-z]/.test(addr)) scores.set(addr, (scores.get(addr) || 0) + 30)
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

// ── Cache ──────────────────────────────────────────────────────────────────
function getCached(ca: string): any | null {
  try {
    const raw = localStorage.getItem(`antares_${ca}`)
    if (!raw) return null
    const { data, ts } = JSON.parse(raw)
    if (Date.now() - ts > CACHE_TTL) { localStorage.removeItem(`antares_${ca}`); return null; }
    return data
  } catch { return null }
}

function setCache(ca: string, data: any) {
  try { localStorage.setItem(`antares_${ca}`, JSON.stringify({ data, ts: Date.now() })) } catch {}
}

// ── State ──────────────────────────────────────────────────────────────────
let lastCA = ""
let box: HTMLDivElement | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null
let manuallyDismissed = false
let scanInFlight = false
let detailOpen = false

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
  detailOpen = false
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
    maxWidth: "310px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.8)",
    display: "none",
    transition: "opacity 0.22s ease, transform 0.22s ease",
    opacity: "0",
    transform: "translateY(10px)",
    userSelect: "none"
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
  if (btn) btn.onclick = (e) => { e.stopPropagation(); manuallyDismissed = true; hideBox() }
}

function scoreBar(score: number, color: string): string {
  const pct = Math.round(score / 10)
  return `
    <div style="margin:6px 0 8px;height:4px;border-radius:2px;background:#1a1a1a;overflow:hidden;cursor:pointer" id="antares-score-bar">
      <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,${color}88,${color});border-radius:2px;transition:width 0.4s ease"></div>
    </div>
  `
}

function renderResult(el: HTMLDivElement, data: any, ca: string) {
  const color = COLORS[data.risk] || "#6b7280"
  const displayCA = data.resolvedMint || ca
  const symbol = data.tokenSymbol ? `<span style="color:#888;font-size:11px;margin-left:6px">${data.tokenSymbol}</span>` : ""
  const honey = data.honeypotConfirmed
    ? `<div style="color:#dc2626;font-size:10px;font-weight:700;letter-spacing:1px;animation:antblink 0.8s infinite">⚠ HONEYPOT CONFIRMED</div>` : ""
  const conf = data.confidence < 50
    ? `<div style="color:#555;font-size:10px;margin-top:4px">⚠ Low confidence (${data.confidence}%)</div>` : ""

  const allFlags = (data.flags || []).filter((f: any) => f.severity !== "bonus")
  const bonuses = (data.flags || []).filter((f: any) => f.severity === "bonus")
  const visibleFlags = allFlags.slice(0, 6)
  const hiddenFlags = allFlags.slice(6)

  const renderFlag = (f: any) => {
    const fc = f.severity === "critical" ? "#ef4444" : f.severity === "warning" ? "#f97316" : "#6b7280"
    return `<div style="font-size:11px;color:#666;margin-top:4px;padding-left:8px;border-left:2px solid ${fc}55">${f.label}</div>`
  }

  const bonusHtml = bonuses.map((f: any) =>
    `<div style="font-size:11px;color:#22c55e;margin-top:3px;padding-left:8px;border-left:2px solid #22c55e55">${f.label}</div>`
  ).join("")

  const hiddenHtml = hiddenFlags.length > 0
    ? `<div id="antares-more" style="display:none">${hiddenFlags.map(renderFlag).join("")}</div>
       <div id="antares-toggle" style="color:#555;font-size:10px;margin-top:6px;cursor:pointer">▼ ${hiddenFlags.length} more flags</div>`
    : ""

  el.style.border = `1px solid ${color}66`
  el.style.boxShadow = `0 8px 32px rgba(0,0,0,0.8),0 0 20px ${color}18`
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-weight:700;font-size:11px;letter-spacing:2.5px;color:${color}">ANTARES${symbol}</span>
      <span id="antares-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">&times;</span>
    </div>
    ${honey}
    <div style="font-size:28px;font-weight:800;color:${color};letter-spacing:1px;margin-bottom:2px;cursor:pointer" id="antares-risk">${data.risk}</div>
    <div style="color:#888;font-size:12px;margin-bottom:2px">Score <strong style="color:#ddd">${data.score}</strong><span style="color:#444">/1000</span></div>
    ${scoreBar(data.score, color)}
    <div style="color:#333;font-size:10px;margin-bottom:6px">${displayCA.slice(0,4)}&hellip;${displayCA.slice(-4)}</div>
    ${visibleFlags.map(renderFlag).join("")}
    ${bonusHtml}
    ${hiddenHtml}
    ${conf}
    <style>
      @keyframes antblink{0%,100%{opacity:1}50%{opacity:0.2}}
    </style>
  `
  attachClose()

  const toggle = document.getElementById("antares-toggle")
  const more = document.getElementById("antares-more")
  if (toggle && more) {
    toggle.onclick = () => {
      detailOpen = !detailOpen
      more.style.display = detailOpen ? "block" : "none"
      toggle.textContent = detailOpen ? `▲ hide` : `▼ ${hiddenFlags.length} more flags`
    }
  }
}

async function scan(ca: string) {
  if (!ca) return
  if (ca === lastCA && box && box.style.display !== "none") return
  if (manuallyDismissed && ca === lastCA) return
  if (scanInFlight) return

  if (ca !== lastCA) {
    manuallyDismissed = false
    detailOpen = false
    lastCA = ca
  }

  // Check cache first
  const cached = getCached(ca)
  if (cached) {
    const el = ensureBox()
    showBox(el)
    renderResult(el, cached, ca)
    return
  }

  scanInFlight = true
  const el = ensureBox()
  showBox(el)
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-weight:700;font-size:11px;letter-spacing:2.5px;color:#6b7280">ANTARES</span>
      <span id="antares-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">&times;</span>
    </div>
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
    setCache(ca, data)
    renderResult(el, data, ca)
  } catch (e) {
    if (lastCA !== ca) { scanInFlight = false; return }
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-weight:700;font-size:11px;letter-spacing:2.5px;color:#6b7280">ANTARES</span>
        <span id="antares-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">&times;</span>
      </div>
      <div style="color:#ef4444;font-size:12px">API Error — retry in a moment</div>
    `
    attachClose()
  }
  scanInFlight = false
}

function poll() {
  const ca = findBestAddress()
  if (!ca) {
    if (lastCA) resetState()
    return
  }
  scan(ca)
}

poll()
setInterval(poll, 1500)

const onNav = () => { resetState(); setTimeout(poll, 400) }

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
