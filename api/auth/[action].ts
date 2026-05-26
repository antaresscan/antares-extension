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
import {
  verifyIpnSignature,
  mapStatus,
  type NpPayment,
} from "../_lib/nowpayments";
import {
  bindNpPaymentId,
  getIntentByNpInvoiceId,
  getIntentByNpPaymentId,
  getPaymentIntent,
  markIntentExpired,
} from "../_lib/payments";
import { confirmIntent } from "../_lib/payment-confirm";
import { initUserStorage } from "../_lib/user";
import { initSentry, captureError } from "../_lib/sentry";

initSentry();

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
    captureError(err, { endpoint: "auth/signup" });
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
    captureError(err, { endpoint: "auth/login" });
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
    captureError(err, { endpoint: "auth/sync-token" });
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
    captureError(err, { endpoint: "auth/me" });
    return apiError(res, 500, "Could not read session.");
  }
}

// ── nowpayments-ipn ─────────────────────────────────────────────────────
//
// NOWPayments IPN webhook receiver. Sits inside the auth router (rather
// than in its own file) because Vercel Hobby caps us at 12 serverless
// functions and this dispatcher already has spare capacity.
//
// Request: POST /api/auth/nowpayments-ipn
//   Headers: x-nowpayments-sig: <HMAC-SHA512 of body using IPN secret>
//   Body (NpPayment shape):
//     { payment_id, payment_status, order_id, invoice_id, payin_hash, ... }
//
// Security: signature verification is mandatory. Without a valid
// `NOWPAYMENTS_IPN_SECRET` env var or a matching signature header we
// fail closed (401). Replays of an already-confirmed intent are
// idempotent thanks to `confirmIntent` checking intent.status first.
//
// CORS: NOWPayments servers are not browsers, no preflight expected,
// and we don't need to expose this to extension origins. The router's
// outer setCorsHeaders gate is permissive enough; we don't add origin
// restrictions here because NOWPayments doesn't send an Origin header.
async function handleNowpaymentsIpn(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  const redis = getRedis();
  if (!redis) return apiError(res, 503, "Storage unavailable.");

  // Per-IP rate limit. NOWPayments fires from a stable set of IPs so
  // legit traffic never approaches the cap (30/min). The check protects
  // against spoofed-source flood: an attacker with a known endpoint can
  // POST garbage all day; without a limit each request would HMAC-verify
  // (cheap but non-zero), look up a Redis key, and burn function quota.
  initRateLimiters(redis);
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  initUserStorage(redis);

  const sigHeader = req.headers["x-nowpayments-sig"];
  const body = readBody(req);
  if (!body || Object.keys(body).length === 0) {
    return apiError(res, 400, "Empty IPN payload.");
  }

  if (!verifyIpnSignature(body, sigHeader)) {
    logger.warn("auth/nowpayments-ipn", "signature verification failed", {
      hasSig: typeof sigHeader === "string" && sigHeader.length > 0,
      orderId: typeof body.order_id === "string" ? body.order_id : null,
    });
    return res.status(401).json({ ok: false, reason: "invalid_signature" });
  }

  const payment = body as unknown as NpPayment;
  const orderId = typeof payment.order_id === "string" ? payment.order_id : "";
  const npPaymentId =
    typeof payment.payment_id === "string"
      ? payment.payment_id
      : payment.payment_id != null
        ? String(payment.payment_id)
        : "";
  const npInvoiceId =
    typeof payment.invoice_id === "string"
      ? payment.invoice_id
      : payment.invoice_id != null
        ? String(payment.invoice_id)
        : "";

  // Locate the intent. order_id is our reference (what we passed to
  // NOWPayments), so it's the primary lookup. Fall back to the
  // payment_id → reference index, then the invoice_id index, in case
  // an upstream relay drops the order_id field.
  let intent = orderId ? await getPaymentIntent(redis, orderId) : null;
  if (!intent && npPaymentId) {
    intent = await getIntentByNpPaymentId(redis, npPaymentId);
  }
  if (!intent && npInvoiceId) {
    intent = await getIntentByNpInvoiceId(redis, npInvoiceId);
  }
  if (!intent) {
    logger.warn("auth/nowpayments-ipn", "intent not found", {
      orderId,
      npPaymentId,
      npInvoiceId,
    });
    // 200 anyway so NOWPayments doesn't keep retrying — the intent
    // either doesn't exist or has been GC'd. Logging captures it.
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Bind the payment_id on first observation so subsequent IPN events
  // (and the payment-status poll) hit the fast path.
  if (npPaymentId && !intent.npPaymentId) {
    try {
      intent = await bindNpPaymentId(redis, intent, npPaymentId);
    } catch { /* non-critical */ }
  }

  const internalStatus = mapStatus(payment.payment_status);

  if (internalStatus === "confirmed") {
    // The IPN body is HMAC-signed so we trust *what NOWPayments saw*,
    // but pass the reported amount to confirmIntent so it can guard
    // against the partially-paid → finished corner case (anti-underpay).
    const reportedUsd = Number(payment.price_amount ?? 0);
    const txSignature =
      payment.payin_hash ?? payment.payout_hash ?? undefined;
    const outcome = await confirmIntent(redis, intent, {
      txSignature: typeof txSignature === "string" ? txSignature : undefined,
      reportedUsd: Number.isFinite(reportedUsd) ? reportedUsd : undefined,
    });
    if (!outcome.ok) {
      // 200 anyway so NOWPayments stops retrying. Polling client can
      // see the underpay state via the body for UX surfacing.
      return res.status(200).json({
        ok: false,
        status: "amount_mismatch",
        reason: outcome.reason,
        expectedUsd: outcome.expectedUsd,
        reportedUsd: outcome.reportedUsd,
      });
    }
    logger.metric("auth/nowpayments-ipn.confirmed", {
      reference: outcome.intent.reference,
      tier: outcome.intent.tier,
      amountUsd: outcome.intent.amountUsd,
      reportedUsd,
      hasEmail: !!outcome.intent.email,
      licenseIssued: outcome.licenseKey !== null,
    });
    return res.status(200).json({ ok: true, status: "confirmed" });
  }

  if (internalStatus === "expired") {
    if (intent.status !== "expired") {
      try {
        await markIntentExpired(redis, intent);
      } catch { /* non-critical */ }
    }
    logger.metric("auth/nowpayments-ipn.expired", {
      reference: intent.reference,
      providerStatus: payment.payment_status,
    });
    return res.status(200).json({ ok: true, status: "expired" });
  }

  // Pending / partially-paid / waiting / confirming — record the event but
  // don't transition the intent yet. The polling endpoint and cron will
  // re-check on subsequent ticks.
  logger.info("auth/nowpayments-ipn", "pending update", {
    reference: intent.reference,
    providerStatus: payment.payment_status,
  });
  return res.status(200).json({ ok: true, status: "pending" });
}

// ── dispatcher ──────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel surfaces the [action] segment under req.query.action.
  const actionRaw = req.query.action;
  const action = String(Array.isArray(actionRaw) ? actionRaw[0] : actionRaw ?? "");

  // NOWPayments IPN webhook is hit by NOWPayments servers, NOT browsers.
  // No Origin header → the CORS gate would reject it (403). Skip CORS
  // entirely for this action — auth is enforced via the HMAC signature
  // header, which is far stronger than origin checking anyway.
  if (action === "nowpayments-ipn") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    // Wrap with a global catch — handleNowpaymentsIpn does not have
    // an outer try, and an unhandled throw inside `confirmIntent`
    // (e.g. transient Redis flake mid-license-mint) is the worst
    // bug we can ship: NOWPayments confirmed the payment, the user
    // pays, but our side fails silently and the license never lands,
    // leaving them paid-but-still-Free. Sentry capture here is the
    // only signal we have to detect that scenario.
    try {
      return await handleNowpaymentsIpn(req, res);
    } catch (err) {
      logger.error("auth/nowpayments-ipn", "unhandled exception", {
        error: String(err),
      });
      captureError(err, { endpoint: "auth/nowpayments-ipn", phase: "unhandled" });
      // Return 500 so NOWPayments retries the IPN — they will, and
      // by the time of retry the transient cause is usually gone.
      // confirmIntent is idempotent so duplicate retries are safe.
      if (!res.headersSent) {
        return res.status(500).json({ ok: false, reason: "internal_error" });
      }
      return;
    }
  }

  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");

  res.setHeader("Cache-Control", "no-store, max-age=0");

  // Wrap dispatch in a try/catch so an unhandled throw inside a
  // sub-handler (Upstash quota exceeded, Redis transient flake,
  // bcrypt OOM, …) doesn't bubble up to Vercel as
  // FUNCTION_INVOCATION_FAILED — that error path returns Vercel's
  // generic 500 page without the CORS headers we set above, so the
  // browser sees a CORS rejection instead of our error JSON and
  // surfaces "Failed to fetch" to the user. Catching here lets us
  // emit a proper response with the right CORS headers already in
  // place, and a structured body the client can show.
  //
  // The `await` on each handler is what makes this work — without it
  // we'd return the Promise unawaited and any rejection would land
  // back on Vercel, not in our catch.
  try {
    switch (action) {
      case "signup":
        return await handleSignup(req, res);
      case "login":
        return await handleLogin(req, res);
      case "logout":
        return await handleLogout(req, res);
      case "me":
        return await handleMe(req, res);
      case "sync-token":
        return await handleSyncToken(req, res);
      case "nowpayments-ipn":
        return await handleNowpaymentsIpn(req, res);
      default:
        return apiError(
          res,
          404,
          "Unknown auth action. Use signup | login | logout | me | sync-token | nowpayments-ipn.",
        );
    }
  } catch (err) {
    // Most likely cause: Upstash daily/monthly quota exceeded — every
    // mutating auth handler (signup, login, logout, sync-token) writes
    // to Redis, so when the quota cap is hit those handlers throw and
    // we land here. Smaller incidents (transient Redis ECONNRESET, a
    // bcrypt OOM under load, a Vercel function reaching its CPU
    // budget) follow the same path.
    //
    // We classify the error to choose between 503 (transient, retry
    // makes sense) and 500 (generic). Both responses keep the CORS
    // headers the dispatcher set earlier, so the browser actually
    // surfaces our body to the page instead of dropping it as a CORS
    // failure — the website's auth.js shows the body's `message` to
    // the user verbatim ("Service temporarily unavailable — retry in
    // a minute") instead of the misleading "Failed to fetch".
    const errMsg = String((err as Error)?.message || err);
    logger.error(`auth/${action}`, "unhandled exception", { error: errMsg });
    captureError(err, { endpoint: `auth/${action}`, phase: "dispatcher-catch" });
    if (res.headersSent) return;
    const lower = errMsg.toLowerCase();
    const isQuotaOrTransient =
      lower.includes("upstash") ||
      lower.includes("daily limit") ||
      lower.includes("rate limit") ||
      lower.includes("quota") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("max requests");
    if (isQuotaOrTransient) {
      return res.status(503).json({
        ok: false,
        reason: "service_unavailable",
        message:
          "Service temporarily unavailable. Please try again in a few minutes.",
      });
    }
    return res.status(500).json({
      ok: false,
      reason: "internal_error",
      message: "An internal error occurred. Please try again.",
    });
  }
}

// Internals exported for unit tests so we don't need to mock req.query.action.
export const __test = {
  handleSignup,
  handleLogin,
  handleLogout,
  handleMe,
  handleSyncToken,
  handleNowpaymentsIpn,
};
