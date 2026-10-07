import type { VercelRequest, VercelResponse } from "@vercel/node";
import { describeHeliusKey, getHeliusDiagnostics, probeHelius } from "./_lib/helius";

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
