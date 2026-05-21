import { useState, useEffect, useCallback } from "react";
import { getInstallId } from "./shared/install-id";

const API_BASE = "https://antares-extension.vercel.app";
const WEBSITE_BASE = "https://antares-website.vercel.app";
const SESSION_TOKEN_KEY = "antares_session_token";

type DevTier = "off" | "free" | "pro" | "yearly" | "lifetime";

interface AccountStateLoading {
  kind: "loading";
}
interface AccountStateSignedOut {
  kind: "signed_out";
}
interface AccountStateSignedIn {
  kind: "signed_in";
  email: string;
  tier: "free" | "pro" | "yearly" | "lifetime";
  expiresAt: number | null;
}
interface AccountStateError {
  kind: "error";
  message: string;
}
type AccountState =
  | AccountStateLoading
  | AccountStateSignedOut
  | AccountStateSignedIn
  | AccountStateError;

function Options() {
  const [stealthMode, setStealthMode] = useState(false);
  const [autoRescan, setAutoRescan] = useState(true);
  const [version, setVersion] = useState("");
  const [installId, setInstallId] = useState<string>("");
  const [installIdCopied, setInstallIdCopied] = useState(false);
  const [devTier, setDevTier] = useState<DevTier>("off");
  const [account, setAccount] = useState<AccountState>({ kind: "loading" });
  const [notifTestState, setNotifTestState] = useState<"idle" | "sent" | "blocked">("idle");

  // Read the session token from chrome.storage.local. The website's
  // bridge content script (contents/antares-website-bridge.ts) writes
  // it on successful login + clears it on logout, so we just need to
  // surface whatever's currently there.
  const readSessionToken = useCallback((): Promise<string | null> => {
    return new Promise((resolve) => {
      chrome.storage.local.get([SESSION_TOKEN_KEY], (data) => {
        const token = data[SESSION_TOKEN_KEY];
        resolve(typeof token === "string" && token.length > 0 ? token : null);
      });
    });
  }, []);

  // Probe /api/auth/me with the session token to confirm it's still
  // valid + fetch the account email. Token is stateless JWT (HMAC-SHA256
  // with SESSION_SECRET) so the server validates on each call. Failure
  // here means the token is expired or revoked → treat as signed-out.
  const refreshAccount = useCallback(async () => {
    const token = await readSessionToken();
    if (!token) {
      setAccount({ kind: "signed_out" });
      return;
    }
    try {
      const meRes = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { "X-Antares-Session": token },
      });
      if (meRes.status === 401 || !meRes.ok) {
        // Stale or invalid token — drop it so future scans go out as
        // anonymous (Free) instead of with a token the server rejects.
        chrome.storage.local.remove(SESSION_TOKEN_KEY);
        setAccount({ kind: "signed_out" });
        return;
      }
      const me = (await meRes.json()) as {
        ok?: boolean;
        email?: string;
      };
      if (!me?.ok || !me.email) {
        setAccount({ kind: "signed_out" });
        return;
      }
      // Resolve the user's effective tier via /api/quota — same source
      // /api/scan reads from, so the Options-page badge always matches
      // what the overlay would show.
      try {
        const installIdNow = await getInstallId();
        const url = `${API_BASE}/api/quota${installIdNow ? `?install=${encodeURIComponent(installIdNow)}` : ""}`;
        const quotaRes = await fetch(url, {
          headers: {
            "X-Antares-Session": token,
            ...(installIdNow ? { "X-Antares-Install": installIdNow } : {}),
          },
        });
        let tier: AccountStateSignedIn["tier"] = "free";
        let expiresAt: number | null = null;
        if (quotaRes.ok) {
          const q = (await quotaRes.json()) as {
            tier?: string;
            tierExpiresAt?: number | null;
          };
          if (
            q.tier === "free" ||
            q.tier === "pro" ||
            q.tier === "yearly" ||
            q.tier === "lifetime"
          ) {
            tier = q.tier;
          }
          if (typeof q.tierExpiresAt === "number") {
            expiresAt = q.tierExpiresAt;
          }
        }
        setAccount({ kind: "signed_in", email: me.email, tier, expiresAt });
      } catch {
        // /api/quota down — fall back to "signed_in but tier unknown"
        // shown as "free" so we never falsely advertise Pro.
        setAccount({
          kind: "signed_in",
          email: me.email,
          tier: "free",
          expiresAt: null,
        });
      }
    } catch (err) {
      setAccount({
        kind: "error",
        message: "Network error. Reload to retry.",
      });
      console.warn("[antares] account refresh failed", err);
    }
  }, [readSessionToken]);

  useEffect(() => {
    chrome.storage.local.get(
      ["antares_stealth", "autoRescan", "antares_dev_tier"],
      (data) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[antares] options storage error:",
            chrome.runtime.lastError.message,
          );
          return;
        }
        setStealthMode(!!data.antares_stealth);
        setAutoRescan(data.autoRescan !== false);
        const stored = data.antares_dev_tier;
        if (
          stored === "free" ||
          stored === "pro" ||
          stored === "yearly" ||
          stored === "lifetime"
        ) {
          setDevTier(stored);
        } else {
          setDevTier("off");
        }
      },
    );
    setVersion(chrome.runtime.getManifest().version);
    void getInstallId().then((id) => setInstallId(id ?? ""));
    void refreshAccount();
  }, [refreshAccount]);

  // Watch for changes to the session token written by the bridge —
  // when the user signs in on the website, the bridge writes the JWT
  // here and we refresh the Options-page UI to match without the user
  // having to close + reopen the page.
  useEffect(() => {
    function onStorageChange(
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) {
      if (areaName !== "local") return;
      if (!(SESSION_TOKEN_KEY in changes)) return;
      void refreshAccount();
    }
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, [refreshAccount]);

  function updateDevTier(next: DevTier) {
    setDevTier(next);
    if (next === "off") {
      void chrome.storage.local.remove("antares_dev_tier");
    } else {
      void chrome.storage.local.set({ antares_dev_tier: next });
    }
  }

  // Fire a demo system notification identical in shape to the real
  // risk-escalation alert (background.ts → checkRiskEscalation). Used
  // by reviewers and end-users to confirm the OS-level notification
  // permission is granted and visible — the real feature only fires
  // when a previously-scanned token's risk worsens between two scans,
  // which is impossible to trigger on demand during a CWS review.
  function triggerTestNotification() {
    try {
      // Plasmo hashes icon filenames at build time. Read the real
      // path from the runtime manifest — "assets/icon.png" does NOT
      // exist in the built package and would cause the notification
      // to silently fail (Chrome rejects notifications whose iconUrl
      // returns 404).
      const icons = chrome.runtime.getManifest().icons as Record<string, string> | undefined;
      const iconPath = icons?.["128"] || icons?.["64"] || icons?.["48"] || icons?.["32"] || "";
      chrome.notifications.create(
        `antares_test_${Date.now()}`,
        {
          type: "basic",
          iconUrl: chrome.runtime.getURL(iconPath),
          title: "Antares — Risk Escalation",
          message: "BONK risk changed: CAUTION → DANGER  (this is a test)",
        },
        (notifId) => {
          if (chrome.runtime.lastError || !notifId) {
            setNotifTestState("blocked");
            return;
          }
          setNotifTestState("sent");
          setTimeout(() => setNotifTestState("idle"), 4000);
        },
      );
    } catch {
      setNotifTestState("blocked");
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

  // Open the website auth page in a new tab. The bridge content script
  // already runs on antares-website.vercel.app (see manifest match
  // patterns + contents/antares-website-bridge.ts) so as soon as the
  // user signs in there, /api/auth/sync-token mints the JWT and the
  // bridge pushes it to chrome.storage.local — onStorageChange picks
  // it up and re-renders this page automatically.
  function openSignIn() {
    void chrome.tabs.create({
      url: `${WEBSITE_BASE}/auth.html?return=%2Faccount.html`,
    });
  }

  // Sign out: clear the token here AND best-effort tell the API to
  // clear the session cookie. Either step alone is sufficient to
  // downgrade the next scan to Free, so we don't block on the network
  // call — local storage clear runs first, refresh runs immediately.
  async function signOut() {
    try {
      const token = await readSessionToken();
      void fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: token ? { "X-Antares-Session": token } : {},
      }).catch(() => { /* non-critical */ });
    } catch { /* ignore */ }
    await new Promise<void>((resolve) =>
      chrome.storage.local.remove(SESSION_TOKEN_KEY, () => resolve()),
    );
    setAccount({ kind: "signed_out" });
  }

  function tierLabel(tier: AccountStateSignedIn["tier"]): string {
    if (tier === "lifetime") return "Lifetime";
    if (tier === "yearly") return "Yearly";
    if (tier === "pro") return "Pro";
    return "Free";
  }

  function tierColor(tier: AccountStateSignedIn["tier"]): string {
    if (tier === "lifetime" || tier === "yearly" || tier === "pro") {
      return "#00c89a";
    }
    return "#888";
  }

  return (
    <div style={{ maxWidth: 600, margin: "40px auto", fontFamily: "system-ui" }}>
      <h1>Antares Scanner Settings</h1>

      <div style={{ marginBottom: 16 }}>
        <label>
          <input
            type="checkbox"
            checked={stealthMode}
            onChange={(e) => {
              setStealthMode(e.target.checked);
              void chrome.storage.local.set({
                antares_stealth: e.target.checked,
              });
            }}
          />
          {" "}Stealth Mode (hide overlay on pages)
        </label>
      </div>
      <div style={{ marginBottom: 16 }}>
        <label>
          <input
            type="checkbox"
            checked={autoRescan}
            onChange={(e) => {
              setAutoRescan(e.target.checked);
              void chrome.storage.local.set({ autoRescan: e.target.checked });
            }}
          />
          {" "}Auto-rescan on price crash (&gt;30% drop in 1h)
        </label>
      </div>

      {/* ── Account section ────────────────────────────────────────────── */}
      {/* Pro is activated automatically when this extension carries a
          valid Antares session token. The website's bridge content
          script writes the token to chrome.storage.local on login and
          clears it on logout — no manual key paste anywhere. */}
      <h2 style={{ marginTop: 36 }}>Account</h2>

      {account.kind === "loading" && (
        <p style={{ color: "#888", fontSize: 13 }}>Checking account…</p>
      )}

      {account.kind === "signed_out" && (
        <>
          <p style={{ color: "#555", fontSize: 13, lineHeight: 1.6 }}>
            Sign in to your Antares account to activate Pro features on
            this device. Your subscription syncs automatically across every
            device where you sign in — no codes to copy, no setup needed.
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={openSignIn}
              style={{
                padding: "10px 18px",
                fontSize: 14,
                fontWeight: 600,
                background: "#00c89a",
                color: "#0a0a0c",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Sign in / Create account
            </button>
            <button
              type="button"
              onClick={() => {
                void chrome.tabs.create({ url: `${WEBSITE_BASE}/pricing.html` });
              }}
              style={{
                padding: "10px 18px",
                fontSize: 14,
                fontWeight: 600,
                background: "#fff",
                color: "#0a0a0c",
                border: "1px solid #ccc",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              View pricing
            </button>
          </div>
        </>
      )}

      {account.kind === "signed_in" && (
        <>
          <div
            style={{
              padding: 14,
              background: "rgba(0,200,154,0.06)",
              border: "1px solid rgba(0,200,154,0.4)",
              borderRadius: 4,
              marginTop: 4,
            }}
          >
            <div style={{ fontSize: 11, color: "#888", letterSpacing: ".15em", textTransform: "uppercase", marginBottom: 4 }}>
              Signed in
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#222", marginBottom: 8 }}>
              {account.email}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".15em",
                  textTransform: "uppercase",
                  padding: "3px 8px",
                  background: tierColor(account.tier),
                  color: "#fff",
                  borderRadius: 2,
                }}
              >
                {tierLabel(account.tier)}
              </span>
              {account.expiresAt && account.tier !== "lifetime" && (
                <span style={{ fontSize: 12, color: "#666" }}>
                  Renews / expires{" "}
                  {new Date(account.expiresAt).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={() => {
                void chrome.tabs.create({
                  url: `${WEBSITE_BASE}/account.html`,
                });
              }}
              style={{
                padding: "9px 16px",
                fontSize: 13,
                fontWeight: 600,
                background: "#0f0f11",
                color: "#fff",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Open account page
            </button>
            <button
              type="button"
              onClick={() => void signOut()}
              style={{
                padding: "9px 16px",
                fontSize: 13,
                fontWeight: 600,
                background: "#fff",
                color: "#0a0a0c",
                border: "1px solid #ccc",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              Sign out
            </button>
          </div>
          {account.tier === "free" && (
            <p style={{ fontSize: 12, color: "#888", marginTop: 12, lineHeight: 1.6 }}>
              You're signed in but no active Pro subscription found.{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void chrome.tabs.create({
                    url: `${WEBSITE_BASE}/pricing.html`,
                  });
                }}
                style={{ color: "#00a37e" }}
              >
                Upgrade to Pro →
              </a>
            </p>
          )}
        </>
      )}

      {account.kind === "error" && (
        <p
          role="alert"
          style={{
            padding: 12,
            background: "rgba(255,95,95,0.06)",
            border: "1px solid rgba(255,95,95,0.4)",
            borderRadius: 4,
            fontSize: 13,
            color: "#a04040",
          }}
        >
          {account.message}
        </p>
      )}

      {/* ── Notifications section ──────────────────────────────────────
           Antares fires a single category of OS-level system notification:
           when a token you previously scanned is re-scanned and its risk
           tier has worsened (e.g. CAUTION → DANGER). The real trigger
           depends on live token data changing between two scans of the
           same contract — impossible to deterministically reproduce
           during a review window. This button fires the SAME shape of
           notification on demand so reviewers can validate the feature
           visually in <1 second. */}
      <h2 style={{ marginTop: 36 }}>Notifications</h2>
      <p style={{ color: "#555", fontSize: 13, lineHeight: 1.6 }}>
        Antares sends a system notification when a token you previously
        scanned gets re-scanned and its risk tier has worsened
        (e.g. CAUTION → DANGER). This is the only kind of notification
        the extension ever fires — no marketing, no engagement pings.
        Click below to preview what the alert looks like on your system.
      </p>
      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
        <button
          type="button"
          onClick={triggerTestNotification}
          style={{
            padding: "10px 18px",
            fontSize: 13,
            fontWeight: 600,
            background: "#0f0f11",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Send test notification
        </button>
        {notifTestState === "sent" && (
          <span style={{ fontSize: 13, color: "#00a37e", fontWeight: 600 }}>
            ✓ Sent — check your system notification area
          </span>
        )}
        {notifTestState === "blocked" && (
          <span style={{ fontSize: 13, color: "#c04040", fontWeight: 600 }}>
            ✕ Blocked by your OS or browser settings
          </span>
        )}
      </div>

      <h2 style={{ marginTop: 36 }}>This install</h2>
      <p style={{ color: "#555", fontSize: 13, lineHeight: 1.6 }}>
        Anonymous identifier for your local install. Used by the API to
        track quota and tier — never sent to third parties. Reset by
        uninstalling + reinstalling the extension.
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
        Force a tier on the server side for this install. Only takes
        effect when the install id above is listed in the server's
        <code
          style={{
            margin: "0 4px",
            padding: "1px 6px",
            background: "#f5f5f5",
            border: "1px solid #ddd",
            borderRadius: 3,
            fontSize: 12,
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
          }}
        >
          DEV_PRO_INSTALLS
        </code>
        env var. Use it to flip between Free / Pro / Lifetime in real
        time and verify what each tier sees in the overlay.
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
          {" "}with every scan. Server only honours this if your install
          id is dev-listed; otherwise it's ignored.
        </p>
      )}

      <h2>About</h2>
      <p>Antares — real-time Solana token scanner.</p>
      <p>Version: {version}</p>
      <p>
        <a
          href="https://antares-extension.vercel.app/privacy"
          target="_blank"
          rel="noreferrer"
        >
          Privacy Policy
        </a>
      </p>
    </div>
  );
}

export default Options;
