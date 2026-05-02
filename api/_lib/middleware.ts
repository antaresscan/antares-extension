// api/middleware.ts — CORS, rate limiting, and input validation middleware
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { CA_RE } from "./constants";
import { isCorsAllowed, apiError } from "./helpers";
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
  "https://antares-website.vercel.app",
];

// ——— RATE LIMITERS ————————————————————————————————————————————————————————————
let ratelimit: Ratelimit | null = null;
let burstRatelimit: Ratelimit | null = null;

// When true, Redis was configured but failed to initialize — fail closed
let redisConfigured = false;

export function initRateLimiters(redis: Redis): void {
  redisConfigured = true;
  ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(30, "60 s"),
    analytics: false,
    prefix: "antares_rl",
  });
  burstRatelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(5, "10 s"),
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

export function setCorsHeaders(req: VercelRequest, res: VercelResponse): boolean {
  const origin = (req.headers.origin as string) || "";

      // chrome-extension:// origins: allow all extensions via rate limiting
    if (origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Antares-Token, X-Antares-Install");
    res.setHeader("Access-Control-Expose-Headers", EXPOSED_RESPONSE_HEADERS);
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return true;
  }

  // Fix: Allow same-origin requests (token.html -> /api/scan on same domain)
  // Browsers don't send Origin header for same-origin fetch requests.
  if (!origin) {
    const referer = (req.headers.referer as string) || "";
    if (referer.startsWith("https://antares-extension.vercel.app")) {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
      return true;
    }
  }

  const corsOk = isCorsAllowed(origin, ALLOWED_ORIGINS);
  if (corsOk) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Antares-Key, X-Antares-Token, X-Antares-Install, Authorization");
  res.setHeader("Access-Control-Expose-Headers", EXPOSED_RESPONSE_HEADERS);
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
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
    res.setHeader("X-RateLimit-Limit", "30");
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
