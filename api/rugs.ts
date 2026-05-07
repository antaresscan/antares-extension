// api/rugs.ts — Rug-related read + feedback endpoint.
//
//   GET  /api/rugs                  → list recent confirmed rugs
//   GET  /api/rugs?mint=<ca>        → single confirmed-rug entry
//   POST /api/rugs?action=feedback  → user-submitted "this verdict was wrong" report
//
// The feedback POST piggy-backs on this file because the Vercel Hobby
// tier caps the project at 12 serverless functions and we're already
// at the cap. Semantically it fits — both surfaces deal with verdict
// vs reality calibration.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import {
  setCorsHeaders,
  checkRateLimit,
  getClientIp,
  getInstallId,
  initRateLimiters,
} from "./_lib/middleware";
import { apiError } from "./_lib/helpers";
import { logger } from "./_lib/logger";
import { initRugDb, getRecentRugs, getRugEntry } from "./_lib/rugdb";
import { initFeedbackStore, submitFeedback, type Verdict } from "./_lib/feedback";
import { initSentry, captureError } from "./_lib/sentry";

initSentry();

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initRugDb(redis);
  initFeedbackStore(redis);
  initRateLimiters(redis);
}

const CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const VERDICTS: ReadonlyArray<Verdict> = ["SAFE", "CAUTION", "DANGER", "RUG"];

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

function isVerdict(v: unknown): v is Verdict {
  return typeof v === "string" && (VERDICTS as readonly string[]).includes(v);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");

  // Rate limiting — applied to both GET and POST. Feedback is the
  // higher-risk surface (write side, anti-spam) but we keep the gate
  // unified so a single bad actor can't stack reads to mask writes.
  const ip = getClientIp(req);
  const allowed = await checkRateLimit(res, ip);
  if (!allowed) return;

  if (req.method === "POST") {
    return handleFeedback(req, res, ip);
  }
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  // Single token lookup: /api/rugs?mint=xxx
  const mint = typeof req.query.mint === "string" ? req.query.mint.trim() : null;
  if (mint) {
    const entry = await getRugEntry(mint);
    return res.json({ found: !!entry, entry });
  }

  // List recent rugs: /api/rugs?limit=50
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 100);
  const rugs = await getRecentRugs(limit);
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");
  return res.json({ count: rugs.length, rugs });
}

async function handleFeedback(req: VercelRequest, res: VercelResponse, ip: string) {
  const action = typeof req.query.action === "string" ? req.query.action : "";
  if (action !== "feedback") {
    return apiError(res, 400, "Unknown POST action. Use ?action=feedback.");
  }

  const body = readBody(req);
  const ca = typeof body.ca === "string" ? body.ca.trim() : "";
  if (!CA_RE.test(ca)) return apiError(res, 400, "Valid Solana CA required.");

  const originalVerdict = body.originalVerdict;
  const reportedVerdict = body.reportedVerdict;
  if (!isVerdict(originalVerdict)) {
    return apiError(res, 400, "originalVerdict must be SAFE | CAUTION | DANGER | RUG.");
  }
  if (!isVerdict(reportedVerdict)) {
    return apiError(res, 400, "reportedVerdict must be SAFE | CAUTION | DANGER | RUG.");
  }

  const noteRaw = typeof body.note === "string" ? body.note.trim() : "";
  const note = noteRaw.length > 0 ? noteRaw.slice(0, 500) : null;

  const installId = getInstallId(req);

  res.setHeader("Cache-Control", "no-store, max-age=0");

  try {
    const outcome = await submitFeedback({
      ca,
      originalVerdict,
      reportedVerdict,
      note,
      installId,
      ip,
    });
    if (!outcome.ok) {
      const status =
        outcome.reason === "no_storage"
          ? 503
          : outcome.reason === "same_verdict"
            ? 400
            : outcome.reason === "duplicate"
              ? 429
              : 500;
      return res.status(status).json({ ok: false, reason: outcome.reason });
    }
    logger.metric("rugs.feedback", {
      ca,
      from: originalVerdict,
      to: reportedVerdict,
      hasNote: note !== null,
    });
    return res.json({ ok: true, totalReports: outcome.totalReports });
  } catch (err) {
    logger.error("rugs/feedback", "submit failed", { error: String(err), ca });
    captureError(err, { endpoint: "rugs/feedback", ca });
    return apiError(res, 500, "Could not record feedback.");
  }
}
