import { useState, useEffect } from "react";

function Options() {
  const [stealthMode, setStealthMode] = useState(false);
  const [autoRescan, setAutoRescan] = useState(true);

  useEffect(() => {
    chrome.storage.sync.get(["stealthMode", "autoRescan"], (data: Record<string, unknown>) => {
      setStealthMode(!!data.stealthMode);
      setAutoRescan(data.autoRescan !== false);
    });
  }, []);

  const save = (key: string, val: boolean) => {
    chrome.storage.sync.set({ [key]: val });
  };

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Antares Scanner Settings</h1>
      <div style={{ marginBottom: 16 }}>
        <label>
          <input type="checkbox" checked={stealthMode}
            onChange={(e) => { setStealthMode(e.target.checked); save("stealthMode", e.target.checked); }} />
          {" "}Stealth Mode (hide overlay on pages)
        </label>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label>
          <input type="checkbox" checked={autoRescan}
            onChange={(e) => { setAutoRescan(e.target.checked); save("autoRescan", e.target.checked); }} />
          {" "}Auto-rescan on price crash (&gt;30% drop in 1h)
        </label>
      </div>
      <h2>About</h2>
      <p>Antares is a real-time Solana token scanner that detects scams, rugs, and dangerous tokens.</p>
      <p>Version: 1.0.0</p>
      <p><a href="https://antares-extension.vercel.app/privacy" target="_blank" rel="noreferrer">Privacy Policy</a></p>
    </div>
  );
}

export default Options;
