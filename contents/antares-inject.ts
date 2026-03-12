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

function findBestAddress(): string {
  const scores = new Map<string, number>()
  const url = window.location.href

  const add = (addr: string, pts: number) => {
    if (!isValid(addr)) return
    scores.set(addr, (scores.get(addr) || 0) + pts)
  }

  // 1. Data attributes
  for (const el of document.querySelectorAll(
    "[data-address],[data-token],[data-mint],[data-ca],[data-contract],[data-token-address],[data-mint-address]"
  )) {
    for (const attr of ["data-address","data-token","data-mint","data-ca","data-contract","data-token-address","data-mint-address"]) {
      for (const m of ((el.getAttribute(attr) || "").match(SOL_ADDR) || [])) add(m, 200)
    }
  }

  // 2. Solscan / explorer links
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") || ""
    if (/solscan\.io\/token|solscan\.io\/address|explorer\.solana\.com\/address|solana\.fm\/address/.test(href)) {
      for (const m of (href.match(SOL_ADDR) || [])) add(m, 180)
    }
  }

  // 3. Short standalone text nodes
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = (node.textContent || "").trim()
    if (t.length >= 32 && t.length <= 50) {
      for (const m of (t.match(SOL_ADDR) || [])) add(m, 120)
    }
  }

  // 4. URL
  for (const m of (url.match(SOL_ADDR) || [])) add(m, 60)

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
    const displayCA = data.resolvedMint || ca
    const flags = (data.flags || []).slice(0, 4).map((f: any) =>
      `<div style="font-size:11px;color:#555;margin-top:4px;padding-left:8px;border-left:2px solid ${color}55">${f.label || f}</div>`
    ).join("")

    el.style.border = `1px solid ${color}66`
    el.style.boxShadow = `0 8px 32px rgba(0,0,0,0.8),0 0 20px ${color}18`
    el.innerHTML = header(color) + `
      <div style="font-size:28px;font-weight:800;color:${color};letter-spacing:1px;margin-bottom:2px">${data.risk}</div>
      <div style="color:#888;font-size:12px;margin-bottom:2px">Score <strong style="color:#ddd">${data.score}</strong><span style="color:#444">/1000</span></div>
      <div style="color:#333;font-size:10px;margin-bottom:6px">${displayCA.slice(0,4)}&hellip;${displayCA.slice(-4)}</div>
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
  if (!ca) return
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
