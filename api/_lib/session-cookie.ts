// api/_lib/session-cookie.ts — HTTP-only session cookie helpers.
//
// We're set up cross-origin: the website lives at antares-website.vercel.app
// and the API at antares-extension.vercel.app. To make session cookies
// flow between them we need:
//   - SameSite=None (cross-site requests included)
//   - Secure         (required when SameSite=None)
//   - HttpOnly       (defense against XSS — JS can't read it)
//   - Path=/         (every API endpoint sees it)
//
// The browser stores the cookie against the API origin; subsequent
// fetch() calls from the website with `credentials: "include"` will
// send it back. The CORS middleware sets
// `Access-Control-Allow-Credentials: true` so the cross-site write
// is permitted.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { signSession, verifySession, getAccount, type Account } from "./account";

export const SESSION_COOKIE_NAME = "antares_session";

/**
 * 30-day TTL on the cookie too — matches the JWT exp inside it. The
 * browser deleting the cookie at TTL also stops auto-sending an expired
 * token, which would just 401 us anyway.
 */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface CookieAttrs {
  /** Optional override for tests. Defaults to production attrs. */
  secure?: boolean;
  sameSite?: "None" | "Lax" | "Strict";
}

export function buildSessionCookie(
  token: string,
  attrs: CookieAttrs = {},
): string {
  const secure = attrs.secure ?? true;
  const sameSite = attrs.sameSite ?? "None";
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearSessionCookie(attrs: CookieAttrs = {}): string {
  const secure = attrs.secure ?? true;
  const sameSite = attrs.sameSite ?? "None";
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(
  res: VercelResponse,
  emailLc: string,
  attrs: CookieAttrs = {},
): void {
  const token = signSession(emailLc);
  res.setHeader("Set-Cookie", buildSessionCookie(token, attrs));
}

export function clearSessionCookie(
  res: VercelResponse,
  attrs: CookieAttrs = {},
): void {
  res.setHeader("Set-Cookie", buildClearSessionCookie(attrs));
}

/**
 * Pull the session JWT out of the Cookie header. We don't use a third-
 * party cookie parser — a single named cookie is trivial to extract.
 */
export function readSessionToken(req: VercelRequest): string | null {
  const raw = req.headers.cookie;
  if (typeof raw !== "string" || !raw) return null;
  const re = new RegExp(
    `(?:^|; )${SESSION_COOKIE_NAME}=([^;]*)`,
  );
  const m = raw.match(re);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * Parse + verify the session cookie. Returns the account record or
 * null when the cookie is missing/invalid/expired/tampered. Reads
 * Redis to get the full account record so callers don't have to.
 */
export async function getAccountFromRequest(
  req: VercelRequest,
  redis: Redis,
): Promise<Account | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const payload = verifySession(token);
  if (!payload) return null;
  return getAccount(redis, payload.sub);
}
