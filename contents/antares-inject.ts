import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API = "https://antares-extension.vercel.app/api/scan"

const COLORS: Record<string, string> = {
  SAFE: "#22c55e",
  CAUTION: "#f97316",
  DANGER: "#ef4444",
  RUG: "#dc2626"
}

// Base58 Solana address in URL path/query (32-44 chars)
const SOL_ADDR = /[1-9A-HJ-NP-Za-km-z]{32,44}/g

const IGNORE = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
])

function isValidAddr(addr: string): boolean {
  if (!addr || addr.length < 32 || addr.length > 44) return false
  if (IGNORE.has(addr)) return false
  if (/^[A-Z]+$/.test(addr)) return false
  if (/^[0-9]+$/.test(addr)) return false
  return true
}

// Extract the token address ONLY from the current URL path/query.
// Returns empty string if the current page is not a single-token page.
function getAddressFromUrl(): string {
  const url = window.location.href
  // Extract all candidate addresses from the URL path
  const raw = url.match(SOL_ADDR) || []
  const candidates = raw.filter(isValidAddr)
  if (candidates.length === 0) return ""

  // Prefer pump addresses
  const pump = candidates.find(a => a.endsWith("pump"))
  if (pump) return pump

  // Prefer lowercase (DexScreener pair address — backend resolves to mint)
  const lower = candidates.find(a => /^[a-z0-9]+$/.test(a))
  if (lower) return lower

  // Prefer mixed-case Base58
  const mixed = candidates.find(a => /[A-Z]/.test(a) && /[a-z]/.test(a))
  if (mixed) return mixed

  return candidates[0]
}

// Only used as extra signal when URL already confirms we're on a token page.
// Looks for mixed-case version of the address (real mint) in DOM attributes.
function findMixedCaseInDom(pairAddr: string): string {
  // If the URL already has a mixed-case address, just use it
  if (/[A-Z]/.test(pairAddr) && /[a-z]/.test(pairAddr)) return pairAddr

  // Look for mixed-case variant in data attributes (DexScreener renders mint in DOM)
  const attrs = ["data-address","data-token","data-mint","data-ca"]
  const els = document.querySelectorAll(attrs.map(a => `[${a}]`).join(","))
  for (const el of els) {
    for (const attr of attrs) {
      const val = el.getAttribute(attr) || ""
      const matches = val.match(SOL_ADDR) || []
      for (const m of matches) {
        if (isValidAddr(m) && /[A-Z]/.test(m) && /[a-z]/.test(m)) return m
      }
    }
  }
  return pairAddr
}

let lastCA = ""
let box: HTMLDivElement | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null
let manuallyDismissed = false

function hideBox() {
  if (!box) return
  box.style.opacity = "0"
  box.style.transform = "translateY(8px)"
  if (hideTimeout) clearTimeout(hideTimeout)
  hideTimeout = setTimeout(() => {
    if (box) box.style.display = "none"
  }, 280)
}

function ensureBox(): HTMLDivElement {
  if (box && document.body.contains(box)) return box
  box = document.createElement("div")
  box.id = "antares-overlay-box"
  Object.assign(box.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "2147483647",
    background: "#0d0d0d",
    border: "1px solid #333",
    borderRadius: "12px",
    padding: "12px 16px",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: "13px",
    color: "#fff",
    minWidth: "220px",
    maxWidth: "290px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
    display: "none",
    transition: "opacity 0.22s ease, transform 0.22s ease",
    opacity: "0",
    transform: "translateY(8px)"
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

function headerHtml(color: string) {
  return `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-weight:700;font-size:11px;letter-spacing:2.5px;color:${color}">ANTARES</span><span id="antares-close" style="cursor:pointer;color:#444;font-size:18px;line-height:1">&times;</span></div>`
}

async function scan(ca: string) {
  if (!ca) {
    hideBox()
    lastCA = ""
    manuallyDismissed = false
    return
  }

  // Same token already displayed — nothing to do
  if (ca === lastCA && box && box.style.display !== "none") return

  // New token — always reset dismissed
  if (ca !== lastCA) {
    manuallyDismissed = false
    lastCA = ca
  }

  if (manuallyDismissed) return

  const el = ensureBox()
  showBox(el)
  el.innerHTML = headerHtml("#6b7280") + `
    <div style="color:#444;font-size:10px;margin-bottom:8px">${ca.slice(0,4)}&hellip;${ca.slice(-4)}</div>
    <div style="color:#666;font-size:12px;display:flex;align-items:center;gap:6px">
      <span style="width:7px;height:7px;border-radius:50%;background:#6b7280;display:inline-block;animation:ap 1s infinite"></span>Scanning&hellip;
    </div>
    <style>@keyframes ap{0%,100%{opacity:1}50%{opacity:.25}}</style>
  `
  attachClose()

  try {
    const res = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("" + res.status)
    const data = await res.json()
    if (lastCA !== ca) return // stale

    const color = COLORS[data.risk] || "#6b7280"
    const flags = (data.flags || []).slice(0, 4).map((f: any) =>
      `<div style="font-size:11px;color:#555;margin-top:4px;padding-left:8px;border-left:2px solid ${color}55">${f.label || f}</div>`
    ).join("")

    el.style.border = `1px solid ${color}66`
    el.style.boxShadow = `0 8px 32px rgba(0,0,0,0.7), 0 0 20px ${color}18`
    el.innerHTML = headerHtml(color) + `
      <div style="font-size:28px;font-weight:800;color:${color};letter-spacing:1px;margin-bottom:2px">${data.risk}</div>
      <div style="color:#888;font-size:12px;margin-bottom:2px">Score <strong style="color:#ddd">${data.score}</strong><span style="color:#444">/1000</span></div>
      <div style="color:#333;font-size:10px;margin-bottom:6px">${ca.slice(0,4)}&hellip;${ca.slice(-4)}</div>
      ${flags}
    `
    attachClose()
  } catch (e) {
    if (lastCA !== ca) return
    el.innerHTML = headerHtml("#6b7280") + `<div style="color:#ef4444;font-size:12px">API Error</div>`
    attachClose()
  }
}

function poll() {
  // Source of truth: URL only.
  // If no Solana address in current URL path → hide immediately.
  const urlCA = getAddressFromUrl()

  if (!urlCA) {
    if (lastCA !== "") {
      lastCA = ""
      manuallyDismissed = false
      hideBox()
    }
    return
  }

  // We're on a token page — try to get mixed-case mint from DOM if available
  const ca = findMixedCaseInDom(urlCA)
  scan(ca)
}

poll()
setInterval(poll, 1500)

// SPA navigation detection
let lastUrl = window.location.href
new MutationObserver(() => {
  const cur = window.location.href
  if (cur === lastUrl) return
  lastUrl = cur
  lastCA = ""
  manuallyDismissed = false
  poll()
}).observe(document.documentElement, { childList: true, subtree: true })
