import { useEffect, useState } from "react"
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: [
    "https://dexscreener.com/solana/*",
    "https://pump.fun/*",
    "https://bonk.fun/*",
    "https://birdeye.so/token/*"
  ]
}

function extractCA(): string {
  const url = window.location.href
  if (url.includes("dexscreener.com/solana/")) {
    return url.split("/solana/")[1]?.split("?")[0] ?? ""
  }
  if (url.includes("pump.fun/coin/")) {
    return url.split("/coin/")[1]?.split("?")[0] ?? ""
  }
  if (url.includes("bonk.fun/token/")) {
    return url.split("/token/")[1]?.split("?")[0] ?? ""
  }
  if (url.includes("birdeye.so/token/") && !url.includes("/bsc/")) {
    return url.split("/token/")[1]?.split("?")[0] ?? ""
  }
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

  const ca = extractCA()

  useEffect(() => {
    if (!ca || ca.length < 32) {
      setLoading(false)
      return
    }
    // Passe par le background pour éviter le CSP de DexScreener
    chrome.runtime.sendMessage({ type: "SCAN", ca }, (res) => {
      if (res?.ok) {
        setData(res.data)
      } else {
        setError("Erreur API")
      }
      setLoading(false)
    })
  }, [ca])

  if (!visible || !ca || ca.length < 32) return null

  const risk = data?.risk ?? "—"
  const score = data?.score ?? "—"
  const color = COLORS[risk] ?? COLORS.LOADING

  return (
    <div style={{
      position: "fixed", bottom: "20px", right: "20px",
      zIndex: 2147483647, background: "#0a0a0a",
      border: `1px solid ${color}`, borderRadius: "10px",
      padding: "12px 16px", fontFamily: "monospace",
      fontSize: "13px", color: "#fff",
      boxShadow: `0 0 24px ${color}44`, minWidth: "210px"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
        <span style={{ fontWeight: "bold", color }}>⭐ ANTARES</span>
        <span style={{ cursor: "pointer", color: "#666" }} onClick={() => setVisible(false)}>✕</span>
      </div>
      {loading && <div style={{ color: "#888" }}>Scanning...</div>}
      {error && !loading && <div style={{ color: "#ef4444" }}>{error}</div>}
      {data && !loading && (
        <>
          <div style={{ fontSize: "22px", fontWeight: "bold", color, marginBottom: "4px" }}>{risk}</div>
          <div style={{ color: "#aaa", fontSize: "12px", marginBottom: "8px" }}>
            Score : <strong style={{ color: "#fff" }}>{score}/1000</strong>
          </div>
          {data.flags?.slice(0, 3).map((f: string, i: number) => (
            <div key={i} style={{ fontSize: "11px", color: "#888", marginBottom: "2px" }}>{f}</div>
          ))}
          <a
            href={`https://antares-seven-rouge.vercel.app/token/${ca}`}
            target="_blank" rel="noreferrer"
            style={{
              display: "block", marginTop: "8px", textAlign: "center",
              background: color, color: "#000", borderRadius: "6px",
              padding: "4px 0", fontWeight: "bold", fontSize: "12px",
              textDecoration: "none"
            }}>
            Voir l'analyse complète →
          </a>
        </>
      )}
    </div>
  )
}
