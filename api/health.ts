import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.json({
    status: "ok",
    version: "1.1.0",
    timestamp: Date.now(),
  });
}
