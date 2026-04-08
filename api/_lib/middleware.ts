// api/middleware.ts — CORS, rate limiting, and input validation middleware
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { CA_RE } from "./constants";
import { isCorsAllowed, apiError } from "./helpers";

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
  "https://neo.bullx.io",
  "https://gmgn.ai",
  "https://app.telemetry.io",
  "https://antares-extension.vercel.app",
];

// ——— RATE LIMITERS ————————————————————————————————————————————
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

export function setCorsHeaders(req: VercelRequest, res: VercelResponse): boolean {
  const origin = (req.headers.origin as string) || "";

  // chrome-extension:// origins: allow via rate limiting.
  // If ANTARES_EXT_TOKEN is configured, validate it. Otherwise allow all extensions.
  if (origin.startsWith("chrome-extension://")) {
    const expectedToken = process.env.ANTARES_EXT_TOKEN || "";
  // PROD GUARD: reject all requests if token is not configured in production
  if (!expectedToken && process.env.NODE_ENV === "production") {
    console.error("[SECURITY] ANTARES_EXT_TOKEN is not set in production!");
    res.status(503).json({ error: "Service misconfigured" });
    return false;
  }
    if (expectedToken) {
      const extToken = (req.headers["x-antares-token"] as string) || "";
      if (extToken !== expectedToken) {
        return false;
      }
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Antares-Token");
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Antares-Key, X-Antares-Token, Authorization");
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

export async function checkRateLimit(res: VercelResponse, ip: string): Promise<boolean> {
  // Fail-closed: if Redis was configured but limiters are null (init failed), block requests
  if (redisConfigured && !ratelimit) {
    console.warn("[antares] Rate limiter unavailable — fail-closed");
    apiError(res, 503, "Service temporarily unavailable. Please retry.");
    return false;
  }

  if (ratelimit) {
    const { success, remaining } = await ratelimit.limit(ip);
    res.setHeader("X-RateLimit-Limit", "30");
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    if (!success) {
      apiError(res, 429, "Too many requests. Please slow down.");
      return false;
    }
  }

  if (burstRatelimit) {
    const { success } = await burstRatelimit.limit(ip);
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
