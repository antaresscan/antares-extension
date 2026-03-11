import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  world: "MAIN",
  run_at: "document_idle"
}

function extractCA(): string {
  const url = window.location.href

  // DexScreener
  const dexMatch = url.match(/dexscreener\.com\/solana\/([A-Za-z0-9]{32,44})/)
  if (dexMatch) return dexMatch[1]

  // DexScreener pairId → on renvoie tel quel, l'API résout
  const dexPair = url.match(/dexscreener\.com\/[a-z]+\/([A-Za-z0-9]{32,44})/)
  if (dexPair) return dexPair[1]

  // Pump.fun
  const pumpMatch = url.match(/pump\.fun\/coin\/([A-Za-z0-9]{32,44})/)
  if (pumpMatch) return pumpMatch[1]

  // Bonk.fun
  const bonkMatch = url.match(/bonk\.fun\/[^/]*\/([A-Za-z0-9]{32,44})/)
  if (bonkMatch) return bonkMatch[1]

  // Birdeye (Solana uniquement)
  const birdMatch = url.match(/birdeye\.so\/token\/([A-Za-z0-9]{32,44})/)
  if (birdMatch && !url.includes("/bsc/")) return birdMatch[1]

  // Photon
  const photonMatch = url.match(/photon-sol\.tinyastro\.io\/[a-z]+\/([A-Za-z0-9]{32,44})/)
  if (photonMatch) return photonMatch[1]

  // GMGN
  const gmgnMatch = url.match(/gmgn\.ai\/sol\/token\/([A-Za-z0-9]{32,44})/)
  if (gmgnMatch) return gmgnMatch[1]

  // Axiom
  const axiomMatch = url.match(/axiom\.trade\/meme\/([A-Za-z0-9]{32,44})/)
  if (axiomMatch) return axiomMatch[1]

  // BullX
  const bullxMatch = url.match(/bullx\.io\/terminal\?chainId=solana.*[?&]address=([A-Za-z0-9]{32,44})/)
  if (bullxMatch) return bullxMatch[1]

  return ""
}

export default function AntaresOverlay() {
  return null
}

// Injection manuelle via DOM pour contourner le CSP de DexScreener
if (typeof window !== "undefined") {
  const ANTARES_ID = "antares-ext-root"

  function injectOverlay(ca: string) {
    // Supprimer l'ancien si présent
    document.getElementById(ANTARES_ID)?.remove()

    const container = document.createElement("div")
    container.id = ANTARES_ID
    container.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      z-index: 2147483647; background: #0a0a0a;
      border: 1px solid #6b7280; border-radius: 10px;
      padding: 12px 16px; font-family: monospace;
      font-size: 13px; color: #fff; min-width: 210px;
      box-shadow: 0 0 24px rgba(107,114,128,0.4);
    `
    container.innerHTML = `<div style="font-weight:bold;color:#6b7280">⭐ ANTARES — Scanning...</div>`
    document.documentElement.appendChild(container)

    chrome.runtime.sendMessage({ type: "SCAN", ca }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        container.innerHTML = `<div style="color:#ef4444">⭐ ANTARES — Erreur API</div>`
        return
      }
      const d = res.data
      const colors: Record<string, string> = {
        SAFE: "#22c55e", CAUTION: "#f97316", DANGER: "#ef4444", RUG: "#dc2626"
      }
      const color = colors[d.risk] ?? "#6b7280"
      container.style.border = `1px solid ${color}`
      container.style.boxShadow = `0 0 24px ${color}44`

      const flagsHtml = (d.flags ?? []).slice(0, 3)
        .map((f: {label: string}) => `<div style="font-size:11px;color:#888;margin-top:2px">${f.label}</div>`)
        .join("")

      container.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span style="font-weight:bold;color:${color}">⭐ ANTARES</span>
          <span id="antares-close" style="cursor:pointer;color:#666;font-size:16px">✕</span>
        </div>
        <div style="font-size:22px;font-weight:bold;color:${color}">${d.risk}</div>
        <div style="color:#aaa;font-size:12px;margin:4px 0 8px">
          Score : <strong style="color:#fff">${d.score}/1000</strong>
        </div>
        ${flagsHtml}
        <a href="https://antares-seven-rouge.vercel.app/token/${ca}"
          target="_blank"
          style="display:block;margin-top:8px;text-align:center;background:${color};
          color:#000;border-radius:6px;padding:4px 0;font-weight:bold;
          font-size:12px;text-decoration:none">
          Voir l'analyse complète →
        </a>
      `
      document.getElementById("antares-close")?.addEventListener("click", () => container.remove())
    })
  }

  function tryInject() {
    const ca = extractCA()
    if (ca && ca.length >= 32) injectOverlay(ca)
  }

  // Inject au chargement
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(tryInject, 1500)
  } else {
    window.addEventListener("DOMContentLoaded", () => setTimeout(tryInject, 1500))
  }

  // Inject sur navigation SPA (DexScreener, Pump.fun sont des SPAs)
  let lastUrl = location.href
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      setTimeout(tryInject, 1500)
    }
  }).observe(document, { subtree: true, childList: true })
}
