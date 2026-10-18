import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { describeHeliusKey, getHeliusDiagnostics, probeHelius } from "./_lib/helius";
import { initUsage, readUsage, limitedShareAlert } from "./_lib/usage";
import { hasCronSecret } from "./_lib/cron-auth";
import { logger } from "./_lib/logger";
import { initSentry, captureError } from "./_lib/sentry";

initSentry();

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  initUsage(new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }));
}

/**
 * `Authorization: Bearer <CRON_SECRET>`. Without a CRON_SECRET the usage view is switched OFF, never open. (Vercel Hobby allows 12
 * functions and the project already has 12: the usage report lives here instead of in a function of its own.)
 *
 * The comparison is cron-auth.ts's (the SHA-256 of both sides, then timingSafeEqual): this file had its own, which compared the
 * LENGTHS first, in the clear, so the time of a refusal said whether a guess had the secret's length.
 */
function isAuthorizedForUsage(req: VercelRequest): boolean {
  return hasCronSecret(req);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  // `?usage=N` (1 to 31 days): how much each upstream API was used and refused, and the estimated credits (api/_lib/usage.ts).
  // Reserved to the owner: it shows how the service is used.
  if ((req.query ?? {}).usage !== undefined) {
    if (!isAuthorizedForUsage(req)) return res.status(401).json({ error: "unauthorized" });
    return res.json(await readUsage(Number((req.query ?? {}).usage)));
  }

  // `?watch=limited`: the check of the share of cold scans answered "Limited data" (a source was silent: api/_lib/helpers.ts scanGapCauses), owner only.
  //   - YESTERDAY (a full day), called once a day by the vercel.json cron (which sends the CRON_SECRET): above 3 % of at least 50 scans it writes an error line (Vercel logs)
  //     and a Sentry event that names the sources;
  //   - TODAY SO FAR, in the same answer, for the hourly GitHub Action (.github/workflows/limited-data-watch.yml): judged the same way, but only reported (that Action opens
  //     or closes an issue; no second Sentry event for the same day).
  if ((req.query ?? {}).watch === "limited") {
    if (!isAuthorizedForUsage(req)) return res.status(401).json({ error: "unauthorized" });
    const report = await readUsage(2);
    const yesterday = report.days[0];
    const verdict = limitedShareAlert(yesterday.scans);
    if (verdict.alert) {
      logger.error("monitor", "Limited data share above the threshold", { date: yesterday.date, ...yesterday.scans });
      captureError(new Error(`Limited data: ${verdict.message}`), { endpoint: "health", watch: "limited", date: yesterday.date });
    }
    const todayDay = report.days[1];
    const todayVerdict = todayDay ? limitedShareAlert(todayDay.scans) : null;
    return res.json({
      date: yesterday.date,
      alert: verdict.alert,
      message: verdict.message,
      scans: yesterday.scans,
      today: todayDay && todayVerdict ? { date: todayDay.date, alert: todayVerdict.alert, message: todayVerdict.message, scans: todayDay.scans } : null,
    });
  }

  // `?probe=1` makes one cheap Helius call from THIS function (at most once a
  // minute per instance), so the diagnostics below describe a real request.
  // Without it, lastRpc stays null: each Vercel function has its own memory and
  // this one never calls Helius otherwise.
  const probe = String((req.query ?? {}).probe ?? "") === "1";
  const probed = probe ? await probeHelius() : false;

  res.json({
    status: "ok",
    version: "1.1.0",
    timestamp: Date.now(),
    // Why holder data may be missing, without exposing the key: the shape of the
    // HELIUS_API_KEY value (missing, a bare UUID, a pasted URL, quoted, ...), and
    // the HTTP statuses of the last Helius call made by this instance (see probe).
    helius: {
      key: describeHeliusKey(process.env.HELIUS_API_KEY),
      probed,
      ...getHeliusDiagnostics(),
    },
  });
}
