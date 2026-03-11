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
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
  "TokenzQdBNbequAOoiqaLs8AA6CRCmvsembyniztzCFm",
])

function isValid(addr: string): boolean {
  if (addr.length < 32 || addr.length > 44) return false
  if (IGNORE.has(addr)) return false
  if (/^[A-Z]+$/.test(addr)) return false
  if (/^[0-9]+$/.test(addr)) return false
  return true
}

// Score an address — higher = more likely to be the token we want
function score(addr: string, url: string): number {
  let s = 0
  if (url.includes(addr)) s += 100          // in current URL
  if (addr.endsWith("pump")) s += 80         // pump.fun token
  if (/[A-Z]/.test(addr) && /[a-z]/.test(addr)) s += 40  // mixed case = real Base58 mint
  if (/^[a-z0-9]+$/.test(addr)) s += 20     // lowercase = likely pair addr, backend resolves
  return s
}

function findBestAddress(): string {
  const found = new Map<string, number>()
  const url = window.location.href

  const addToMap = (addr: string) => {
    if (!isValid(addr)) return
    found.set(addr, (found.get(addr) || 0) + score(addr, url))
  }

  // URL
  for (const m of (url.match(SOL_ADDR) || [])) addToMap(m)

  // Data attributes (most reliable — apps store mint here)
  for (const el of document.querySelectorAll("[data-address],[data-token],[data-mint],[data-ca],[data-contract]")) {
    for (const attr of ["data-address","data-token","data-mint","data-ca","data-contract"]) {
      for (const m of ((el.getAttribute(attr) || "").match(SOL_ADDR) || [])) addToMap(m)
    }
  }

  // Visible text — only scan elements that look like address displays
  // (short text nodes containing only base58-like chars)
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = (node.textContent || "").trim()
    // Only process text that could be a standalone address (not a paragraph)
    if (t.length >= 32 && t.length <= 50) {
      for (const m of (t.match(SOL_ADDR) || [])) addToMap(m)
    }
  }

  // href links — token links on list pages contain the mint
  // BUT only pick hrefs that look like single-token URLs (contain /address or /token path)
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || ""
    if (!/\/token|\/address|\/pair|\/solana\/[1-9A-HJ]/.test(href)) continue
    for (const m of (href.match(SOL_ADDR) || [])) {
      if (isValid(m)) {
        // Only add if this link is "active" — visible in viewport or has active/selected class
        const rect = (a as HTMLElement).getBoundingClientRect()
        const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight
        const isActive = a.classList.contains("active") || a.getAttribute("aria-current") === "page"
        if (isActive) found.set(m, (found.get(m) || 0) + 200)
        else if (isVisible) found.set(m, (found.get(m) || 0) + 5)
      }
    }
  }

  if (found.size === 0) return ""

  // Return address with highest score
  return [...found.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

// State
let lastCA = ""
let missCount = 0
const MISS_THRESHOLD = 3  // hide after 3 polls with no address found
let box: HTMLDivElement | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null
let manuallyDismissed = false
let scanInFlight = false

function hideBox() {
  if (!box) return
  box.style.opacity = "0"
  box.style.transform = "translateY(10px)"
  if (hideTimeout) clearTimeout(hideTimeout)
  hideTimeout = setTimeout(() => { if (box) box.style.display = "none" }, 280)
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

  if (ca !== lastCA) {
    manuallyDismissed = false
    lastCA = ca
  }

  if (scanInFlight) return
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

    const color = COLORS[data.risk] || "#6b7280"
    const flags = (data.flags || []).slice(0, 4).map((f: any) =>
      `<div style="font-size:11px;color:#555;margin-top:4px;padding-left:8px;border-left:2px solid ${color}55">${f.label || f}</div>`
    ).join("")

    el.style.border = `1px solid ${color}66`
    el.style.boxShadow = `0 8px 32px rgba(0,0,0,0.8),0 0 20px ${color}18`
    el.innerHTML = header(color) + `
      <div style="font-size:28px;font-weight:800;color:${color};letter-spacing:1px;margin-bottom:2px">${data.risk}</div>
      <div style="color:#888;font-size:12px;margin-bottom:2px">Score <strong style="color:#ddd">${data.score}</strong><span style="color:#444">/1000</span></div>
      <div style="color:#333;font-size:10px;margin-bottom:6px">${ca.slice(0,4)}&hellip;${ca.slice(-4)}</div>
      ${flags}
    `
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

  if (!ca) {
    missCount++
    if (missCount >= MISS_THRESHOLD && lastCA !== "") {
      lastCA = ""
      manuallyDismissed = false
      hideBox()
    }
    return
  }

  // Found an address
  missCount = 0

  if (ca !== lastCA) {
    manuallyDismissed = false
  }

  scan(ca)
}

poll()
setInterval(poll, 1500)

// SPA navigation: reset miss counter and force re-poll immediately
let lastUrl = window.location.href
new MutationObserver(() => {
  const cur = window.location.href
  if (cur !== lastUrl) {
    lastUrl = cur
    missCount = 0
    lastCA = ""
    manuallyDismissed = false
    // Give SPA 300ms to render the new page before polling
    setTimeout(poll, 300)
  }
}).observe(document.documentElement, { childList: true, subtree: true })
