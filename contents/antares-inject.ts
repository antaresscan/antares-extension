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

const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g

const IGNORE = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
])

function findAddresses(): string[] {
  const found = new Set<string>()

  const urlMatches = window.location.href.match(SOL_ADDR) || []
  for (const m of urlMatches) found.add(m)

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent || ""
    if (text.length < 32) continue
    const matches = text.match(SOL_ADDR) || []
    for (const m of matches) found.add(m)
  }

  const els = document.querySelectorAll("[data-address],[data-token],[data-mint],[data-ca],[title],[aria-label]")
  for (const el of els) {
    for (const attr of ["data-address","data-token","data-mint","data-ca","title","aria-label"]) {
      const val = el.getAttribute(attr) || ""
      const matches = val.match(SOL_ADDR) || []
      for (const m of matches) found.add(m)
    }
  }

  const links = document.querySelectorAll("a[href]")
  for (const a of links) {
    const href = a.getAttribute("href") || ""
    const matches = href.match(SOL_ADDR) || []
    for (const m of matches) found.add(m)
  }

  return Array.from(found).filter(addr => {
    if (IGNORE.has(addr)) return false
    if (addr.length < 32 || addr.length > 44) return false
    if (/^[a-z]+$/.test(addr) && addr.length < 32) return false
    if (/^[A-Z]+$/.test(addr)) return false
    if (/^[0-9]+$/.test(addr)) return false
    return true
  })
}

function pickBestAddress(addrs: string[]): string {
  if (addrs.length === 0) return ""
  if (addrs.length === 1) return addrs[0]

  const pump = addrs.find(a => a.endsWith("pump"))
  if (pump) return pump

  const url = window.location.href
  const lowerUrl = addrs.find(a => url.includes(a) && /^[a-z0-9]+$/.test(a))
  if (lowerUrl) return lowerUrl

  const inUrl = addrs.find(a => url.includes(a))
  if (inUrl) return inUrl

  const mixedCase = addrs.find(a => /[A-Z]/.test(a) && /[a-z]/.test(a))
  if (mixedCase) return mixedCase

  return addrs[0]
}

// Check if current URL looks like a token page
function isTokenPage(): boolean {
  const url = window.location.href
  // DexScreener token/pair pages
  if (/dexscreener\.com\/solana\/[a-zA-Z0-9]{32,44}/.test(url)) return true
  // Pump.fun token page
  if (/pump\.fun\/[a-zA-Z0-9]{32,44}/.test(url)) return true
  // Birdeye token page
  if (/birdeye\.so\/token\/[a-zA-Z0-9]{32,44}/.test(url)) return true
  // Solscan
  if (/solscan\.io\/token\/[a-zA-Z0-9]{32,44}/.test(url)) return true
  // Generic: URL contains a Solana address anywhere in path
  const pathMatch = url.match(/\/([1-9A-HJ-NP-Za-km-z]{32,44})/)
  return !!pathMatch
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
  }, 300)
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
    border: "1px solid #6b7280",
    borderRadius: "12px",
    padding: "12px 16px",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: "13px",
    color: "#fff",
    minWidth: "220px",
    maxWidth: "290px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    display: "none",
    transition: "opacity 0.25s ease, transform 0.25s ease",
    opacity: "0",
    transform: "translateY(8px)"
  })
  document.body.appendChild(box)
  return box
}

function showBox(el: HTMLDivElement) {
  if (hideTimeout) clearTimeout(hideTimeout)
  el.style.display = "block"
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.opacity = "1"
      el.style.transform = "translateY(0)"
    })
  })
}

function attachCloseBtn() {
  const btn = document.getElementById("antares-close")
  if (btn) btn.onclick = () => {
    manuallyDismissed = true
    hideBox()
  }
}

async function scan(ca: string) {
  // No token found in page — hide and reset
  if (!ca || ca.length < 32) {
    hideBox()
    lastCA = ""
    manuallyDismissed = false
    return
  }

  // Same token still visible and not dismissed — don't re-render
  if (ca === lastCA && box && box.style.display !== "none") return

  // New token — reset dismissed flag and scan fresh
  if (ca !== lastCA) {
    manuallyDismissed = false
    lastCA = ca
  }

  if (manuallyDismissed) return

  const el = ensureBox()
  showBox(el)
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-weight:700;font-size:12px;letter-spacing:2px;color:#6b7280">ANTARES</span>
      <span id="antares-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">&times;</span>
    </div>
    <div style="color:#555;font-size:11px;margin-bottom:6px">${ca.slice(0,4)}&hellip;${ca.slice(-4)}</div>
    <div style="color:#888;font-size:12px;display:flex;align-items:center;gap:6px">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#6b7280;animation:antares-pulse 1s infinite"></span>
      Scanning&hellip;
    </div>
    <style>@keyframes antares-pulse{0%,100%{opacity:1}50%{opacity:.3}}</style>
  `
  attachCloseBtn()

  try {
    const res = await fetch(`${API}?ca=${ca}`)
    if (!res.ok) throw new Error("API " + res.status)
    const data = await res.json()

    // If URL changed while fetching, discard stale result
    if (lastCA !== ca) return

    const color = COLORS[data.risk] || "#6b7280"
    const flags = (data.flags || []).slice(0, 3).map((f: any) =>
      `<div style="font-size:11px;color:#666;margin-top:3px;padding-left:8px;border-left:2px solid ${color}44">${f.label || f}</div>`
    ).join("")

    el.style.border = `1px solid ${color}88`
    el.style.boxShadow = `0 8px 32px rgba(0,0,0,0.6), 0 0 16px ${color}22`
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-weight:700;font-size:12px;letter-spacing:2px;color:${color}">ANTARES</span>
        <span id="antares-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">&times;</span>
      </div>
      <div style="font-size:26px;font-weight:800;color:${color};margin-bottom:2px;letter-spacing:1px">${data.risk}</div>
      <div style="color:#aaa;font-size:12px;margin-bottom:2px">Score <strong style="color:#fff">${data.score}</strong><span style="color:#555">/1000</span></div>
      <div style="color:#444;font-size:10px;margin-bottom:8px">${ca.slice(0,4)}&hellip;${ca.slice(-4)}</div>
      ${flags}
    `
    attachCloseBtn()
  } catch (e) {
    if (lastCA !== ca) return
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <span style="font-weight:700;font-size:12px;letter-spacing:2px;color:#6b7280">ANTARES</span>
        <span id="antares-close" style="cursor:pointer;color:#555;font-size:18px;line-height:1">&times;</span>
      </div>
      <div style="color:#ef4444;font-size:12px">API Error — retry in a moment</div>
    `
    attachCloseBtn()
  }
}

function poll() {
  const addrs = findAddresses()
  const best = pickBestAddress(addrs)

  // If no token address found anywhere on current page, hide overlay
  if (!best) {
    if (lastCA) {
      lastCA = ""
      manuallyDismissed = false
      hideBox()
    }
    return
  }

  scan(best)
}

// Initial poll
poll()

// Poll every 1.5s for smooth SPA experience
setInterval(poll, 1500)

// Watch for URL/DOM changes — handles SPA pushState navigation
let lastUrl = window.location.href
const urlObserver = new MutationObserver(() => {
  const currentUrl = window.location.href
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl
    // Reset immediately on navigation
    const prevCA = lastCA
    lastCA = ""
    manuallyDismissed = false
    // If we left a token page, hide immediately
    if (!isTokenPage()) {
      hideBox()
    } else {
      // New token page — poll right away
      poll()
    }
  }
})
urlObserver.observe(document.body, { childList: true, subtree: true })
