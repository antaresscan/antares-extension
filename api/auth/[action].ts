// api/auth/[action].ts — Single auth dispatcher.
//
// Hobby Vercel allows 12 serverless functions max; routing all four
// auth verbs (signup / login / logout / me) through one dynamic file
// keeps us under the cap. URLs are unchanged thanks to the dynamic
// segment:
//   POST /api/auth/signup → action=signup
//   POST /api/auth/login  → action=login
//   POST /api/auth/logout → action=logout
//   GET  /api/auth/me     → action=me
//
// Each branch keeps its own method/body/contract guarantees so the
// caller surface is identical to the previous one-file-per-verb shape.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  checkRateLimit,
  getClientIp,
  getInstallId,
  initRateLimiters,
} from "../_lib/middleware";
import { apiError } from "../_lib/helpers";
import { logger } from "../_lib/logger";
import {
  createAccount,
  authenticate,
  ensureDevLifetimeLicense,
  ensureDevProLicense,
  signSession,
  ACCOUNT_INSTALL_KEY,
} from "../_lib/account";
import {
  setSessionCookie,
  clearSessionCookie,
  getAccountFromRequest,
} from "../_lib/session-cookie";

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function readBody(req: VercelRequest): Record<string, unknown> {
  const body = req.body as unknown;
  if (body && typeof body === "object") return body as Record<string, unknown>;
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ── signup ──────────────────────────────────────────────────────────────
async function handleSignup(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const body = readBody(req);
  const email = String(body.email ?? "");
  const password = String(body.password ?? "");

  try {
    const outcome = await createAccount(redis, { email, password });
    if (!outcome.ok) {
      const status = outcome.reason === "already_exists" ? 409 : 400;
      return res.status(status).json({ ok: false, reason: outcome.reason });
    }
    setSessionCookie(res, outcome.account.email);
    // Auto-grant dev licences (no-op for non-allowlisted emails).
    // Both Pro and Lifetime are issued for emails on either list so
    // devs can switch between expiry-aware Pro testing and Lifetime
    // testing without touching env vars. Failures don't block signup.
    await ensureDevLifetimeLicense(redis, outcome.account.email);
    await ensureDevProLicense(redis, outcome.account.email);
    logger.metric("auth.signup", { email: outcome.account.email });
    return res.status(200).json({ ok: true, email: outcome.account.email });
  } catch (err) {
    logger.error("auth/signup", "creation failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    return apiError(res, 500, "Could not create account.");
  }
}

// ── login ───────────────────────────────────────────────────────────────
async function handleLogin(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");
  initRateLimiters(redis);

  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  const body = readBody(req);
  const email = String(body.email ?? "");
  const password = String(body.password ?? "");

  try {
    const outcome = await authenticate(redis, { email, password });
    if (!outcome.ok) {
      // 401 not 404 — never differentiate "no account" from "wrong
      // password" or we leak account existence.
      return res
        .status(401)
        .json({ ok: false, reason: "invalid_credentials" });
    }
    setSessionCookie(res, outcome.account.email);
    // Auto-grant dev licences (Pro + Lifetime). Idempotent — only
    // mints once per email-and-tier regardless of how many logins.
    await ensureDevLifetimeLicense(redis, outcome.account.email);
    await ensureDevProLicense(redis, outcome.account.email);
    logger.metric("auth.login", { email: outcome.account.email });
    return res.status(200).json({ ok: true, email: outcome.account.email });
  } catch (err) {
    logger.error("auth/login", "auth failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    return apiError(res, 500, "Could not log in.");
  }
}

// ── logout ──────────────────────────────────────────────────────────────
//
// Just clear the cookie. We don't need to mutate the install→email
// binding or stored tier any more — `getEffectiveTierFromRequest` is
// session-gated, so the cookie's absence IS what makes the next scan
// return Free for everyone, including dev and paying customers.
// Signing back in restores tier without any data being touched.
function handleLogout(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}

// ── sync-token ──────────────────────────────────────────────────────────
//
// Returns the session JWT in the response body so the website can hand
// it to the extension via the postMessage bridge. Required because:
//
//   - The session cookie set on /api/auth/login is HttpOnly, so JS on
//     the website can't read it to forward to the extension.
//   - Cookies don't reliably flow from chrome-extension:// → API origin
//     in browsers with strict third-party cookie blocking. SameSite=None
//     + Secure helps but Chrome 124+ phases out third-party cookies
//     entirely. Without a non-cookie path, signed-in users would see
//     Free in the overlay.
//
// Flow: website calls this after login (cookie auto-sent) → gets the
// JWT → posts {type:'antares:set-session-token', token} to the bridge
// content script → bridge writes to chrome.storage.local → background
// scan calls send X-Antares-Session: <token> header → API verifies.
//
// The token is a fresh sign of the same email payload. Same TTL as the
// cookie (30 days). Logout clears the bridge-stored token via a
// separate postMessage (handled in the bridge content script).
async function handleSyncToken(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");

  try {
    const account = await getAccountFromRequest(req, redis);
    if (!account) {
      return res.status(401).json({ ok: false, reason: "not_authenticated" });
    }

    // Auto-bind the caller's install_id to their email so subsequent scan
    // calls resolve tier without requiring a separate "Link to my
    // extension" click. This is what closes the website-account ↔
    // extension-overlay loop:
    //
    //   1. User signs in → cookie set
    //   2. /account.html probes install_id from extension bridge
    //   3. /account.html calls /api/auth/sync-token with X-Antares-Install
    //   4. We bind the install to the user's email here (this block)
    //   5. We hand back the JWT, the bridge stores it
    //   6. Next /api/scan call resolves session+binding → user's tier ✓
    //
    // Anti-hijack: we only bind when the install is currently UNBOUND.
    // If install is already bound to a different email, we leave it
    // alone — preventing user B from claiming user A's paid install
    // by signing up on the same browser. (Same-email re-bind is a
    // no-op; idempotent.) Refusal is silent — the sync-token still
    // succeeds so the user can scan; their tier just stays Free
    // until they redeem their own license.
    const installId = getInstallId(req);
    if (installId) {
      try {
        const existing = await redis.get<string>(ACCOUNT_INSTALL_KEY(installId));
        if (!existing) {
          await redis.set(ACCOUNT_INSTALL_KEY(installId), account.email);
          logger.info("auth/sync-token", "install auto-bound", {
            installId,
            email: account.email,
          });
        } else if (existing !== account.email) {
          logger.warn("auth/sync-token", "install bound to different email", {
            installId,
            sessionEmail: account.email,
            boundEmail: existing,
          });
        }
        // existing === account.email → no-op, idempotent
      } catch (err) {
        // Don't fail the whole sync-token call on a binding-write hiccup —
        // tier resolution will just see no binding and return Free, which
        // is the safe default. The user can retry from /account.html.
        logger.warn("auth/sync-token", "auto-bind write failed", {
          error: String(err),
          installId,
        });
      }
    }

    const token = signSession(account.email);
    return res.json({ ok: true, token, email: account.email });
  } catch (err) {
    logger.error("auth/sync-token", "lookup failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    return apiError(res, 500, "Could not issue sync token.");
  }
}

// ── me ──────────────────────────────────────────────────────────────────
async function handleMe(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");

  try {
    const account = await getAccountFromRequest(req, redis);
    if (!account) {
      return res.status(401).json({ ok: false, reason: "not_authenticated" });
    }
    return res.json({
      ok: true,
      email: account.email,
      emailVerified: account.emailVerified,
      createdAt: account.createdAt,
    });
  } catch (err) {
    logger.error("auth/me", "lookup failed", { error: String(err) });
    if (String(err).includes("SESSION_SECRET")) {
      return apiError(res, 503, "Auth not configured on this deployment.");
    }
    return apiError(res, 500, "Could not read session.");
  }
}

// ── dispatcher ──────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");

  res.setHeader("Cache-Control", "no-store, max-age=0");

  // Vercel surfaces the [action] segment under req.query.action.
  const actionRaw = req.query.action;
  const action = String(Array.isArray(actionRaw) ? actionRaw[0] : actionRaw ?? "");

  switch (action) {
    case "signup":
      return handleSignup(req, res);
    case "login":
      return handleLogin(req, res);
    case "logout":
      return handleLogout(req, res);
    case "me":
      return handleMe(req, res);
    case "sync-token":
      return handleSyncToken(req, res);
    default:
      return apiError(
        res,
        404,
        "Unknown auth action. Use signup | login | logout | me | sync-token.",
      );
  }
}

// Internals exported for unit tests so we don't need to mock req.query.action.
export const __test = {
  handleSignup,
  handleLogin,
  handleLogout,
  handleMe,
  handleSyncToken,
};
