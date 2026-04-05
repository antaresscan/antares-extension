import { useState, useEffect } from "react";
import { config } from "./shared/config";

function sanitize(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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
    chrome.storage.local.get([config.historyStorageKey, "antares_stealth"], (data: Record<string, unknown>) => {
      if (Array.isArray(data[config.historyStorageKey])) {
        const history = data[config.historyStorageKey] as Array<Record<string, unknown>>;
        const scans: ScanResult[] = history
          .map((entry) => ({
            ca: typeof entry.ca === "string" ? entry.ca : "",
            score: typeof entry.score === "number" ? entry.score : undefined,
            risk: typeof entry.risk === "string" ? entry.risk : undefined,
            symbol: typeof entry.symbol === "string" ? entry.symbol : undefined,
            timestamp: typeof entry.ts === "number" ? entry.ts : undefined,
          }))
          .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
          .slice(0, config.maxHistoryEntries);
        setRecentScans(scans);
      }
      setStealthMode(!!data.antares_stealth);
    });
  }, []);

  const toggleStealth = () => {
    const newVal = !stealthMode;
    setStealthMode(newVal);
    void chrome.storage.local.set({ antares_stealth: newVal });
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
          <strong>{sanitize(scan.symbol) || scan.ca.slice(0, 8)}</strong>
          <span style={{ float: "right" }}>{sanitize(scan.risk) || "?"} ({scan.score ?? "\u2014"})</span>
        </div>
      ))}
    </div>
  );
}

export default Popup;
