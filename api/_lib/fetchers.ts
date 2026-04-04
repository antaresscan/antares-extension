// api/fetchers.ts — External API fetcher functions

import type {
    HeliusTokenAccountsResponse,
        HeliusHolder,
    OHLCVCandle, GeckoTerminalOHLCVResponse,
    RugCheckReport, RugCheckRisk,
} from "./types";
import { HELIUS_BASE, SOLSCAN_PUBLIC_BASE, SOLSCAN_BASE } from "./constants";
import { fetchJson, fetchJsonPost } from "./http";
import { asNumber } from "./math";
const HELIUS_REST_BASE = "https://api.helius.xyz";


// ─── HELIUS HELPERS ─────────────────────────────────────────────────────────
const heliusHeaders = (key: string) => ({ "Authorization": "Bearer " + key });
export async function heliusGetLargestAccounts(mint: string, key: string) {
    return fetchJsonPost(HELIUS_BASE, {
        jsonrpc: "2.0", id: "holders", method: "getTokenLargestAccounts", params: [mint],
    }, 6000, 2, heliusHeaders(key));
}


// Resolve token account addresses to their owner wallet addresses
export async function heliusResolveAccountOwners(
    holders: HeliusHolder[],
    key: string
): Promise<HeliusHolder[]> {
    if (!holders.length) return [];
    const addresses = holders.map(h => h.address);
    try {
        const res = await fetchJsonPost(HELIUS_BASE, {
            jsonrpc: "2.0", id: "owners", method: "getMultipleAccounts",
            params: [addresses, { encoding: "jsonParsed" }],
        }, 6000, 2, heliusHeaders(key));
        const accounts = (res as any)?.result?.value ?? [];
        return holders.map((h, i) => {
            const parsed = accounts[i]?.data?.parsed?.info?.owner;
            return { ...h, owner: parsed ?? h.address };
        });
    } catch {
        // Fallback: use address as owner (old behavior)
        return holders.map(h => ({ ...h, owner: h.address }));
    }
}
export async function heliusGetTokenSupply(mint: string, key: string) {
    return fetchJsonPost(HELIUS_BASE, {
        jsonrpc: "2.0", id: "supply", method: "getTokenSupply", params: [mint],
    }, 6000, 2, heliusHeaders(key));
}

export async function heliusGetHoldersCount(mint: string, key: string): Promise<number | null> {
    const res = await fetchJsonPost(HELIUS_BASE, {
        jsonrpc: "2.0", id: "holders-count",
        method: "getTokenAccounts",
        params: { mint, limit: 1, page: 1 },
    }, 6000, 2, heliusHeaders(key)) as HeliusTokenAccountsResponse | null;
    const total = res?.result?.total ?? res?.total;
    return typeof total === "number" ? total : null;
}

// ─── [5.1] CREATOR REPUTATION ─────────────────────────────────────────────
export interface CreatorReputation {
    priorTokens: number;
    flagged: boolean;
    reason: string | null;
}

export async function heliusGetCreatorReputation(
    creator: string,
    key: string
): Promise<CreatorReputation | null> {
    if (!creator || !key) return null;
    // Use Authorization header instead of query param for security
    const res = await fetchJson(
        HELIUS_REST_BASE + "/v0/addresses/" + creator + "/transactions?limit=20",
        { headers: heliusHeaders(key) }, 6000
    ) as Array<{ type?: string; description?: string }> | null;
    if (!Array.isArray(res)) return null;
    let priorTokens = 0;
    for (const tx of res) {
        const desc = String(tx.description || "").toLowerCase();
        const type = String(tx.type || "").toLowerCase();
        const isTokenLaunch = type === "initialize_mint" || (desc.includes("initialize mint") && !desc.includes("account"));
        if (isTokenLaunch) {
            priorTokens++;
        }
    }
    if (priorTokens >= 3) {
        return { priorTokens, flagged: true, reason: "Creator launched " + priorTokens + "+ tokens \u2014 serial deployer" };
    }
    return { priorTokens, flagged: false, reason: null };
}

// ─── SOLSCAN HELPERS ───────────────────────────────────────────────────────
export async function solscanGetHoldersCount(mint: string): Promise<number | null> {
    const res = await fetchJson(
        SOLSCAN_PUBLIC_BASE + "/token/holders?tokenAddress=" + mint + "&limit=1&offset=0",
        { headers: { "User-Agent": "Antares/1.0" } }, 5000
    ) as { total?: number } | null;
    const total = res?.total;
    return typeof total === "number" && total > 0 ? total : null;
}

export async function fetchSolscan(endpoint: string) {
    const key = process.env.SOLSCAN_API_KEY || "";
    if (!key) return null;
    return fetchJson(SOLSCAN_BASE + endpoint, { headers: { token: key } }, 5000);
}

// ─── GECKOTERMINAL CANDLES ─────────────────────────────────────────────────
export async function fetchDexCandles(
    pairAddress: string, _chainId = "solana"
): Promise<OHLCVCandle[]> {
    const url = "https://api.geckoterminal.com/api/v2/networks/solana/pools/" + pairAddress + "/ohlcv/minute?aggregate=5&limit=40";
    const raw = await fetchJson(url, {
        headers: { "Accept": "application/json;version=20230302" }
    }, 6000) as GeckoTerminalOHLCVResponse | null;
    const ohlcv = raw?.data?.attributes?.ohlcv_list;
    if (!Array.isArray(ohlcv) || ohlcv.length === 0) return [];
    return ohlcv.map((b: number[]) => ({
        ts: asNumber(b[0]),
        o: asNumber(b[1]),
        h: asNumber(b[2]),
        l: asNumber(b[3]),
        c: asNumber(b[4]),
        v: asNumber(b[5]),
    }));
}

// ─── BUNDLE DETECTION ──────────────────────────────────────────────────────
export function extractBundlePct(rugReportData: RugCheckReport | null | undefined): number {
    const risks: RugCheckRisk[] = rugReportData?.risks ?? [];
    const bundleRisk = risks.find((r: RugCheckRisk) => /bundle/i.test(r.name ?? ""));
    if (!bundleRisk) return 0;
    const match = bundleRisk.description?.match(/(\d+(?:\.\d+)?)\s*%/);
    if (match) return parseFloat(match[1]) / 100;
    const scoreVal = asNumber(bundleRisk.score);
    if (scoreVal >= 10000) return 0.50;
    if (scoreVal >= 8000) return 0.35;
    if (scoreVal >= 5000) return 0.20;
    if (scoreVal >= 2000) return 0.10;
    return 0.08;
}
