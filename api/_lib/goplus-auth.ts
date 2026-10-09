// api/_lib/goplus-auth.ts
//
// Authenticated GoPlus calls. GoPlus exchanges an app key + secret for a short-lived access token:
//   POST /api/v1/token  { app_key, time (seconds, within +-1000 s of now), sign }
//   sign = sha1(app_key + time + app_secret)                     (official SDK: goplus-sdk-node)
//   -> { code: 1, result: { access_token, expires_in } }, then `Authorization: Bearer <access_token>`.
//
//   (the returned access_token already starts with "Bearer ": send it as is, see authorizationValue).
//
// Without GOPLUS_APP_KEY / GOPLUS_APP_SECRET, or if anything about the token goes wrong, the scan falls back
// to the anonymous tier it used before: this module can only add headroom, never remove a data source.
import { createHash } from "node:crypto";
import { fetchJson } from "./http";
import { GOPLUS_BASE } from "./constants";
import { logger } from "./logger";

const TOKEN_SKEW_MS = 60_000;          // renew a minute before expiry
const FAILURE_BACKOFF_MS = 60_000;     // after a failed token request, stay anonymous for a minute
const GOPLUS_RATE_LIMITED = 4029; // "too many requests"
const MIN_LIFETIME_S = 60;
const MAX_LIFETIME_S = 2 * 60 * 60;    // never trust a lifetime longer than 2 h

interface TokenResponse { code?: number; message?: string; result?: { access_token?: string; expires_in?: number } }

let cached: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string | null> | null = null;
let retryAfter = 0;

/** sha1(app_key + time + app_secret), hex. Exported for the official test vector. */
export function goPlusSign(appKey: string, time: number, appSecret: string): string {
  return createHash("sha1").update(`${appKey}${time}${appSecret}`).digest("hex");
}

async function requestToken(appKey: string, appSecret: string): Promise<string | null> {
  const time = Math.floor(Date.now() / 1000);
  const res = await fetchJson<TokenResponse>(
    `${GOPLUS_BASE}/token`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_key: appKey, sign: goPlusSign(appKey, time, appSecret), time }) },
    4000,
    0,
  );
  const token = res?.result?.access_token;
  if (!token) {
    retryAfter = Date.now() + FAILURE_BACKOFF_MS;
    logger.warn("goplus", "access token request failed, staying on the anonymous tier", { code: res?.code ?? null, message: res?.message ?? null });
    return null;
  }
  const lifetimeS = Math.min(MAX_LIFETIME_S, Math.max(MIN_LIFETIME_S, Number(res?.result?.expires_in) || MAX_LIFETIME_S));
  cached = { token, expiresAt: Date.now() + lifetimeS * 1000 };
  return token;
}

/**
 * GoPlus returns the token ALREADY prefixed ("Bearer <jwt>"): adding a second prefix makes every call fail with
 * code 4012 "signature verification failure" (seen live). Use it as returned; prefix only a bare token.
 */
export function authorizationValue(token: string): string {
  return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
}

/** A valid access token, or null (no credentials configured, or the exchange failed). */
export async function getGoPlusToken(): Promise<string | null> {
  const appKey = process.env.GOPLUS_APP_KEY?.trim();
  const appSecret = process.env.GOPLUS_APP_SECRET?.trim();
  if (!appKey || !appSecret) return null;
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token;
  if (Date.now() < retryAfter) return null;
  inflight ??= requestToken(appKey, appSecret).finally(() => { inflight = null; });
  return inflight;
}

/** GET /solana/token_security for a mint: authenticated when possible, anonymous otherwise. */
export async function fetchGoPlusSecurity(mint: string): Promise<unknown> {
  const url = `${GOPLUS_BASE}/solana/token_security?contract_addresses=${mint}`;
  const token = await getGoPlusToken();
  if (token) {
    const authed = await fetchJson<{ code?: number }>(url, { headers: { Authorization: authorizationValue(token) } }, 4000);
    if (authed && authed.code === 1) return authed;
    // Code 4029 is "too many requests" (seen live: 20 of 30 simultaneous calls): the token is fine, only the plan's rate limit
    // is hit, so keep it. Any other answer means the token was rejected or expired: renew it next time.
    if (authed?.code !== GOPLUS_RATE_LIMITED) cached = null;
    // Either way this scan is answered from the anonymous tier (its own quota) instead of losing GoPlus.
  }
  return fetchJson(url, {}, 4000);
}

/** Test-only. */
export function _resetGoPlusAuthForTests(): void {
  cached = null; inflight = null; retryAfter = 0;
}
