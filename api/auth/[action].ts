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
  initRateLimiters,
} from "../_lib/middleware";
import { apiError } from "../_lib/helpers";
import { logger } from "../_lib/logger";
import { createAccount, authenticate, ensureDevLifetimeLicense } from "../_lib/account";
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
    // Auto-grant Lifetime to dev-allowlisted emails. No-op for everyone
    // else. Failure here doesn't block signup — logged + ignored.
    await ensureDevLifetimeLicense(redis, outcome.account.email);
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
    // Auto-grant Lifetime to dev-allowlisted emails. Idempotent — only
    // mints once per email regardless of how many times they log in.
    await ensureDevLifetimeLicense(redis, outcome.account.email);
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
function handleLogout(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
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
    default:
      return apiError(
        res,
        404,
        "Unknown auth action. Use signup | login | logout | me.",
      );
  }
}

// Internals exported for unit tests so we don't need to mock req.query.action.
export const __test = {
  handleSignup,
  handleLogin,
  handleLogout,
  handleMe,
};
