import { useState, useEffect } from "react";
import { getInstallId } from "./shared/install-id";

const API_BASE = "https://antares-extension.vercel.app";
const KEY_RE = /^ANT-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/;

type RedeemState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; tier: string; expiresAt: number | null }
  | { kind: "error"; message: string };

type DevTier = "off" | "free" | "pro" | "yearly" | "lifetime";

function Options() {
  const [stealthMode, setStealthMode] = useState(false);
  const [autoRescan, setAutoRescan] = useState(true);
  const [version, setVersion] = useState("");
  const [installId, setInstallId] = useState<string>("");
  const [installIdCopied, setInstallIdCopied] = useState(false);
  const [devTier, setDevTier] = useState<DevTier>("off");

  // License redemption state
  const [licenseInput, setLicenseInput] = useState("");
  const [redeem, setRedeem] = useState<RedeemState>({ kind: "idle" });

  useEffect(() => {
    chrome.storage.local.get(
      ["antares_stealth", "autoRescan", "antares_dev_tier"],
      (data) => {
        if (chrome.runtime.lastError) {
          console.error("[antares] options storage error:", chrome.runtime.lastError.message);
          return;
        }
        setStealthMode(!!data.antares_stealth);
        setAutoRescan(data.autoRescan !== false);
        const stored = data.antares_dev_tier;
        if (stored === "free" || stored === "pro" || stored === "yearly" || stored === "lifetime") {
          setDevTier(stored);
        } else {
          setDevTier("off");
        }
      },
    );
    setVersion(chrome.runtime.getManifest().version);
    void getInstallId().then((id) => setInstallId(id ?? ""));
  }, []);

  function updateDevTier(next: DevTier) {
    setDevTier(next);
    if (next === "off") {
      void chrome.storage.local.remove("antares_dev_tier");
    } else {
      void chrome.storage.local.set({ antares_dev_tier: next });
    }
  }

  function copyInstallId() {
    if (!installId) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(installId).then(() => {
        setInstallIdCopied(true);
        setTimeout(() => setInstallIdCopied(false), 1800);
      });
    }
  }

  async function submitRedeem(e: React.FormEvent) {
    e.preventDefault();
    const key = licenseInput.trim().toUpperCase();
    if (!KEY_RE.test(key)) {
      setRedeem({
        kind: "error",
        message: "License key format is ANT-XXXX-XXXX-XXXX-XXXX.",
      });
      return;
    }
    setRedeem({ kind: "submitting" });
    try {
      const installId = await getInstallId();
      const resp = await fetch(`${API_BASE}/api/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: key, install_id: installId }),
      });
      const body = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        reason?: string;
        tier?: string;
        expiresAt?: number | null;
      };
      if (resp.ok && body.ok) {
        setRedeem({
          kind: "success",
          tier: body.tier ?? "pro",
          expiresAt: body.expiresAt ?? null,
        });
        setLicenseInput("");
        return;
      }
      // Map server reasons to friendly messages
      const map: Record<string, string> = {
        not_found: "We couldn't find that license. Double-check the key.",
        already_redeemed:
          "That license is already redeemed on a different install. Reach out to support if you switched machines.",
        invalid_format: "License key format is ANT-XXXX-XXXX-XXXX-XXXX.",
      };
      setRedeem({
        kind: "error",
        message: map[body.reason ?? ""] ?? "Could not redeem the license.",
      });
    } catch (err) {
      setRedeem({
        kind: "error",
        message: "Network error. Check your connection and retry.",
      });
      console.error("[antares] redeem failed", err);
    }
  }

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
              void chrome.storage.local.set({ autoRescan: e.target.checked });
            }} />
          {" "}Auto-rescan on price crash (&gt;30% drop in 1h)
        </label>
      </div>

      <h2 style={{ marginTop: 36 }}>Redeem a Pro license</h2>
      <p style={{ color: "#555", fontSize: 13, lineHeight: 1.6 }}>
        Bought a license on the website? Paste the key here to unlock Pro on
        this install. Each license redeems on one install — to move to a
        different machine, contact support with your transaction signature.
      </p>
      <form onSubmit={submitRedeem} style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          type="text"
          placeholder="ANT-XXXX-XXXX-XXXX-XXXX"
          value={licenseInput}
          onChange={(e) => {
            setLicenseInput(e.target.value);
            if (redeem.kind === "error") setRedeem({ kind: "idle" });
          }}
          disabled={redeem.kind === "submitting" || redeem.kind === "success"}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="characters"
          style={{
            flex: 1,
            padding: "10px 12px",
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: 14,
            letterSpacing: ".05em",
            border: "1px solid #ccc",
            borderRadius: 4,
            background:
              redeem.kind === "success" ? "#f0fff7" : "#fff",
          }}
          aria-label="License key"
        />
        <button
          type="submit"
          disabled={
            redeem.kind === "submitting" ||
            redeem.kind === "success" ||
            !licenseInput.trim()
          }
          style={{
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 600,
            background: redeem.kind === "success" ? "#00c89a" : "#0f0f11",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor:
              redeem.kind === "submitting" || redeem.kind === "success"
                ? "default"
                : "pointer",
            opacity: !licenseInput.trim() ? 0.5 : 1,
          }}
        >
          {redeem.kind === "submitting"
            ? "Redeeming…"
            : redeem.kind === "success"
              ? "✓ Redeemed"
              : "Redeem"}
        </button>
      </form>
      {redeem.kind === "success" && (
        <div
          role="status"
          style={{
            marginTop: 12,
            padding: 12,
            background: "rgba(0,200,154,0.08)",
            border: "1px solid rgba(0,200,154,0.4)",
            borderRadius: 4,
            fontSize: 13,
            color: "#0a7a5e",
          }}
        >
          ✓ {redeem.tier === "lifetime"
            ? "Lifetime"
            : redeem.tier === "yearly"
              ? "Yearly"
              : "Pro"} unlocked on this install
          {redeem.expiresAt
            ? ` until ${new Date(redeem.expiresAt).toLocaleDateString()}.`
            : "."}
          {" "}Reload the page you were scanning to see the unlocked overlay.
        </div>
      )}
      {redeem.kind === "error" && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 12,
            background: "rgba(255,95,95,0.06)",
            border: "1px solid rgba(255,95,95,0.4)",
            borderRadius: 4,
            fontSize: 13,
            color: "#a04040",
          }}
        >
          {redeem.message}
        </div>
      )}
      <p style={{ fontSize: 12, color: "#888", marginTop: 12 }}>
        Lost your key? Look it up at{" "}
        <a
          href="https://comealamaisongroupe.github.io/antares-website/account.html"
          target="_blank"
          rel="noreferrer"
        >
          comealamaisongroupe.github.io/antares-website/account
        </a>{" "}
        with the email you used at checkout.
      </p>

      <h2 style={{ marginTop: 36 }}>This install</h2>
      <p style={{ color: "#555", fontSize: 13, lineHeight: 1.6 }}>
        Anonymous identifier for your local install. Used by the API to track
        quota and tier — never sent to third parties. Reset by uninstalling +
        reinstalling the extension.
      </p>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 12,
          alignItems: "center",
        }}
      >
        <code
          style={{
            flex: 1,
            padding: "10px 12px",
            background: "#f5f5f5",
            border: "1px solid #ddd",
            borderRadius: 4,
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
            fontSize: 12,
            color: "#333",
            userSelect: "all",
            WebkitUserSelect: "all",
            wordBreak: "break-all",
          }}
        >
          {installId || "loading…"}
        </code>
        <button
          type="button"
          onClick={copyInstallId}
          disabled={!installId}
          style={{
            padding: "10px 16px",
            fontSize: 12,
            fontWeight: 600,
            background: installIdCopied ? "#00c89a" : "#0f0f11",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: installId ? "pointer" : "default",
            whiteSpace: "nowrap",
          }}
        >
          {installIdCopied ? "✓ Copied" : "Copy"}
        </button>
      </div>

      <h2 style={{ marginTop: 36 }}>Dev mode</h2>
      <p style={{ color: "#555", fontSize: 13, lineHeight: 1.6 }}>
        Force a tier on the server side for this install. Only takes effect
        when the install id above is listed in the server's
        <code style={{
          margin: "0 4px",
          padding: "1px 6px",
          background: "#f5f5f5",
          border: "1px solid #ddd",
          borderRadius: 3,
          fontSize: 12,
          fontFamily: "ui-monospace, Menlo, Consolas, monospace",
        }}>DEV_PRO_INSTALLS</code>
        env var. Use it to flip between Free / Pro / Lifetime in real time
        and verify what each tier sees in the overlay.
      </p>
      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 12,
          alignItems: "center",
        }}
      >
        <label
          htmlFor="dev-tier"
          style={{ fontSize: 13, color: "#333", fontWeight: 600 }}
        >
          Force tier:
        </label>
        <select
          id="dev-tier"
          value={devTier}
          onChange={(e) => updateDevTier(e.target.value as DevTier)}
          style={{
            flex: 1,
            padding: "10px 12px",
            border: "1px solid #ddd",
            borderRadius: 4,
            fontSize: 13,
            background: "#fff",
            cursor: "pointer",
          }}
        >
          <option value="off">Off (use real tier)</option>
          <option value="free">Free</option>
          <option value="pro">Pro (30 days)</option>
          <option value="yearly">Yearly (1 year)</option>
        </select>
      </div>
      {devTier !== "off" && (
        <p
          style={{
            marginTop: 8,
            padding: 10,
            background: "rgba(245,208,0,.08)",
            border: "1px solid rgba(245,208,0,.4)",
            borderRadius: 4,
            fontSize: 12,
            color: "#7a6a00",
          }}
        >
          ⚠ Dev override active: scanner sends
          {" "}<code style={{ fontFamily: "ui-monospace, Menlo, Consolas, monospace" }}>X-Antares-Dev-Tier: {devTier}</code>
          {" "}with every scan. Server only honours this if your install id is
          dev-listed; otherwise it's ignored.
        </p>
      )}

      <h2>About</h2>
      <p>Antares — real-time Solana token scanner.</p>
      <p>Version: {version}</p>
      <p><a href="https://antares-extension.vercel.app/privacy" target="_blank" rel="noreferrer">Privacy Policy</a></p>
    </div>
  );
}

export default Options;
