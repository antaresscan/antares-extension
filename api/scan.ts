import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "60 s"),
  analytics: true,
});

const CA_RE = /^[A-Za-z0-9]{32,44}$/;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function setHeaders(res: VercelResponse) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const ip = (req.headers["x-forwarded-for"] as string) ?? "127.0.0.1";
  const { success } = await ratelimit.limit(ip);
  if (!success) return res.status(429).json({ error: "Rate limit exceeded." });

  const ca = req.query.ca as string | undefined;
  if (!ca || !CA_RE.test(ca)) return res.status(400).json({ error: "Invalid token address." });

  const cacheKey = `scan:${ca}`;
  const cached = await redis.get(cacheKey);
  if (cached) return res.json({ ...(cached as object), cached: true });

  try {
    const [dexRes, rugRes] = await Promise.all([
      fetch(`${DEXSCREENER_BASE}/tokens/${ca}`),
      fetch(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`),
    ]);

    const dexData = dexRes.ok ? await dexRes.json() : null;
    let rugData = rugRes.ok ? await rugRes.json() : null;
    let pair = dexData?.pairs?.[0] ?? null;
    let resolvedMint = ca;

    if (!pair) {
      const pairRes = await fetch(`${DEXSCREENER_BASE}/pairs/solana/${ca}`);
      if (pairRes.ok) {
        const pairData = await pairRes.json();
        const resolvedPair = pairData?.pairs?.[0] ?? pairData?.pair ?? null;
        if (resolvedPair?.baseToken?.address) {
          resolvedMint = resolvedPair.baseToken.address;
          pair = resolvedPair;
          const rugRetry = await fetch(`${RUGCHECK_BASE}/tokens/${resolvedMint}/report/summary`);
          if (rugRetry.ok) rugData = await rugRetry.json();
        }
      }
    }

    let score = 1000;
    const flags: { label: string; severity: string; impact: number }[] = [];

    if (rugData) {
      if (rugData.mintAuthorityEnabled) { score -= 300; flags.push({ label: "Mint Authority enabled", severity: "critical", impact: 300 }); }
      if (rugData.freezeAuthorityEnabled) { score -= 300; flags.push({ label: "Freeze Authority enabled", severity: "critical", impact: 300 }); }
      if (!rugData.lpBurned && !rugData.lpLocked) { score -= 200; flags.push({ label: "LP not burned or locked", severity: "critical", impact: 200 }); }
      if (rugData.topHolders?.top10Percentage > 80) { score -= 150; flags.push({ label: "Top 10 holders > 80%", severity: "critical", impact: 150 }); }
      if (rugData.risks?.some((r: any) => r.name?.toLowerCase().includes("sniper"))) { score -= 150; flags.push({ label: "Sniper activity detected", severity: "critical", impact: 150 }); }
      if (rugData.risks?.some((r: any) => r.name?.toLowerCase().includes("bundler"))) { score -= 150; flags.push({ label: "Bundler detected", severity: "critical", impact: 150 }); }
      if (rugData.risks?.some((r: any) => r.name?.toLowerCase().includes("insider"))) { score -= 120; flags.push({ label: "Insider wallet detected", severity: "warning", impact: 120 }); }
      if (rugData.risks?.some((r: any) => r.name?.toLowerCase().includes("rug"))) { score -= 200; flags.push({ label: "Rug pull history", severity: "critical", impact: 200 }); }
    }

    if (pair) {
      const liquidity = pair.liquidity?.usd ?? 0;
      const volume24h = pair.volume?.h24 ?? 0;
      const priceChange24h = pair.priceChange?.h24 ?? 0;
      const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
      const ageMinutes = ageMs / 60000;
      if (liquidity < 1000) { score -= 200; flags.push({ label: "Very low liquidity", severity: "critical", impact: 200 }); }
      else if (liquidity < 5000) { score -= 100; flags.push({ label: "Low liquidity", severity: "warning", impact: 100 }); }
      if (volume24h > liquidity * 20) { score -= 120; flags.push({ label: "Abnormal volume/liquidity", severity: "critical", impact: 120 }); }
      if (priceChange24h > 500) { score -= 100; flags.push({ label: "Extreme pump 24h", severity: "warning", impact: 100 }); }
      if (priceChange24h < -80) { score -= 150; flags.push({ label: "Brutal dump 24h", severity: "critical", impact: 150 }); }
      if (ageMinutes > 0 && ageMinutes < 5) { score -= 80; flags.push({ label: "Token very new", severity: "warning", impact: 80 }); }
      if (!pair.info?.socials?.length && !pair.info?.websites?.length) { score -= 50; flags.push({ label: "No socials or website", severity: "info", impact: 50 }); }
    } else {
      score -= 100; flags.push({ label: "Not indexed on DexScreener", severity: "warning", impact: 100 });
    }

    score = Math.max(0, score);
    const risk = score >= 750 ? "SAFE" : score >= 500 ? "CAUTION" : score >= 250 ? "DANGER" : "RUG";
    const result = { score, risk, flags, pair, resolvedMint, scoring_version: "1.0" };
    await redis.set(cacheKey, JSON.stringify(result), { ex: 60 });
    return res.json(result);
  } catch (e) {
    console.error("[scan]", e);
    return res.status(500).json({ error: "Analysis error." });
  }
}
