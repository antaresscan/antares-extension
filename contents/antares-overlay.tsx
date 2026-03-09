import { useEffect, useState } from "react"
import cssText from "data-text:~/contents/antares-overlay.css"
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
}

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

const ANTARES_API = "https://antares-seven-rouge.vercel.app/api/scan"

const riskColors: Record<string, string> = {
  SAFE:    "#22c55e",
  CAUTION: "#eab308",
  DANGER:  "#f97316",
  RUG:     "#dc2626",
}

const riskLabels: Record<string, string> = {
  SAFE:    "✅ SAFE",
  CAUTION: "⚠️ CAUTION",
  DANGER:  "🔴 DANGER",
  RUG:     "💀 RUG",
}

function extractCA(url: string): string | null {
  const patterns = [
    /dexscreener\.com\/solana\/([A-Za-z0-9]{32,44})/,
    /pump\.fun\/coin\/([A-Za-z0-9]{32,44})/,
    /birdeye\.so\/token\/([A-Za-z0-9]{32,44})/,
    /solscan\.io\/token\/([A-Za-z0-9]{32,44})/,
    /gmgn\.ai\/sol\/token\/([A-Za-z0-9]{32,44})/,
    /[?&]address=([A-Za-z0-9]{32,44})/,
    /[?&]mint=([A-Za-z0-9]{32,44})/,
    /[?&]token=([A-Za-z0-9]{32,44})/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

export default function AntaresOverlay() {
  const [ca, setCA]             = useState<string | null>(null)
  const [data, setData]         = useState<any>(null)
  const [loading, setLoading]   = useState(false)
  const [visible, setVisible]   = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout>

    function detect() {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        const found = extractCA(window.location.href)
        setCA((prev) => {
          if (prev !== found) {
            setData(null)
            setExpanded(false)
          }
          return found
        })
      }, 300)
    }

    detect()

    const observer = new MutationObserver(detect)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener("popstate", detect)

    return () => {
      clearTimeout(debounceTimer)
      observer.disconnect()
      window.removeEventListener("popstate", detect)
    }
  }, [])

  useEffect(() => {
    if (!ca) return
    setLoading(true)
    fetch(`${ANTARES_API}?ca=${ca}`)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [ca])

  if (!ca || !visible) return null

  const color = data ? riskColors[data.risk] ?? "#6366f1" : "#6366f1"

  return (
    <div className="antares-root">
      <div
        className="antares-badge"
        style={{ borderColor: color }}
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="antares-header">
          <span className="antares-logo">⭐ ANTARES</span>
          <button className="antares-close" onClick={(e) => { e.stopPropagation(); setVisible(false) }}>✕</button>
        </div>

        {loading && <p className="antares-loading">Analyse en cours...</p>}

        {!loading && data && (
          <>
            <div className="antares-score" style={{ color }}>
              {data.score}<span className="antares-max">/1000</span>
            </div>
            <div className="antares-risk" style={{ background: color }}>
              {riskLabels[data.risk] ?? data.risk}
            </div>

            {expanded && data.flags?.length > 0 && (
              <div className="antares-flags">
                {data.flags.slice(0, 5).map((f: any, i: number) => (
                  <div key={i} className={`antares-flag antares-flag--${f.severity}`}>
                    <span>{f.label}</span>
                    <span className="antares-flag-impact">-{f.impact}</span>
                  </div>
                ))}
              </div>
            )}

            <p className="antares-hint">
              {expanded ? "▲ Réduire" : "▼ Voir les signaux"}
            </p>
          </>
        )}

        {!loading && !data && <p className="antares-loading">Analyse en cours...</p>}
      </div>
    </div>
  )
}
