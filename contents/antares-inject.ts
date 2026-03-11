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
  const patterns: RegExp[] = [
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
    if (m && m[1]) return m[1]
  }
  return ""
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
    boxShadow: "0 0 24px #6b728044",
    display: "none"
  })
  document.body.appendChild(box)
  return box
}

async function scan(ca: string) {
  if (!ca || ca.length < 32) {
    if (box) box.style.display = "none"
    return
  }
  if (ca === lastCA && box && box.style.display !== "none") return
  lastCA = ca
  const el = ensureBox()
  el.style.display = "block"
  el.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="font-weight:bold;color:#6b7280">ANTARES</span></div><div style="color:#888">Scanning...</div>'
  try {
    const res = await fetch(API + "?ca=" + ca)
    if (!res.ok) throw new Error("API error")
    const data = await res.json()
    const color = COLORS[data.risk] || "#6b7280"
    const flags = (data.flags || []).slice(0, 3).map((f: any) =>
      '<div style="font-size:11px;color:#888;margin-bottom:2px">' + (f.label || f) + '</div>'
    ).join("")
    el.style.border = "1px solid " + color
    el.style.boxShadow = "0 0 24px " + color + "44"
    el.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="font-weight:bold;color:' + color + '">ANTARES</span></div>'
      + '<div style="font-size:22px;font-weight:bold;color:' + color + ';margin-bottom:4px">' + data.risk + '</div>'
      + '<div style="color:#aaa;font-size:12px;margin-bottom:8px">Score : <strong style="color:#fff">' + data.score + '/1000</strong></div>'
      + flags
      + '<a href="https://antares-seven-rouge.vercel.app/token/' + ca + '" target="_blank" rel="noreferrer" style="display:block;margin-top:8px;text-align:center;background:' + color + ';color:#000;border-radius:6px;padding:4px 0;font-weight:bold;font-size:12px;text-decoration:none">Full analysis</a>'
  } catch (e) {
    el.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="font-weight:bold;color:#6b7280">ANTARES</span></div><div style="color:#ef4444">API Error</div>'
  }
}

function poll() {
  const ca = extractCA()
  scan(ca)
}

poll()
setInterval(poll, 2000)
