// __tests__/privacy-page.test.ts
//
// privacy.html (audit A-14b). The page said "we do not collect names, emails" and "there is typically no data to access or delete" while the API
// stored accounts, licences and a scan history, and it said "Hashed IP" while the rate limiter keys on the address itself. A privacy policy that
// is false is a legal risk, and it had been false for months because nothing tied it to the code.
//
// Now the page is tied to the code on three points:
//   1. the sentences that were false cannot come back;
//   2. every number of the retention section is read from the constant that produces it: change a duration in the code and this test fails until
//      the page says the same;
//   3. every outside service the API calls is named in the table of processors ("we do not use processors beyond this list").
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { INTENT_RETENTION_SECONDS } from "../api/_lib/payments";
import { LOGIN_FAILURE_WINDOW_SECONDS } from "../api/_lib/login-guard";
import { HISTORY_HARD_CAP, HISTORY_DAY_WINDOW } from "../api/_lib/user";
import { LAST_GOOD_TTL_SEC } from "../api/_lib/cache";
import { RUGCHECK_MEMORY_TTL_S } from "../api/_lib/rugcheck-memory";
import { computeCacheTTL } from "../api/_lib/helpers";
import { signSession, verifySession, _resetSessionSecretCacheForTests, SESSION_MAX_AGE_SECONDS } from "../api/_lib/account";
import { ERASURE_SCAN_BUDGET_MS } from "../api/_lib/account-erasure";
import { PENDING_ACCOUNT_TTL_SECONDS, VERIFY_TOKEN_TTL_MS } from "../api/_lib/email-proof";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8").split(String.fromCharCode(13)).join("");
const html = read("privacy.html");
/** What a reader sees: no tags, one space between words. */
const text = html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
const section = (from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to));

describe("the sentences that were false do not come back", () => {
  it.each([
    ["we do not collect names, emails", /we do not collect (your )?names, emails/i],
    ["no data to access or delete", /no data to access or delete/i],
    ["typically no data", /there is typically no data/i],
    ["we do not store an identifier tied to you", /we do not store an identifier tied to you/i],
    ["hashed IP", /hashed ip/i],
    ["a rate-limit key that says nothing is derived from the identifier, when it is linked to an e-mail", /we cannot derive any personal information from it/i],
    ["no cookies at all", /sets no cookies\.\s*<\/li>|Cookies or tracking pixels\. The Extension sets no cookies/i],
  ])("%s", (_name, re) => {
    expect(text).not.toMatch(re);
    expect(html).not.toMatch(re);
  });

  it("is dated after the change, in the form of the other pages", () => {
    expect(text).toMatch(/Last updated: [A-Z][a-z]+ \d{1,2}, 20\d\d/);
    expect(text).not.toMatch(/Last updated: April 24, 2026/);
  });
});

describe("the page says what the API stores", () => {
  it.each([
    ["e-mail address of an account", /your e-mail address/i],
    ["the password is hashed", /password as a salted one-way hash/i],
    ["the sign-in cookie", /antares_session/],
    ["the scan history per install", /Scan history/],
    ["licences / the record of purchases", /purchase record/i],
    ["NOWPayments as a processor", /NOWPayments/],
    ["Resend as a processor (the e-mail proof, A-01)", /Resend/],
    ["the confirmation of the e-mail", /Confirming your e-mail/],
    ["the sign-up answers the same for every address", /same answer/],
    ["the install identifier is linked to the e-mail", /linked to your e-mail address/i],
    ["self-service deletion", /Delete account/],
    ["what deletion keeps", /not<\/strong> erased when you delete your account|NOT erased when you delete your account/i],
    ["how to delete without an account", /Options page/],
  ])("%s", (_name, re) => {
    expect(re.test(text) || re.test(html)).toBe(true);
  });

  it("lists, in section 9.1, what deleting an account removes, as the code does", () => {
    const nine1 = section("9.1 Delete your account yourself", "9.2 Without an account");
    for (const part of ["account (e-mail address, password hash", "link between your installs and your e-mail", "scan history and the plan stored on those installs"]) {
      expect(nine1, part).toContain(part);
    }
    // and the licences stay, as account-erasure.ts keeps them
    expect(nine1).toMatch(/purchase record/i);
  });
});

