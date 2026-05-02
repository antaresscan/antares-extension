// api/auth/logout.ts — Clear the session cookie.
//
//   POST /api/auth/logout
//   Returns: 200 + Set-Cookie that immediately expires
//
// Stateless JWT means there's no server-side session to revoke for
// MVP — the client deleting its cookie is sufficient. Future: add a
// token-revocation list keyed in Redis if we need fine-grained kicks.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { setCorsHeaders } from "../_lib/middleware";
import { apiError } from "../_lib/helpers";
import { clearSessionCookie } from "../_lib/session-cookie";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "POST") return apiError(res, 405, "Method not allowed.");

  res.setHeader("Cache-Control", "no-store, max-age=0");
  clearSessionCookie(res);
  return res.status(200).json({ ok: true });
}
