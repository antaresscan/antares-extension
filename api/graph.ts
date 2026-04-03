// api/graph.ts — Insider Network Graph API endpoint
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { setCorsHeaders, validateCA } from "./_lib/middleware";
import { apiError, fetchJson, settled } from "./_lib/helpers";
import { heliusGetLargestAccounts, heliusGetTokenSupply } from "./_lib/fetchers";
import { LP_PROGRAM_ADDRESSES, FOUNDATION_WALLETS } from "./_lib/constants";
import { buildInsiderGraph, initGraphCache } from "./_lib/insider-graph";
import type { HeliusHolder } from "./_lib/types";

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  initGraphCache(redis);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const corsOk = setCorsHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!corsOk) return apiError(res, 403, "Origin not allowed.");
  if (req.method !== "GET") return apiError(res, 405, "Method not allowed.");

  const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_API_KEY) return apiError(res, 503, "Helius API key not configured.");

  const ca = validateCA(req.query.ca);
  if (!ca) return apiError(res, 400, "Invalid token address.");

  try {
    // Fetch holders and supply in parallel
    const [holdersRaw, supplyRaw] = await Promise.all([
      settled(heliusGetLargestAccounts(ca, HELIUS_API_KEY)),
      settled(heliusGetTokenSupply(ca, HELIUS_API_KEY)),
    ]);

    const holders: HeliusHolder[] = (holdersRaw as { result?: { value?: HeliusHolder[] } })?.result?.value ?? [];
    const totalSupply: number = (supplyRaw as { result?: { value?: { uiAmount?: number } } })?.result?.value?.uiAmount ?? 0;

    if (!holders.length) {
      return apiError(res, 404, "No holder data available for this token.");
    }

    const lpAddresses = new Set([...LP_PROGRAM_ADDRESSES, ...FOUNDATION_WALLETS]);
    const graph = await buildInsiderGraph(ca, holders, totalSupply, HELIUS_API_KEY, lpAddresses);

    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return res.json(graph);
  } catch (e) {
    console.error("[graph]", e);
    return apiError(res, 500, "Graph analysis failed.");
  }
}
