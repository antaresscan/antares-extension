import { useState, useEffect } from "react";

function Options() {
  const [stealthMode, setStealthMode] = useState(false);
  const [autoRescan, setAutoRescan] = useState(true);
  const [version, setVersion] = useState("");

  useEffect(() => {
    chrome.storage.local.get(["antares_stealth"], (localData) => {
      setStealthMode(!!localData.antares_stealth);
    });
    chrome.storage.sync.get(["autoRescan"], (syncData) => {
      setAutoRescan(syncData.autoRescan !== false);
    });
    setVersion(chrome.runtime.getManifest().version);
  }, []);

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Antares Scanner Settings</h1>
      <div style={{ marginBottom: 16 }}>
        <label>
          <input type="checkbox" checked={stealthMode}
            onChange={(e) => {
              setStealthMode(e.target.checked);
              void chrome.storage.local.set({ antares_stealth: e.target.checked });
            }} />
          {" "}Stealth Mode (hide overlay on pages)
        </label>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label>
          <input type="checkbox" checked={autoRescan}
            onChange={(e) => {
              setAutoRescan(e.target.checked);
              void chrome.storage.sync.set({ autoRescan: e.target.checked });
            }} />
          {" "}Auto-rescan on price crash (&gt;30% drop in 1h)
        </label>
      </div>
      <h2>About</h2>
      <p>Antares \u2014 real-time Solana token scanner.</p>
      <p>Version: {version}</p>
      <p><a href="https://antares-extension.vercel.app/privacy" target="_blank" rel="noreferrer">Privacy Policy</a></p>
    </div>
  );
}

export default Options;
