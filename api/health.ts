import type { VercelRequest, VercelResponse } from "@vercel/node";
import { describeHeliusKey, getHeliusDiagnostics } from "./_lib/helius";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    version: "1.1.0",
    timestamp: Date.now(),
    // Why holder data may be missing, without exposing the key: the shape of the
    // HELIUS_API_KEY value (missing, a bare UUID, a pasted URL, quoted, ...), and
    // the HTTP statuses of the last Helius call made by this instance (null until
    // it has made one: call /api/scan first).
    helius: {
      key: describeHeliusKey(process.env.HELIUS_API_KEY),
      ...getHeliusDiagnostics(),
    },
  });
}
