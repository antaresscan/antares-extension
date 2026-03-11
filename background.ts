export {}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SCAN") {
    fetch(`https://antares-seven-rouge.vercel.app/api/scan?ca=${msg.ca}`)
      .then((r) => r.json())
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true // keep channel open
  }
})
