// js/links.js — the two links the Full Analysis page shows under the token's name: its WEBSITE and its TWITTER / X account. Nothing else.
//
// DexScreener hands back whatever the token's creator typed: a list of websites and a list of socials (Twitter, Telegram, TikTok, Instagram, Reddit, Shopify...).
// The page used to draw one chip for each of them, and its link guard (a short list of trusted hosts, made for explorers and exchanges) turned every other address
// into "#": a token's own website is, by definition, not on that list, so the Website chip opened this same page again in a new tab (2026-10-15).
//
// What is shown now, and why it is always the right link:
//   - Website: the FIRST address of `websites` that is a real web address (http or https, no login in it, a real domain name: no IP address, no "localhost") and that
//     is not itself a social platform. An address typed without its scheme ("example.com") is completed with https://. `javascript:`, `data:` and the like are never links.
//   - Twitter: the FIRST address of `socials` that is a Twitter / X account (the host is x.com or twitter.com, with a path: an account, a post or a community) and is
//     labelled twitter or x, or is on x.com / twitter.com. A "twitter" entry that points anywhere else is dropped, never shown as a Twitter link.
//   - Anything else (Telegram, TikTok, Instagram, Reddit, Shopify, a second site...) is not shown.
// A chip with no valid address is not shown at all: no dead "#" link. Pure, no DOM: tested in __tests__/token-links.test.ts.

/** Platforms that are not "the website" of a project: a Website entry that points at one of them is a social account. */
const SOCIAL_HOSTS = [
  "x.com", "twitter.com", "t.me", "telegram.me", "telegram.org", "telegram.dog", "discord.gg", "discord.com", "instagram.com", "tiktok.com",
  "reddit.com", "facebook.com", "fb.com", "youtube.com", "youtu.be", "linkedin.com", "threads.net", "bsky.app", "warpcast.com",
];
const TWITTER_HOSTS = ["x.com", "twitter.com"];
/** A "domain" whose last part is a file extension is a file name (token.html, logo.png), not a website: it is never a link, whatever precedes it. */
const FILE_ENDINGS = new Set(["html", "htm", "php", "asp", "aspx", "jsp", "js", "mjs", "css", "json", "txt", "md", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "pdf", "xml"]);

const onHost = (host, list) => list.some((d) => host === d || host.endsWith("." + d));

/**
 * A web address a creator typed, as a URL we may link to, or null. http and https only, no user:password in it, a real domain name, nothing that is not a plain address.
 * Returns { url, host } (host without a trailing dot, lower case, punycode for an international name).
 */
export function parseWebUrl(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.length > 2048 || /[\s<>"'`\\]/.test(s)) return null;
  // "example.com" or "//example.com": the scheme was left out. Anything that already has one is judged as it is (javascript: and data: fail below).
  // A path of this very site ("/token.html") is not an address: completed with https:// it would read as a domain called "token.html".
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (/^\/(?!\/)/.test(s)) return null;
    s = "https://" + s.replace(/^\/\//, "");
  }
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[")) return null; // no dot: "localhost", an intranet name; "[": an IPv6 address
  if (/\.(local|localhost|internal|lan|home|corp)$/.test(host)) return null;
  const ending = host.split(".").pop() ?? "";
  // The last part must be a real ending (.com, .xyz, .fun...): letters, never digits (so no IPv4 address), and never a file extension.
  if (!/^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(ending) || FILE_ENDINGS.has(ending)) return null;
  return { url, host };
}

/** A Twitter / X address (an account, a post, a community), as { href, title }, or null. Always https. */
function parseTwitterUrl(raw) {
  const p = parseWebUrl(raw);
  if (!p || !onHost(p.host, TWITTER_HOSTS)) return null;
  const segments = p.url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null; // x.com alone is not an account
  p.url.protocol = "https:";
  return { href: p.url.href, title: "x.com/" + segments.join("/").slice(0, 60) };
}

/**
 * The links to show: { website: { href, title } | null, twitter: { href, title } | null }. `websites` is DexScreener's `info.websites` ([{ url, label }]),
 * `socials` its `info.socials` ([{ type, url }]); anything that is not a list of such entries gives no link.
 */
export function officialLinks(websites, socials) {
  let website = null;
  for (const w of Array.isArray(websites) ? websites : []) {
    const p = parseWebUrl(w && w.url);
    if (p && !onHost(p.host, SOCIAL_HOSTS)) { website = { href: p.url.href, title: p.host }; break; }
  }
  let twitter = null;
  for (const s of Array.isArray(socials) ? socials : []) {
    if (!s || typeof s !== "object") continue;
    const typed = /^(twitter|x)$/i.test(String(s.type ?? "").trim());
    const p = parseWebUrl(s.url);
    if (!typed && !(p && onHost(p.host, TWITTER_HOSTS))) continue;
    twitter = parseTwitterUrl(s.url);
    if (twitter) break; // a "twitter" entry that leads elsewhere is skipped, the next one is looked at
  }
  return { website, twitter };
}

// ─── The explorer links of the page ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Solscan, RugCheck and DexScreener addresses are built from an id the API gave (a token, a wallet, a transaction). An id that is not what it should be used to give a
// link to nothing ("solscan.io/tx/" with no signature) or, through the trusted-host guard, "#" (which reopens this page). Now an id is checked first, and when it
// is not good there is NO link: the caller draws a button that does nothing. Never a link at random, never "#".
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

/** A Solana address (a token mint or a wallet): 32 to 44 characters of base58. */
export const isSolanaAddress = (s) => typeof s === "string" && SOLANA_ADDRESS.test(s);
/** A Solana transaction signature: 80 to 90 characters of base58. */
export const isSolanaSignature = (s) => typeof s === "string" && SOLANA_SIGNATURE.test(s);

/**
 * The address of `id` on an explorer, or null when `id` is not a valid one for that kind.
 * kind: "token" | "account" | "tx" (Solscan), "rugcheck" (RugCheck), "dexscreener" (DexScreener's page of a token).
 */
export function explorerUrl(kind, id) {
  switch (kind) {
    case "token": return isSolanaAddress(id) ? "https://solscan.io/token/" + id : null;
    case "account": return isSolanaAddress(id) ? "https://solscan.io/account/" + id : null;
    case "tx": return isSolanaSignature(id) ? "https://solscan.io/tx/" + id : null;
    case "rugcheck": return isSolanaAddress(id) ? "https://rugcheck.xyz/tokens/" + id : null;
    case "dexscreener": return isSolanaAddress(id) ? "https://dexscreener.com/solana/" + id : null;
    default: return null;
  }
}

/**
 * DexScreener's page for this token: the pair address the API gave when it is an https address on dexscreener.com, else the token's own page there, else null.
 * (A pair address on another host is never followed: it used to become "#", which reopened this page.)
 */
export function dexscreenerLink(pairUrl, mint) {
  const p = parseWebUrl(pairUrl);
  if (p && p.url.protocol === "https:" && (p.host === "dexscreener.com" || p.host.endsWith(".dexscreener.com"))) return p.url.href;
  return explorerUrl("dexscreener", mint);
}
