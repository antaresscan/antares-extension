import { useState, useEffect } from "react";

interface ScanResult {
  ca: string;
  score?: number;
  risk?: string;
  symbol?: string;
  timestamp?: number;
}

function Popup() {
  const [recentScans, setRecentScans] = useState<ScanResult[]>([]);
  const [stealthMode, setStealthMode] = useState(false);

  useEffect(() => {
    chrome.storage.local.get(["scanCache", "stealthMode"], (data: Record<string, unknown>) => {
      if (data.scanCache && typeof data.scanCache === "object") {
        const cache = data.scanCache as Record<string, Record<string, unknown>>;
        const scans: ScanResult[] = Object.entries(cache)
          .map(([ca, result]) => ({
            ca,
            score: typeof result.score === "number" ? result.score : undefined,
            risk: typeof result.risk === "string" ? result.risk : undefined,
            symbol: typeof result.symbol === "string" ? result.symbol : undefined,
            timestamp: typeof result.timestamp === "number" ? result.timestamp : undefined,
          }))
          .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
          .slice(0, 10);
        setRecentScans(scans);
      }
      setStealthMode(!!data.stealthMode);
    });
  }, []);

  const toggleStealth = () => {
    const newVal = !stealthMode;
    setStealthMode(newVal);
    void chrome.storage.sync.set({ stealthMode: newVal });
  };

  const riskColor = (risk?: string): string => {
    if (risk === "SAFE") return "#e8f5e9";
    if (risk === "DANGER" || risk === "RUG") return "#ffebee";
    return "#fff3e0";
  };

  return (
    <div style={{ width: 350, padding: 16, fontFamily: "system-ui" }}>
      <h2>Antares Scanner</h2>
      <div>
        <label>
          <input type="checkbox" checked={stealthMode} onChange={toggleStealth} />
          {" "}Stealth Mode
        </label>
      </div>
      <h3>Recent Scans</h3>
      {recentScans.length === 0 && <p>No scans yet. Visit a page with a Solana token address.</p>}
      {recentScans.map((scan) => (
        <div key={scan.ca} style={{
          padding: 8, margin: "4px 0", borderRadius: 6,
          background: riskColor(scan.risk),
        }}>
          <strong>{scan.symbol ?? scan.ca.slice(0, 8)}</strong>
          <span style={{ float: "right" }}>{scan.risk ?? "?"} ({scan.score ?? "—"})</span>
        </div>
      ))}
    </div>
  );
}

export default Popup;