describe("the retention section is read from the code", () => {
  const days = (s: number) => s / 86400;
  const retention = section("7. Data retention", "8. Chrome permissions");

  it("checkout records: INTENT_RETENTION_SECONDS", () => {
    expect(days(INTENT_RETENTION_SECONDS)).toBe(7);
    expect(retention).toMatch(/Checkout records:\s*7 days/);
    expect(text).toMatch(/deleted automatically after 7 days/);
  });

  it("failed sign-in counter: LOGIN_FAILURE_WINDOW_SECONDS", () => {
    expect(LOGIN_FAILURE_WINDOW_SECONDS / 60).toBe(15);
    expect(retention).toMatch(/Failed sign-in counter:\s*15 minutes/);
    expect(text).toMatch(/for 15 minutes, a counter of failed sign-ins/);
  });

  it("scan history: HISTORY_HARD_CAP scans, shown for HISTORY_DAY_WINDOW days", () => {
    expect(HISTORY_HARD_CAP).toBe(1000);
    expect(HISTORY_DAY_WINDOW).toBe(30);
    expect(text).toMatch(/about the 1,000 most recent scans per install/);
    expect(text).toMatch(/only shows the last 30 days/);
    expect(text).toMatch(/not erased at 30 days/);
  });

  it("unconfirmed accounts: PENDING_ACCOUNT_TTL_SECONDS; confirmation links: VERIFY_TOKEN_TTL_MS (A-01)", () => {
    expect(PENDING_ACCOUNT_TTL_SECONDS / 3600).toBe(48);
    expect(VERIFY_TOKEN_TTL_MS / 3_600_000).toBe(24);
    expect(retention).toMatch(/Unconfirmed account:\s*48 hours/);
    expect(text).toMatch(/works for 24 hours/);
  });

  it("sessions: the cookie and the token last 30 days, and a session ends SESSION_MAX_AGE_SECONDS after the password was typed", () => {
    const kept = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = "0".repeat(64);
    _resetSessionSecretCacheForTests();
    try {
      const now = Date.now();
      const payload = verifySession(signSession("a@b.co", now), now)!;
      expect(payload.exp - payload.iat).toBe(30 * 86400);
    } finally {
      if (kept === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = kept;
      _resetSessionSecretCacheForTests();
    }
    const days = SESSION_MAX_AGE_SECONDS / 86400;
    expect(days).toBe(60);
    expect(retention).toContain(`A sign-in session ends at the latest ${days} days after you typed your password`);
    expect(text).toContain(`A session ends at the latest ${days} days after you typed your password`);
    expect(text).toMatch(/valid 30 days/);
  });

  it("cache: from the shortest to the longest computeCacheTTL, and the 6 hours of the last good answers", () => {
    const shortest = computeCacheTTL(0);
    const longest = computeCacheTTL(null, "RUG");
    expect(shortest).toBe(20);
    expect(longest).toBe(30 * 60);
    // nothing in between is longer than the RUG one, nothing shorter than the youngest token's
    for (const age of [null, 0, 29, 30, 59, 60, 1439, 1440, 10079, 10080, 99999]) {
      for (const v of [undefined, "SAFE", "CAUTION", "DANGER", "RUG"] as const) {
        const ttl = computeCacheTTL(age, v);
        expect(ttl).toBeGreaterThanOrEqual(shortest);
        expect(ttl).toBeLessThanOrEqual(longest);
      }
    }
    expect(retention).toMatch(/between 20 seconds .* and 30 minutes/);
    expect(LAST_GOOD_TTL_SEC / 3600).toBe(6);
    expect(RUGCHECK_MEMORY_TTL_S / 3600).toBe(6);
    expect(retention).toMatch(/up to 6 hours/);
  });

  it("the erasure answers inside a serverless call (the budget of account-erasure.ts)", () => {
    expect(ERASURE_SCAN_BUDGET_MS).toBeLessThan(10_000);
  });
});

describe("every outside service the API calls is named in the table of processors", () => {
  // host fragment found in the code of the API -> how the page names it
  const SERVICES: Array<[string, RegExp]> = [
    ["api.dexscreener.com", /DexScreener/],
    ["api.rugcheck.xyz", /RugCheck/],
    ["api.gopluslabs.io", /GoPlus/],
    ["mainnet.helius-rpc.com", /Helius/],
    ["api.helius.xyz", /Helius/],
    ["pro-api.solscan.io", /Solscan/],
    ["api.geckoterminal.com", /GeckoTerminal/],
    ["api.jup.ag", /Jupiter/],
    ["generativelanguage.googleapis.com", /Gemini/],
    ["api.nowpayments.io", /NOWPayments/],
    ["api.resend.com", /Resend/],
    ["solana-rpc.publicnode.com", /PublicNode/],
    ["api.mainnet-beta.solana.com", /Solana public RPC/],
  ];
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
    });
  const code = sources(resolve(process.cwd(), "api"))
    .map((f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""))
    .join("\n");
  const table = section("5. Third-party processors", "6. International transfers");

  it.each(SERVICES)("%s", (host, nameOnPage) => {
    expect(code, `${host} is not called by the API any more: take it out of this list and out of the page`).toContain(host);
    expect(table).toMatch(nameOnPage);
  });

  it("the API calls no outside host that this list does not know", () => {
    const known = new Set(SERVICES.map(([h]) => h));
    // our own domains, the pages people are sent to, and addresses that only appear as text are not services the API sends data to
    const ignore = /^(www\.)?(antaresscan\.com|antares-extension\.vercel\.app|vercel\.com|github\.com|solscan\.io|dexscreener\.com|birdeye\.so|pump\.fun|jup\.ag|raydium\.io|gmgn\.ai|axiom\.trade|photon-sol\.tinyastro\.io|app\.telemetry\.io|www\.geckoterminal\.com|documenter\.getpostman\.com|nowpayments\.io|solana\.com|docs\.sentry\.io|[a-z0-9-]+\.vercel\.app)$/;
    const hosts = new Set([...code.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()).filter((h) => h.includes(".") && !h.endsWith(".")));
    const unknown = [...hosts].filter((h) => !known.has(h) && !ignore.test(h));
    expect(unknown, "a new outside service: add it to the processors table of privacy.html, then to SERVICES here").toEqual([]);
  });
});

