import { useEffect, useState } from "react"
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

const C: Record<string, string> = {
  SAFE: "#22c55e", CAUTION: "#f97316",
  DANGER: "#ef4444", RUG: "#dc2626"
}

function doScan(ca: string, cb: (d: any) => void, err: () => void) {
  try {
    chrome.runtime.sendMessage({ type: "SCAN", ca: ca }, function(res) {
      if (chrome.runtime.lastError || !res || !res.ok) { err(); return }
      cb(res.data)
    })
  } catch(e) { err() }
}

export default function AntaresOverlay() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [ca, setCa] = useState("")
  const [lastUrl, setLastUrl] = useState("")

  function scan() {
    var found = extractCA()
    if (!found || found.length < 32) {
      setCa("")
      setData(null)
      setLoading(false)
      return
    }
    setCa(found)
    setLoading(true)
    setData(null)
    setError(false)
    doScan(found, function(d) {
      setData(d)
      setLoading(false)
    }, function() {
      setError(true)
      setLoading(false)
    })
  }

  useEffect(function() {
    scan()
    setLastUrl(window.location.href)
    var interval = setInterval(function() {
      var currentUrl = window.location.href
      if (currentUrl !== lastUrl) {
        setLastUrl(currentUrl)
        scan()
      }
    }, 1000)
    return function() { clearInterval(interval) }
  }, [])

  if (!ca) return <div style={{ display: "none" }}></div>

  var risk = data ? data.risk : ""
  var score = data ? data.score : "--"
  var color = C[risk] || "#6b7280"

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
        <span style={{ fontWeight: "bold", color: color }}>ANTARES</span>
      </div>
      {loading ? <div style={{ color: "#888" }}>Scanning...</div> : null}
      {error && !loading ? <div style={{ color: "#ef4444" }}>API Error</div> : null}
      {data && !loading ? (
        <div>
          <div style={{ fontSize: 22, fontWeight: "bold", color: color, marginBottom: 4 }}>{risk}</div>
          <div style={{ color: "#aaa", fontSize: 12, marginBottom: 8 }}>
            Score : <strong style={{ color: "#fff" }}>{score}/1000</strong>
          </div>
          {(data.flags || []).slice(0, 3).map(function(f: any, i: number) {
            return <div key={i} style={{ fontSize: 11, color: "#888", marginBottom: 2 }}>{f.label || f}</div>
          })}
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
