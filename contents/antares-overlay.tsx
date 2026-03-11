import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

const API = "https://antares-seven-rouge.vercel.app/api/scan"
const COLORS: Record<string, string> = {
  SAFE: "#22c55e",
  CAUTION: "#f97316",
  DANGER: "#ef4444",
  RUG: "#dc2626"
}

function extractCA(): string {
  const u = window.location.href
  const patterns = [
    /dexscreener\.com\/[a-z]+\/([A-Za-z0-9]{32,50})/,
    /pump\.fun\/coin\/([A-Za-z0-9]{32,50})/,
    /bonk\.fun\/[^/]*\/([A-Za-z0-9]{32,50})/,
    /birdeye\.so\/token\/([A-Za-z0-9]{32,50})/,
    /photon-sol\.tinyastro\.io\/[a-z]+\/([A-Za-z0-9]{32,50})/,
    /gmgn\.ai\/sol\/token\/([A-Za-z0-9]{32,50})/,
    /axiom\.trade\/[a-z]+\/([A-Za-z0-9]{32,50})/,
    /bullx\.io.*address=([A-Za-z0-9]{32,50})/
  ]
  for (const p of patterns) {
    const m = u.match(p)
    if (m) return m[1]
  }
  return ""
}

let lastCA = ""
let box: HTMLDivElement | null = null

async function scan(ca: string) {
  if (!ca || ca.length < 32) {
    if (box) box.style.display = "none"
    return
  }
  if (ca === lastCA && box && box.style.display !== "none") return
  lastCA = ca
  ensureBox()
  if (!box) return
  box.style.display = "block"
  box.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="font-weight:bold;color:#6b7280">ANTARES</span></div><div style="color:#888">Scanning...</div>`
  try {
    const res = await fetch(API + "?ca=" + ca)
    if (!res.ok) throw new Error("fail")
    const data = await res.json()
    const color = COLORS[data.risk] || "#6b7280"
    const flags = (data.flags || []).slice(0, 3).map((f: any) => `<div style="font-size:11px;color:#888;margin-bottom:2px">${f.label || f}</div>`).join("")
    box.style.border = "1px solid " + color
    box.style.boxShadow = "0 0 24px " + color + "44"
    box.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="font-weight:bold;color:${color}">ANTARES</span></div><div style="font-size:22px;font-weight:bold;color:${color};margin-bottom:4px">${data.risk}</div><div style="color:#aaa;font-size:12px;margin-bottom:8px">Score : <strong style="color:#fff">${data.score}/1000</strong></div>${flags}<a href="https://antares-seven-rouge.vercel.app/token/${ca}" target="_blank" rel="noreferrer" style="display:block;margin-top:8px;text-align:center;background:${color};color:#000;border-radius:6px;padding:4px 0;font-weight:bold;font-size:12px;text-decoration:none">Full analysis</a>`
  } catch {
    box.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="font-weight:bold;color:#6b7280">ANTARES</span></div><div style="color:#ef4444">API Error</div>`
  }
}

function ensureBox() {
  if (box && document.body.contains(box)) return
  box = document.createElement("div")
  box.id = "antares-overlay-box"
  box.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#0a0a0a;border:1px solid #6b7280;border-radius:10px;padding:12px 16px;font-family:monospace;font-size:13px;color:#fff;min-width:210px;box-shadow:0 0 24px #6b728044;display:none;"
  document.body.appendChild(box)
}

function poll() {
  const ca = extractCA()
  scan(ca)
}

poll()
setInterval(poll, 2000)

export default function AntaresOverlay() {
  return null
}