// ── Chrome permissions (audit A-14b, second pass) ───────────────────────────────────────────────────────────────────────────────────────────
// Section 8 used to say that `alarms` re-scans the tokens you watch (it is a one-minute keepalive), that `storage` holds a theme and alert
// thresholds (neither exists), that `activeTab` reads the page (nothing uses it), and that the Extension reads no browsing history (Chrome shows
// the `tabs` permission as "Read your browsing history"). The same sentences were in the Chrome Web Store texts of docs/cws. Now the page is tied
// to the manifest and to the code: add a permission, use `activeTab`, or add a second alarm, and this test fails until the page says it.
describe("the Chrome permissions section says what the code does", () => {
  const manifest = JSON.parse(read("package.json")).manifest as { permissions: string[]; host_permissions: string[] };
  const rawSection8 = html.slice(html.indexOf("<h2>8. Chrome permissions</h2>"), html.indexOf("<h2>9. Your rights</h2>"));
  const perms = section("8. Chrome permissions", "9. Your rights");
  const retention = section("7. Data retention", "8. Chrome permissions");
  const clientSources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (["node_modules", "__tests__", "api", "build", ".claude", ".plasmo", "e2e", "docs", "scripts"].includes(name)) return [];
      const p = join(dir, name);
      return statSync(p).isDirectory() ? clientSources(p) : /\.tsx?$/.test(p) && !/\.config\.ts$/.test(p) ? [p] : [];
    });
  const files = clientSources(process.cwd());
  const code = files.map((f) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
  const all = code.join("\n");

  it("lists exactly the permissions of the manifest", () => {
    const listed = [...rawSection8.matchAll(/<strong>([A-Za-z_]+)<\/strong>/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...manifest.permissions, "host_permissions"].sort());
  });

  it("the sentences that were false about permissions do not come back", () => {
    for (const re of [/theme/i, /alert thresholds/i, /periodic background re-?scan/i, /flagged for monitoring/i, /you(’|')re actively watching/i, /read the URL and the visible page DOM on supported sites only/i, /No browsing history/i]) {
      expect(perms, String(re)).not.toMatch(re);
      expect(retention, String(re)).not.toMatch(re);
    }
  });

  it("the numbers come from the code: scans kept on the device, cache size, alarm interval", () => {
    const maxHistory = Number(/maxHistoryEntries:\s*(\d+)/.exec(readFileSync("shared/config.ts", "utf8"))![1]);
    const maxCache = Number(/SCAN_CACHE_MAX_ENTRIES\s*=\s*(\d+)/.exec(readFileSync("contents/modules/constants.ts", "utf8"))![1]);
    const everyMinutes = Number(/keepaliveIntervalMinutes:\s*(\d+)/.exec(readFileSync("shared/config.ts", "utf8"))![1]);
    expect(perms).toContain(`your ${maxHistory} most recent scans`);
    expect(perms).toContain(`up to ${maxCache} recent scan results`);
    expect(everyMinutes).toBe(1);
    expect(perms).toContain("fires every minute");
  });

  it("alarms: there is exactly one alarm, the keepalive, so the page may not say the Extension re-scans in the background", () => {
    expect(all.match(/chrome\.alarms\.create\(/g)?.length).toBe(1);
    expect(all).toContain("chrome.alarms.create(config.keepaliveAlarmName");
    expect(perms).toMatch(/alarms<\/strong>|alarms /);
    expect(perms).toMatch(/It scans nothing and sends nothing/);
  });

  it("activeTab: nothing in the code needs it, and the page says so (if you use it, change the page)", () => {
    expect(all, "the code now uses activeTab: say what for in section 8 and in docs/cws/permission-justifications.md").not.toMatch(/chrome\.scripting|captureVisibleTab/);
    expect(perms).toMatch(/activeTab\s*—\s*declared in the manifest, but the current version of the Extension does not use it/);
  });

  it("tabs: the only places that read the tabs are the two in background.ts that the page describes", () => {
    const queries = files.flatMap((f, i) => (code[i].match(/chrome\.tabs\.query\(/g) ?? []).map(() => relative(process.cwd(), f).split("\\").join("/")));
    expect(queries).toEqual(["background.ts", "background.ts"]);
    expect(perms).toMatch(/Read your browsing history/);
    expect(perms).toMatch(/none is stored or sent/);
  });

  it("notifications: only the worsened-verdict alert and the Options test button create one", () => {
    const creators = files.flatMap((f, i) => (code[i].match(/chrome\.notifications\.create\(/g) ?? []).map(() => relative(process.cwd(), f).split("\\").join("/")));
    expect(creators.sort()).toEqual(["background.ts", "options.tsx"]);
    expect(perms).toMatch(/worse verdict than the last one this device saw/);
    expect(perms).toMatch(/test notification/);
  });

  it("the Chrome Web Store justifications describe every permission and host, and not the old fiction", () => {
    const cws = read("docs/cws/permission-justifications.md");
    for (const p of manifest.permissions) expect(cws, p).toContain("### `" + p + "`");
    for (const h of manifest.host_permissions) expect(cws, h).toContain("### `" + h + "`");
    for (const re of [/Reserved for the upcoming Pro v2/i, /No notifications fire/i, /5-second forced rescan/i, /Periodic clean-up of the local scan cache/i, /Required by `chrome\.tabs\.create`/, /antares-website\.vercel\.app\/privacy/]) {
      expect(cws, String(re)).not.toMatch(re);
    }
    expect(cws).toContain("Privacy policy URL: https://antaresscan.com/privacy");
  });

  it("the store listings do not say that no browsing history is read, nor that the scan history is a Pro feature bound to the account", () => {
    for (const f of ["docs/cws/store-listing-en.md", "docs/cws/store-listing-fr.md"]) {
      const listing = read(f);
      expect(listing, f).not.toMatch(/cookies, or browsing history|cookies ou\s+historique de navigation/);
      expect(listing, f).not.toMatch(/Scan history \(Pro feature\)|L'historique de scans \(feature Pro\)/);
    }
  });
});
