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

// Base58 Solana address pattern (32-44 chars, no 0/O/I/l)
const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g

// Known non-address strings to ignore
const IGNORE = new Set([
  "11111111111111111111111111111111",
  "So11111111111111111111111111111112",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
])

// Scan the entire page DOM + URL for Solana addresses
function findAddresses(): string[] {
  const found = new Set<string>()

  // 1) Scan URL (path + query)
  const urlMatches = window.location.href.match(SOL_ADDR) || []
  for (const m of urlMatches) found.add(m)

  // 2) Scan visible text on page
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  )
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent || ""
    if (text.length < 32) continue
    const matches = text.match(SOL_ADDR) || []
    for (const m of matches) found.add(m)
  }

  // 3) Scan clipboard-copy buttons, data attributes, title, aria-label
  const els = document.querySelectorAll("[data-address],[data-token],[data-mint],[data-ca],[title],[aria-label]")
  for (const el of els) {
    for (const attr of ["data-address","data-token","data-mint","data-ca","title","aria-label"]) {
      const val = el.getAttribute(attr) || ""
      const matches = val.match(SOL_ADDR) || []
      for (const m of matches) found.add(m)
    }
  }

  // 4) Scan <a> href attributes
  const links = document.querySelectorAll("a[href]")
  for (const a of links) {
    const href = a.getAttribute("href") || ""
    const matches = href.match(SOL_ADDR) || []
    for (const m of matches) found.add(m)
  }

  // Filter out known system addresses and short/long noise
  return Array.from(found).filter(addr => {
    if (IGNORE.has(addr)) return false
    if (addr.length < 32 || addr.length > 44) return false
    // Filter short lowercase words, but keep 32+ char lowercase (Solana pair addresses)
    if (/^[a-z]+$/.test(addr) && addr.length < 32) return false
    if (/^[A-Z]+$/.test(addr)) return false // all uppercase = probably a label
    if (/^[0-9]+$/.test(addr)) return false // all digits = number
    return true
  })
}

// Pick the most likely token address from candidates
function pickBestAddress(addrs: string[]): string {
  if (addrs.length === 0) return ""
  if (addrs.length === 1) return addrs[0]

  // Prefer addresses ending in "pump" (pump.fun tokens)
  const pump = addrs.find(a => a.endsWith("pump"))
  if (pump) return pump

  const url = window.location.href

  // Prefer lowercase/alnum addresses found in URL first:
  // on DexScreener this can be a pair address — the backend resolves pair -> mint
  const lowerUrl = addrs.find(a => url.includes(a) && /^[a-z0-9]+$/.test(a))
  if (lowerUrl) return lowerUrl

  // Then prefer any address found in URL
  const inUrl = addrs.find(a => url.includes(a))
  if (inUrl) return inUrl

  // Prefer mixed case (real Base58) over generic DOM noise
  const mixedCase = addrs.find(a => /[A-Z]/.test(a) && /[a-z]/.test(a))
  if (mixedCase) return mixedCase

  return addrs[0]
}

let lastCA = ""
let box: HTMLDivElement | null = null

function ensureBox(): HTMLDivElement {
  if (box && document.body.contains(box)) return box
  box = document.createElement("div")
  box.id = "antares-overlay-box"
  Object.assign(box.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "2147483647",
    background: "#0a0a0a",
    border: "1px solid #6b7280",
    borderRadius: "10px",
    padding: "12px 16px",
    fontFamily: "monospace",
    fontSize: "13px",
    color: "#fff",
    minWidth: "210px",
    maxWidth: "280px",
    boxShadow: "0 0 24px #6b728044",
    display: "none",
    transition: "opacity 0.3s ease",
    opacity: "0"
  })
  document.body.appendChild(box)
  return box
}

function showBox(el: HTMLDivElement) {
  el.style.display = "block"
  requestAnimationFrame(() => { el.style.opacity = "1" })
}

async function scan(ca: string) {
  if (!ca || ca.length < 32) {
    if (box) { box.style.opacity = "0"; setTimeout(() => { if (box) box.style.display = "none" }, 300) }
    return
  }
  if (ca === lastCA && box && box.style.display !== "none") return
  lastCA = ca

  const el = ensureBox()
  showBox(el)
  el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-weight:bold;color:#6b7280">ANTARES</span><span style="cursor:pointer;color:#555;font-size:16px" id="antares-close">&times;</span></div><div style="color:#888">Scanning...</div>'

  const closeBtn = document.getElementById("antares-close")
  if (closeBtn) closeBtn.onclick = () => { if (box) { box.style.opacity = "0"; setTimeout(() => { if (box) box.style.display = "none" }, 300) } }

  try {
    const res = await fetch(API + "?ca=" + ca)
    if (!res.ok) throw new Error("API " + res.status)
    const data = await res.json()
    const color = COLORS[data.risk] || "#6b7280"
    const flags = (data.flags || []).slice(0, 3).map((f: any) =>
      '<div style="font-size:11px;color:#888;margin-bottom:2px">' + (f.label || f) + '</div>'
    ).join("")

    const shortCa = ca.slice(0, 4) + "..." + ca.slice(-4)
    el.style.border = "1px solid " + color
    el.style.boxShadow = "0 0 24px " + color + "44"
    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-weight:bold;color:' + color + '">ANTARES</span><span style="cursor:pointer;color:#555;font-size:16px" id="antares-close">&times;</span></div>'
      + '<div style="font-size:22px;font-weight:bold;color:' + color + ';margin-bottom:4px">' + data.risk + '</div>'
      + '<div style="color:#aaa;font-size:12px;margin-bottom:4px">Score : <strong style="color:#fff">' + data.score + '/1000</strong></div>'
      + '<div style="color:#555;font-size:10px;margin-bottom:8px">' + shortCa + '</div>'
      + flags

    const closeBtn2 = document.getElementById("antares-close")
    if (closeBtn2) closeBtn2.onclick = () => { if (box) { box.style.opacity = "0"; setTimeout(() => { if (box) box.style.display = "none" }, 300) } }
  } catch (e) {
    el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-weight:bold;color:#6b7280">ANTARES</span><span style="cursor:pointer;color:#555;font-size:16px" id="antares-close">&times;</span></div><div style="color:#ef4444">API Error</div>'
    const closeBtn3 = document.getElementById("antares-close")
    if (closeBtn3) closeBtn3.onclick = () => { if (box) { box.style.opacity = "0"; setTimeout(() => { if (box) box.style.display = "none" }, 300) } }
  }
}

function poll() {
  const addrs = findAddresses()
  const best = pickBestAddress(addrs)
  scan(best)
}

// Run immediately + poll every 2s (handles SPA navigation)
poll()
setInterval(poll, 2000)

// Also watch for URL changes (SPA pushState)
let lastUrl = window.location.href
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href
    lastCA = ""
    poll()
  }
})
urlObserver.observe(document.body, { childList: true, subtree: true })
