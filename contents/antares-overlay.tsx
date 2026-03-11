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

export default function AntaresOverlay() {
  return null
}

if (typeof window !== "undefined") {
  const ANTARES_ID = "antares-ext-root"

  function injectOverlay(ca: string) {
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
    container.innerHTML = '<div style="font-weight:bold;color:#6b7280">⭐ ANTARES — Scanning...</div>'
    document.documentElement.appendChild(container)

    chrome.runtime.sendMessage({ type: "SCAN", ca }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        container.innerHTML = '<div style="color:#ef4444">⭐ ANTARES — Erreur API</div>'
        return
      }
      const d = res.data
      const colors: Record<string, string> = {
        SAFE: "#22c55e", CAUTION: "#f97316", DANGER: "#ef4444", RUG: "#dc2626"
      }
      const color = colors[d.risk] ?? "#6b7280"
      container.style.border = "1px solid " + color
      container.style.boxShadow = "0 0 24px " + color + "44"

      // Use resolvedMint if backend resolved a pair address, otherwise show original ca
      const mint: string = d.resolvedMint && d.resolvedMint !== ca ? d.resolvedMint : ca
      const shortMint = mint.slice(0, 4) + "..." + mint.slice(-4)
      const wasResolved = mint !== ca

      const flagsHtml = (d.flags ?? []).slice(0, 3)
        .map(function(f: any) { return '<div style="font-size:11px;color:#888;margin-top:2px">' + (f.label || f) + '</div>' })
        .join("")

      container.innerHTML = '<div style="display:flex;justify-content:space-between;margin-bottom:6px">'
        + '<span style="font-weight:bold;color:' + color + '">⭐ ANTARES</span>'
        + '<span id="antares-close" style="cursor:pointer;color:#666;font-size:16px">✕</span>'
        + '</div>'
        + '<div style="font-size:22px;font-weight:bold;color:' + color + '">' + d.risk + '</div>'
        + '<div style="color:#aaa;font-size:12px;margin:4px 0 4px">'
        + 'Score : <strong style="color:#fff">' + d.score + '/1000</strong>'
        + '</div>'
        + '<div style="color:#555;font-size:10px;margin-bottom:' + (wasResolved ? "2px" : "8px") + '">' + shortMint + '</div>'
        + (wasResolved ? '<div style="color:#6b7280;font-size:9px;margin-bottom:6px">resolved from pair</div>' : '')
        + flagsHtml
        + '<a href="https://antares-seven-rouge.vercel.app/token/' + mint + '"'
        + ' target="_blank"'
        + ' style="display:block;margin-top:8px;text-align:center;background:' + color + ';'
        + 'color:#000;border-radius:6px;padding:4px 0;font-weight:bold;'
        + 'font-size:12px;text-decoration:none">'
        + 'Full analysis →'
        + '</a>'

      document.getElementById("antares-close")?.addEventListener("click", function() { container.remove() })
    })
  }

  function tryInject() {
    const ca = extractCA()
    if (ca && ca.length >= 32) injectOverlay(ca)
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(tryInject, 1500)
  } else {
    window.addEventListener("DOMContentLoaded", function() { setTimeout(tryInject, 1500) })
  }

  let lastUrl = location.href
  new MutationObserver(function() {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      setTimeout(tryInject, 1500)
    }
  }).observe(document, { subtree: true, childList: true })
}
