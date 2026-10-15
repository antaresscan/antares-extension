// api/_lib/cron-auth.ts — who may start a scheduled job by hand (audit A-28).
//
// A Vercel cron is an ordinary public URL. The only thing that proves Vercel started it is the secret: with a CRON_SECRET variable on the
// project, Vercel itself sends `Authorization: Bearer <CRON_SECRET>` on every scheduled call (https://vercel.com/docs/cron-jobs/manage-cron-jobs,
// "Securing cron jobs"). A header such as `x-vercel-cron: 1` is not that proof: anybody can type it, and the documentation does not offer it as
// one. api/cron-check-payments.ts used to open on that header alone: a stranger could start the payment sweep as often as they liked, and every
// run asks NOWPayments about each pending checkout.
//
// The comparison is made on the SHA-256 of both sides, so it takes the same time whatever the length of what was sent, and timingSafeEqual does
// the equality. With no CRON_SECRET on the deployment nothing is ever authorised (a missing secret must close the door, not open it).
import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest } from "@vercel/node";

/** True only for `Authorization: Bearer <CRON_SECRET>`, and only when CRON_SECRET is set. */
export function hasCronSecret(req: Pick<VercelRequest, "headers">): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return false;
  const raw = req.headers?.authorization;
  const given = typeof raw === "string" ? raw : "";
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}
