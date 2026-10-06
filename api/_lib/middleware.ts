// api/middleware.ts — CORS, rate limiting, and input validation middleware
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { CA_RE } from "./constants";
import { isCorsAllowed, isOriginInList, apiError } from "./helpers";
import { logger } from "./logger";

export const ALLOWED_ORIGINS = [
  "https://dexscreener.com",
  "https://birdeye.so",
  "https://axiom.trade",
  "https://pump.fun",
  "https://jup.ag",
  "https://raydium.io",
  "https://solscan.io",
  "https://www.geckoterminal.com",
  "https://photon-sol.tinyastro.io",
  "https://gmgn.ai",
  "https://app.telemetry.io",
  "https://antares-extension.vercel.app",
  // Website is now served from the custom domain antaresscan.com (alias of
  // the antares-website Vercel deployment). Login / signup / logout / sync
  // calls from auth.html and account.html on antaresscan.com hit
  // /api/auth/* with credentials:include — without these origins in the
  // allowlist the OPTIONS preflight 403s and the user can't sign in OR
  // log out cleanly (the website thinks it logged you out, but the
  // extension's cached JWT keeps the overlay on Pro indefinitely).
  //
  // The legacy antares-website.vercel.app alias stays because existing
  // clients may still cache that URL. The old GitHub Pages mirror
  // (comealamaisongroupe.github.io) is gone on purpose: the GitHub account
  // behind it no longer exists, so anyone could register the name and
  // serve a page from it.
  "https://antaresscan.com",
  "https://www.antaresscan.com",
  "https://antares-website.vercel.app",
];

/**
 * Origins allowed to exchange cookies with the API (CORS credentials).
 *
 * Deliberately a short EXACT-match list, separate from ALLOWED_ORIGINS:
 *   - ALLOWED_ORIGINS answers "may this page read public scan data?". It
 *     includes the third-party trading sites the content script runs on,
 *     plus website previews, none of which we control.
 *   - CREDENTIALED_ORIGINS answers "may this page act as the signed-in
 *     user?". Only the first-party website qualifies. The session cookie is
 *     SameSite=None, so any origin that receives Allow-Credentials can call
 *     /api/auth/sync-token with the visitor's cookie, read the 30-day JWT
 *     and bind its own install to their account.
 *
 * chrome-extension:// origins are handled separately in setCorsHeaders.
 */
export const CREDENTIALED_ORIGINS = [
  "https://antaresscan.com",
  "https://www.antaresscan.com",
  "https://antares-website.vercel.app",
  "https://antares-extension.vercel.app",
];

export interface CorsOptions {
  /**
   * Accept ONLY credentialed origins (first-party website + the extension).
   * Set it on every endpoint that reads or changes account state: any other
   * allowed origin (trading sites, website previews) then gets a 403 and no
   * Access-Control-Allow-Origin header at all.
   */
  credentialedOnly?: boolean;
}

// ——— RATE LIMITERS ————————————————————————————————————————————————————————————
let ratelimit: Ratelimit | null = null;
let burstRatelimit: Ratelimit | null = null;

// When true, Redis was configured but failed to initialize — fail closed
let redisConfigured = false;

export function initRateLimiters(redis: Redis): void {
  redisConfigured = true;
  // ── Per-user rate limits ─────────────────────────────────────────────
  // Keyed by (ip:install_id) — these are PER-USER limits, not global.
  // 1000 active users each at burst capacity = 60K req/10s globally,
  // which is well within Vercel Pro + Upstash Pro 2K capacity. The
  // numbers here exist to stop ONE abuser, not to throttle aggregate
  // traffic.
  //
  // Earlier limits (5/10s burst + 30/60s sustained) blocked a power
  // user who opened 8 DexScreener tabs at once — scans 6-8 hit 429
  // "Burst limit exceeded" and went through the 3-retry exponential-
  // backoff chain (up to 10s wait), which read as "scans are
  // randomly broken" in the UI.
  //
  // New values support a realistic power-user workflow:
  //  - Open 15+ token tabs in rapid succession  → fits in 20/10s burst
  //  - Sustained 1 scan/sec for a minute        → fits in 60/60s
  //  - Anything beyond is a bot / scraper       → 429s as intended
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, "60 s"),
    analytics: false,
    prefix: "antares_rl",
  });
  burstRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(20, "10 s"),
    analytics: false,
    prefix: "antares_burst",
  });
}

// Headers that client JS needs to read (rate limit + quota status). Without
// being listed here the browser blocks fetch().headers.get() from returning
// them on cross-origin responses.
const EXPOSED_RESPONSE_HEADERS = [
  "X-Request-Id",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "X-Antares-Quota-Tier",
  "X-Antares-Quota-Limit",
  "X-Antares-Quota-Used",
  "X-Antares-Quota-Remaining",
  "X-Antares-Quota-Reset",
  "Retry-After",
].join(", ");

