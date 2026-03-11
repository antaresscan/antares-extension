import { useEffect, useState } from "react"
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle"
}

function extractCA(): string {
  const url = window.location.href
  const dexMatch = url.match(/dexscreener\.com\/solana\/([A-Za-z0-9]{32,44})/)
  if (dexMatch) return dexMatch[1]
  const dexPair = url.match(/dexscreener\.com\/[a-z]+\/([A-Za-z0-9]{32,44})/)
  if (dexPair) return dexPair[1]
  const pumpMatch = url.match(/pump\.fun\/coin\/([A-Za-z0-9]{32,44})/)
  if (pumpMatch) return pumpMatch[1]
  const bonkMatch = url.match(/bonk\.fun\/[^/]*\/([A-Za-z0-9]{32,44})/)
  if (bonkMatch) return bonkMatch[1]
  const birdMatch = url.match(/birdeye\.so\/token\/([A-Za-z0-9]{32,44})/)
  if (birdMatch && !url.includes("/bsc/")) return birdMatch[1]
  const photonMatch = url.match(/photon-sol\.tinyastro\.io\/[a-z]+\/([A-Za-z0-9]{32,44})/)
  if (photonMatch) return photonMatch[1]
  const gmgnMatch = url.match(/gmgn\.ai\/sol\/token\/([A-Za-z0-9]{32,44})/)
  if (gmgnMatch) return gmgnMatch[1]
  const axiomMatch = url.match(/axiom\.trade\/meme\/([A-Za-z0-9]{32,44})/)
  if (axiomMatch) return axiomMatch[1]
  const bullxMatch = url.match(/bullx\.io\/terminal\?chainId=solana.*[?&]address=([A-Za-z0-9]{32,44})/)
  if (bullxMatch) return bullxMatch[1]
  return ""
}

const COLORS: Record<string, string> = {
  SAFE: "#22c55e",
  CAUTION: "#f97316",
  DANGER: "#ef4444",
  RUG: "#dc2626",
  LOADING: "#6b7280"
}

export default function AntaresOverlay() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [visible, setVisible] = useState(true)
  const [ca, setCa] = useState("")

  useEffect(() => {
    const found = extractCA()
    setCa(found)
    if (!found || found.length < 32) {
      setLoading(false)
      return
    }
    chrome.runtime.sendMessage({ type: "SCAN", ca: found }, (res) => {
      if (chrome.runtime.lastError) {
        setError("Extension error")
        setLoading(false)
        return
      }
      if (res?.ok) {
        setData(res.data)
      } else {
        setError("API error")
      }
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    let lastUrl = location.href
    const obs = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href
        const found = extractCA()
        if (found && found.length >= 32) {
          setCa(found)
          setLoading(true)
          setData(null)
          setError("")
          setVisible(true)
          chrome.runtime.sendMessage({ type: "SCAN", ca: found }, (res) => {
            if (chrome.runtime.lastError) {
              setError("Extension error")
              setLoading(false)
              return
            }
            if (res?.ok) setData(res.data)
            else setError("API error")
            setLoading(false)
          })
        }
      }
    })
    obs.observe(document, { subtree: true, childList: true })
    return () => obs.disconnect()
  }, [])

  if (!visible || !ca || ca.length < 32) return null

  const risk = data?.risk || "LOADING"
  const score = data?.score ?? "--"
  const color = COLORS[risk] || COLORS.LOADING

  return (
    <div style={{
      position: "fixed", bottom: "20px", right: "20px",
      zIndex: 2147483647, background: "#0a0a0a",
      border: "1px solid " + color, borderRadius: "10px",
      padding: "12px 16px", fontFamily: "monospace",
      fontSize: "13px", color: "#fff",
      boxShadow: "0 0 24px " + color + "44", minWidth: "210px"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
        <span style={{ fontWeight: "bold", color: color }}>ANTARES</span>
        <span style={{ cursor: "pointer", color: "#666" }} onClick={() => setVisible(false)}>X</span>
      </div>
      {loading && <div style={{ color: "#888" }}>Scanning...</div>}
      {error && !loading && <div style={{ color: "#ef4444" }}>{error}</div>}
      {data && !loading && (
        <>
          <div style={{ fontSize: "22px", fontWeight: "bold", color: color, marginBottom: "4px" }}>{risk}</div>
          <div style={{ color: "#aaa", fontSize: "12px", marginBottom: "8px" }}>
            Score : <strong style={{ color: "#fff" }}>{score}/1000</strong>
          </div>
          {(data.flags || []).slice(0, 3).map((f: any, i: number) => (
            <div key={i} style={{ fontSize: "11px", color: "#888", marginBottom: "2px" }}>{f.label || f}</div>
          ))}
          <a
            href={"https://antares-seven-rouge.vercel.app/token/" + ca}
            target="_blank" rel="noreferrer"
            style={{ display: "block", marginTop: "8px", textAlign: "center",
              background: color, color: "#000", borderRadius: "6px",
              padding: "4px 0", fontWeight: "bold", fontSize: "12px",
              textDecoration: "none" }}>
            Full analysis
          </a>
        </>
      )}
    </div>
  )
}
