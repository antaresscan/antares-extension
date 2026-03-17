export {}

// ─── KEEPALIVE — empêche Chrome de tuer le Service Worker ───────────────────
// Chrome suspend le SW après ~30s d'inactivité, ce qui coupe les fetches
// en cours et provoque des bugs aléatoires. Ce ping toutes les 20s
// maintient le SW actif tant que l'extension tourne.
function startKeepalive() {
  setInterval(() => {
    // Accès à chrome.runtime.id suffit à réveiller/maintenir le contexte SW
    void chrome.runtime.id;
  }, 20_000);
}

chrome.runtime.onInstalled.addListener(startKeepalive);
chrome.runtime.onStartup.addListener(startKeepalive);
startKeepalive();

// ─── MESSAGE HANDLER ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SCAN") {
    fetch(`https://antares-extension.vercel.app/api/scan?ca=${msg.ca}`)
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // keep channel open
  }
})
