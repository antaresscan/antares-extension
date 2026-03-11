import { useEffect, useRef, useState } from "react"
import type { PlasmoCSConfig, PlasmoGetStyle } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

export const getStyle: PlasmoGetStyle = () => {
  const style = document.createElement("style")
  style.textContent = ""
  return style
}

function extractCA(): string {
  const url = window.location.href
  const m1 = url.match(/dexscreener\.com\/[a-z]+\/([A-Za-z0-9]{32,50})/)
  if (m1) return m1[1]
  const m2 = url.match(/pump\.fun\/coin\/([A-Za-z0-9]{32,50})/)
  if (m2) return m2[1]
  const m3 = url.match(/bonk\.fun\/[^/]*\/([A-Za-z0-9]{32,50})/)
  if (m3) return m3[1]
  const m4 = url.match(/birdeye\.so\/token\/([A-Za-z0-9]{32,50})/)
  if (m4 && !url.includes("/bsc/")) return m4[1]
  const m5 = url.match(/photon-sol\.tinyastro\.io\/[a-z]+\/([A-Za-z0-9]{32,50})/)
  if (m5) return m5[1]
  const m6 = url.match(/gmgn\.ai\/sol\/token\/([A-Za-z0-9]{32,50})/)
  if (m6) return m6[1]
  const m7 = url.match(/axiom\.trade\/[a-z]+\/([A-Za-z0-9]{32,50})/)
  if (m7) return m7[1]
  const m8 = url.match(/bullx\.io.*address=([A-Za-z0-9]{32,50})/)
  if (m8) return m8[1]
  return ""
}

const API = "https://antares-seven-rouge.vercel.app/api/scan"

const C: Record<string, string> = {
  SAFE: "#22c55e", CAUTION: "#f97316",
  DANGER: "#ef4444", RUG: "#dc2626"
}

async function doScan(ca: string): Promise<any> {
  try {
    const res = await new Promise<any>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "SCAN", ca }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) reject(new Error("bg fail"))
        else resolve(r.data)
      })
    })
    return res
  } catch {
    const r = await fetch(API + "?ca=" + ca)
    if (!r.ok) throw new Error("fetch fail")
    return r.json()
  }
}

export default function AntaresOverlay() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [ca, setCa] = useState("")
  const lastUrlRef = useRef("")
  const lastCaRef = useRef("")
  const scanningRef = useRef(false)

  async function scan() {
    const found = extractCA()
    if (!found || found.length < 32) {
      setCa("")
      setData(null)
      setLoading(false)
      return
    }
    if (found === lastCaRef.current && !error) return
    lastCaRef.current = found
    setCa(found)
    setLoading(true)
    setData(null)
    setError(false)
    scanningRef.current = true
    try {
      const d = await doScan(found)
      setData(d)
      setError(false)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
      scanningRef.current = false
    }
  }

  useEffect(() => {
    scan()
    lastUrlRef.current = window.location.href
    const interval = setInterval(() => {
      const currentUrl = window.location.href
      if (currentUrl !== lastUrlRef.current) {
        lastUrlRef.current = currentUrl
        scan()
      }
    }, 1500)
    return () => clearInterval(interval)
  }, [])

  if (!ca) return <div style={{ display: "none" }}></div>
  const risk = data ? data.risk : ""
  const score = data ? data.score : "--"
  const color = C[risk] || "#6b7280"
  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20,
      zIndex: 2147483647, background: "#0a0a0a",
      border: "1px solid " + color, borderRadius: 10,
      padding: "12px 16px", fontFamily: "monospace",
      fontSize: 13, color: "#fff",
      boxShadow: "0 0 24px " + color + "44", minWidth: 210
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontWeight: "bold", color }}>ANTARES</span>
      </div>
      {loading ? <div style={{ color: "#888" }}>Scanning...</div> : null}
      {error && !loading ? <div style={{ color: "#ef4444" }}>API Error</div> : null}
      {data && !loading ? (
        <div>
          <div style={{ fontSize: 22, fontWeight: "bold", color, marginBottom: 4 }}>{risk}</div>
          <div style={{ color: "#aaa", fontSize: 12, marginBottom: 8 }}>
            Score : <strong style={{ color: "#fff" }}>{score}/1000</strong>
          </div>
          {(data.flags || []).slice(0, 3).map((f: any, i: number) => (
            <div key={i} style={{ fontSize: 11, color: "#888", marginBottom: 2 }}>{f.label || f}</div>
          ))}
          <a
            href={"https://antares-seven-rouge.vercel.app/token/" + ca}
            target="_blank" rel="noreferrer"
            style={{ display: "block", marginTop: 8, textAlign: "center",
              background: color, color: "#000", borderRadius: 6,
              padding: "4px 0", fontWeight: "bold", fontSize: 12,
              textDecoration: "none" }}>
            Full analysis
          </a>
        </div>
      ) : null}
    </div>
  )
}
