import type { VercelRequest, VercelResponse } from "@vercel/node";
import { describeHeliusKey, getHeliusDiagnostics, probeHelius } from "./_lib/helius";
import { ENGINE_VERSION, SCORING_VERSION } from "./_lib/constants";

/**
 * Which upstream credentials this deployment has, as booleans only. A missing
 * one degrades scans without any error (no holder data, no AI summary, no
 * cache, no error reports) and used to stay invisible until the symptoms were
 * noticed. Helius has its own, richer block below.
 */
function configuredIntegrations() {
  const has = (name: string) => (process.env[name] ?? "").trim() !== "";
  return {
    redis: has("UPSTASH_REDIS_REST_URL") && has("UPSTASH_REDIS_REST_TOKEN"),
    gemini: has("GEMINI_API_KEY"),
    solscan: has("SOLSCAN_API_KEY"),
    sentry: has("SENTRY_DSN"),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  // `?probe=1` makes one cheap Helius call from THIS function (at most once a
  // minute per instance), so the diagnostics below describe a real request.
  // Without it, lastRpc stays null: each Vercel function has its own memory and
  // this one never calls Helius otherwise.
  const probe = String((req.query ?? {}).probe ?? "") === "1";
  const probed = probe ? await probeHelius() : false;

  res.json({
    status: "ok",
    // Version of this endpoint's contract (the e2e suite checks its shape), not
    // of the deployment: `commit` and `scoringVersion` say what is live.
    version: "1.1.0",
    timestamp: Date.now(),
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    environment: process.env.VERCEL_ENV ?? null,
    scoringVersion: SCORING_VERSION,
    engineVersion: ENGINE_VERSION,
    configured: configuredIntegrations(),
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
