// api/middleware.ts — CORS, rate limiting, and input validation middleware
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { CA_RE } from "./constants";
import { isCorsAllowed, apiError } from "./helpers";

// ——— ANTARES EXTENSION KEY ———————————————————————————————————
// chrome-extension:// origins must present this key to use the API.
// Set ANTARES_API_KEY in your Vercel environment variables.
const ANTARES_KEY = process.env.ANTARES_API_KEY || "";

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

  // Fix(Bug 19): For chrome-extension:// origins, require X-Antares-Key header.
  // This prevents rogue extensions from abusing the API for free.
  if (origin.startsWith("chrome-extension://")) {
    const key = req.headers["x-antares-key"];
    if (!ANTARES_KEY || key !== ANTARES_KEY) {
      return false;
    }
  }

  const corsOk = isCorsAllowed(origin, ALLOWED_ORIGINS);

  if (corsOk) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Antares-Key");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  return corsOk;
}

export function getClientIp(req: VercelRequest): string {
  return (
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