export function setCorsHeaders(
  req: VercelRequest,
  res: VercelResponse,
  opts: CorsOptions = {},
): boolean {
  const origin = (req.headers.origin as string) || "";

  // ALWAYS set Vary: Origin first, before any conditional branches.
  //
  // Why: every response goes through the Vercel edge cache with
  // `Cache-Control: s-maxage=15, stale-while-revalidate=30` (set
  // below). Without Vary: Origin on every response, the CDN can
  // cache a no-Origin response (e.g. an internal probe, a same-
  // origin healthcheck, a curl from Vercel's deployment process)
  // and then serve that same cache entry to a browser preflight
  // that DID send an Origin. The browser preflight then arrives
  // with no `Access-Control-Allow-*` headers and CORS fails with
  // "Failed to fetch" — intermittently, depending on which request
  // populated the 15-second cache window.
  //
  // This was the root cause of the long-running "login works
  // sometimes, fails sometimes" pain reported on antares-website.
  // Setting Vary: Origin unconditionally forces the CDN to key on
  // origin so the no-Origin and origin-bearing responses live in
  // separate cache entries.
  res.setHeader("Vary", "Origin");

      // chrome-extension:// origins: allow all extensions via rate limiting
    if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Antares-Token, X-Antares-Install, X-Antares-Dev-Tier, X-Antares-Session");
    // Allow the session cookie set by the website (login on the website
    // origin sets a cookie for the API origin) to flow on extension scan
    // calls — that's what gates tier post-logout. Without credentials,
    // the cookie is dropped and we'd always read "no session → Free".
    // (The X-Antares-Session header is the more reliable path — see
    // api/_lib/session-cookie.ts:readSessionToken — but we keep cookies
    // working too as a fallback.)
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_RESPONSE_HEADERS);
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return true;
  }

  // Allow same-origin requests (token.html -> /api/scan on the same Vercel
  // deployment) — browsers omit the Origin header for these. We trust the
  // Host header (which Vercel populates from the actual served deployment
  // and uses for routing) rather than Referer (which any non-browser client
  // can trivially forge with `curl -H Referer:...`). Pattern matches the
  // production host plus preview deploys of this same project; other
  // *.vercel.app projects do NOT match.
  if (!origin) {
    const host = ((req.headers.host as string) || "").toLowerCase();
    if (
      host === "antares-extension.vercel.app" ||
      /^antares-extension(-[a-z0-9-]+)?\.vercel\.app$/.test(host)
    ) {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
      return true;
    }
  }

  const credentialed = isOriginInList(origin, CREDENTIALED_ORIGINS);
  const corsOk = opts.credentialedOnly
    ? credentialed
    : isCorsAllowed(origin, ALLOWED_ORIGINS);
  if (corsOk) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // Allow cross-site cookies (the session cookie set by the API origin
    // has to flow on website-origin fetches). Browsers refuse to attach
    // cookies cross-site unless the response carries this header AND
    // the request was made with `credentials: "include"`.
    //
    // First-party origins only. Trading sites and website previews can read
    // public scan data, but must never be able to act as the signed-in user.
    if (credentialed) {
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Antares-Key, X-Antares-Token, X-Antares-Install, X-Antares-Dev-Tier, X-Antares-Session, Authorization");
  res.setHeader("Access-Control-Expose-Headers", EXPOSED_RESPONSE_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
  // OPTIONS preflight responses must not be CDN-cached: their CORS
  // headers depend on the request's Origin, and even with Vary: Origin
  // the safest default is to keep them un-cached at the edge so a
  // misbehaving probe can never poison a credentialed flow. Real
  // (non-OPTIONS) responses keep the existing s-maxage=15 freshness
  // window — that's the cheap-cache hot path for /api/scan etc.
  if (req.method === "OPTIONS") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  } else {
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  }
  return corsOk;
}

export function getClientIp(req: VercelRequest): string {
  return (
    (req.headers["x-real-ip"] as string)?.trim() ||
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    (req.socket as { remoteAddress?: string } | undefined)?.remoteAddress ||
    "unknown"
  );
}

// Matches UUIDv4-style install identifiers plus short opaque tokens up to
// 128 chars. Strict validation here is deliberate: the id becomes part of a
// Redis key, so we must bound its shape to prevent key-space explosion from
// a malicious client supplying arbitrary-length garbage.
const INSTALL_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

// Reads an optional X-Antares-Install header. When an extension supplies a
// stable per-install identifier we use it alongside the IP for rate-limiting.
// That closes the shared-IP gap: multiple users on the same corporate NAT
// each get their own quota, and a single abusive installation can be rate-
// limited without punishing the whole IP. Missing/invalid header falls back
// to IP-only, preserving behaviour for legacy clients and web requests.
export function getInstallId(req: VercelRequest): string | null {
  const raw = req.headers["x-antares-install"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return INSTALL_ID_RE.test(trimmed) ? trimmed : null;
}

export async function checkRateLimit(res: VercelResponse, ip: string, installId: string | null = null): Promise<boolean> {
  // Fail-closed: if Redis was configured but limiters are null (init failed), block requests
  if (redisConfigured && !ratelimit) {
    logger.warn("middleware", "Rate limiter unavailable — fail-closed");
    apiError(res, 503, "Service temporarily unavailable. Please retry.");
    return false;
  }

  // When an install id is present we key by (ip, install) so each install
  // gets its own window. Without one we fall back to IP-only.
  const key = installId ? `${ip}:${installId}` : ip;

  if (ratelimit) {
    const { success, remaining } = await ratelimit.limit(key);
    res.setHeader("X-RateLimit-Limit", "60");
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    if (!success) {
      apiError(res, 429, "Too many requests. Please slow down.");
      return false;
    }
  }

  if (burstRatelimit) {
    const { success } = await burstRatelimit.limit(key);
    if (!success) {
      res.setHeader("Retry-After", "10");
      apiError(res, 429, "Burst limit exceeded. Retry in 10 seconds.");
      return false;
    }
  }

  return true;
}

export function validateCA(ca: unknown): string | null {
  const trimmed = typeof ca === "string" ? ca.trim() : "";
  return CA_RE.test(trimmed) ? trimmed : null;
}
