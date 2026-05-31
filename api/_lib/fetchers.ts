// api/fetchers.ts — External API fetcher functions

import type {
    HeliusTokenAccountsResponse,
        HeliusHolder,
    OHLCVCandle, GeckoTerminalOHLCVResponse,
    RugCheckReport, RugCheckRisk,
} from "./types";
import { HELIUS_BASE, PUBLIC_SOLANA_RPCS, SOLSCAN_PUBLIC_BASE, SOLSCAN_BASE, HELIUS_REST_BASE, LP_PROGRAM_ADDRESSES } from "./constants";
import { fetchJson, fetchJsonPost } from "./http";
import { asNumber } from "./math";
import { logger } from "./logger";


// ─── HELIUS HELPERS ─────────────────────────────────────────────────────────
const heliusHeaders = (key: string) => ({ "Authorization": "Bearer " + key });
export async function heliusGetLargestAccounts(mint: string, key: string) {
    return fetchJsonPost(HELIUS_BASE, {
        jsonrpc: "2.0", id: "holders", method: "getTokenLargestAccounts", params: [mint],
    }, 6000, 1, heliusHeaders(key));
}


// Decode bytes 32-63 of a base64-encoded SPL / Token-2022 account to get the
// token account authority (the wallet or PDA that can transfer tokens).
// SPL token account layout: mint(0-31) | authority(32-63) | amount(64-71) | ...
// Token-2022 uses the same 165-byte base before extensions, so the same offset works.
// This is more reliable than jsonParsed which Helius may not support for Token-2022.
function extractTokenAuthority(base64Data: string): string | null {
    try {
        const buf = Buffer.from(base64Data, "base64");
        if (buf.length < 64) return null;
        const authBytes = buf.subarray(32, 64);
        // base58 encode (no external dep needed — authority addresses are always 32 bytes)
        const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        const d: number[] = [];
        for (const byte of authBytes) {
            let c = byte;
            for (let j = 0; j < d.length; j++) { const x = d[j] * 256 + c; d[j] = x % 58; c = Math.floor(x / 58); }
            while (c > 0) { d.push(c % 58); c = Math.floor(c / 58); }
        }
        let s = "";
        for (const b of authBytes) { if (b === 0) s += "1"; else break; }
        for (let i = d.length - 1; i >= 0; i--) s += ALPHA[d[i]];
        return s || null;
    } catch {
        return null;
    }
}

// Resolve token account addresses to their owner wallet / programme addresses.
//
// Strategy (works for SPL Token, Token-2022, and ALL AMMs generically):
//
// Step 1 — fetch raw base64 account data via getMultipleAccounts.
//   Decode bytes 32-63 → the token account authority (who can transfer).
//   • Raydium vault: authority = 5Q544f… (fixed, in LP_PROGRAM_ADDRESSES) ✓
//   • PumpSwap vault (Token-2022): authority = pool PDA (not hardcoded) → step 2
//   Avoids jsonParsed which Helius does not reliably support for Token-2022.
//
// Step 2 — for authorities NOT in LP_PROGRAM_ADDRESSES, fetch THEIR account.
//   If their programme-owner IS in LP_PROGRAM_ADDRESSES, the authority is a
//   pool PDA → it's an LP vault. Substitute with the LP programme address so
//   the LP_PROGRAM_ADDRESSES filter in layerHelius excludes it.
//
// This ends false-positive "Single wallet holds X%" flags on PumpSwap (and any
// other AMM that uses per-pool PDAs as vault authority) without hardcoding addresses.
export async function heliusResolveAccountOwners(
    holders: HeliusHolder[],
    key: string
): Promise<HeliusHolder[]> {
    if (!holders.length) return [];
    const addresses = holders.map(h => h.address);
    try {
        // ── Step 1: decode authority from raw base64 ──────────────────────────
        const res = await fetchJsonPost(HELIUS_BASE, {
            jsonrpc: "2.0", id: "owners", method: "getMultipleAccounts",
            params: [addresses, { encoding: "base64" }],
        }, 6000, 1, heliusHeaders(key));
        type RpcAccountB64 = { data?: [string, string] | null };
        const rpcRes = res as { result?: { value?: (RpcAccountB64 | null)[] } } | null;
        const accounts = rpcRes?.result?.value ?? [];
        const resolved = holders.map((h, i) => {
            const b64 = Array.isArray(accounts[i]?.data) ? (accounts[i]!.data as [string, string])[0] : null;
            const authority = b64 ? extractTokenAuthority(b64) : null;
            return { ...h, owner: authority ?? h.address };
        });

        // ── Step 2: detect pool PDAs whose parent is a known LP programme ─────
        const unknownOwners = [...new Set(
            resolved.map(h => h.owner).filter(o => !LP_PROGRAM_ADDRESSES.has(o))
        )];
        if (unknownOwners.length === 0) return resolved;

        const ownerProgramMap = new Map<string, string>();
        try {
            const res2 = await fetchJsonPost(HELIUS_BASE, {
                jsonrpc: "2.0", id: "owner-programs", method: "getMultipleAccounts",
                params: [unknownOwners, { encoding: "base64" }],
            }, 6000, 1, heliusHeaders(key));
            type RpcAccountOwner = { owner?: string };
            const rpcRes2 = res2 as { result?: { value?: (RpcAccountOwner | null)[] } } | null;
            const ownerAccounts = rpcRes2?.result?.value ?? [];
            unknownOwners.forEach((addr, i) => {
                const prog = ownerAccounts[i]?.owner;
                if (prog) ownerProgramMap.set(addr, prog);
            });
        } catch {
            // Step 2 failure is non-fatal — step 1 results are already an improvement.
        }

        return resolved.map(h => {
            const parentProg = ownerProgramMap.get(h.owner);
            if (parentProg && LP_PROGRAM_ADDRESSES.has(parentProg)) {
                return { ...h, owner: parentProg }; // pool PDA → treat as LP vault
            }
            return h;
        });
    } catch (e) {
        logger.warn("fetchers", "resolve account owners failed, using fallback", { error: String(e) });
        return holders.map(h => ({ ...h, owner: h.address }));
    }
}
export async function heliusGetTokenSupply(mint: string, key: string) {
    return fetchJsonPost(HELIUS_BASE, {
        jsonrpc: "2.0", id: "supply", method: "getTokenSupply", params: [mint],
    }, 6000, 1, heliusHeaders(key));
}

export async function heliusGetHoldersCount(mint: string, key: string): Promise<number | null> {
    const res = await fetchJsonPost(HELIUS_BASE, {
        jsonrpc: "2.0", id: "holders-count",
        method: "getTokenAccounts",
        params: { mint, limit: 1, page: 1 },
    }, 6000, 1, heliusHeaders(key)) as HeliusTokenAccountsResponse | null;
    const total = res?.result?.total ?? res?.total;
    return typeof total === "number" ? total : null;
}

// Canonical holder-count via getProgramAccounts on the SPL Token Program,
// filtered by mint. Same approach every Solana indexer uses. Returns the
// count of token accounts ever created for this mint; slightly inflated
// vs active holders because closed empty accounts persist on chain, but
// for rug detection the difference is negligible and the result matches
// what the user sees on DexScreener.
//
// `dataSlice: {offset: 0, length: 0}` skips the per-account payload so
// only addresses come back. For high-holder tokens (BONK, WIF) the
// response is still tens of megabytes and Helius itself takes seconds to
// build it — for those the call simply times out and the chain falls
// back to the lighter sources. A 5s timeout keeps the whole scan within
// the Vercel 10s function budget when this is run in parallel with
// everything else.
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_ACCOUNT_DATA_SIZE = 165;
export async function heliusGetProgramAccountHolderCount(
    mint: string,
    key: string,
): Promise<number | null> {
    try {
        const res = await fetchJsonPost(HELIUS_BASE, {
            jsonrpc: "2.0",
            id: "holders-pa",
            method: "getProgramAccounts",
            params: [
                SPL_TOKEN_PROGRAM,
                {
                    encoding: "base64",
                    filters: [
                        { dataSize: TOKEN_ACCOUNT_DATA_SIZE },
                        { memcmp: { offset: 0, bytes: mint } },
                    ],
                    dataSlice: { offset: 0, length: 0 },
                },
            ],
        }, 5000, 1, heliusHeaders(key)) as { result?: unknown[] } | null;
        if (!res || !Array.isArray(res.result)) return null;
        return res.result.length;
    } catch {
        return null;
    }
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
        HELIUS_REST_BASE + "/v0/addresses/" + creator + "/transactions?limit=200",
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

// ─── PUBLIC SOLANA RPC POOL (free fallback) ────────────────────────────────
// Iterates the PUBLIC_SOLANA_RPCS pool until one provider answers. Same
// JSON-RPC interface as Helius so the existing isHelius*Response type
// guards work on the return value. The per-call timeout is short (4s) so a
// single dead RPC doesn't blow the whole scan budget; the fast iteration
// also means we can survive one provider being down or rate-limited
// without the user noticing — combining multiple free providers gives an
// effective rate budget several times higher than any single one.
async function publicRpcCall(method: string, params: unknown[]) {
    for (const rpc of PUBLIC_SOLANA_RPCS) {
        try {
            const res = await fetchJsonPost(rpc, {
                jsonrpc: "2.0", id: method, method, params,
            }, 4000, 1);
            // Skip RPC-level errors (rate limit, method forbidden) and
            // try the next provider in the pool.
            const r = res as { result?: unknown; error?: unknown } | null;
            if (r && r.result !== undefined) return res;
        } catch { /* try next provider */ }
    }
    return null;
}

export async function publicRpcGetLargestAccounts(mint: string) {
    return publicRpcCall("getTokenLargestAccounts", [mint]);
}

export async function publicRpcGetTokenSupply(mint: string) {
    return publicRpcCall("getTokenSupply", [mint]);
}

// getAccountInfo on the mint address returns the SPL-Token mint state:
// decimals, raw supply (string), mintAuthority, freezeAuthority. This is a
// cheap RPC call that works on every free public Solana RPC tested, so it
// is the most reliable fallback for supply when getTokenSupply is rate-
// limited. Caller divides supply by 10^decimals to get the uiAmount.
interface MintAccountInfo {
    result?: {
        value?: {
            data?: {
                parsed?: {
                    info?: {
                        decimals?: number;
                        supply?: string;
                        mintAuthority?: string | null;
                        freezeAuthority?: string | null;
                    };
                };
            };
        };
    };
}
export async function publicRpcGetMintInfo(mint: string): Promise<{
    supplyUi: number;
    decimals: number | null;
} | null> {
    const res = await publicRpcCall("getAccountInfo", [mint, { encoding: "jsonParsed" }]) as MintAccountInfo | null;
    const info = res?.result?.value?.data?.parsed?.info;
    if (!info) return null;
    const decimals = typeof info.decimals === "number" ? info.decimals : null;
    const rawSupply = typeof info.supply === "string" ? parseFloat(info.supply) : NaN;
    if (!Number.isFinite(rawSupply) || rawSupply <= 0 || decimals === null) return null;
    return { supplyUi: rawSupply / Math.pow(10, decimals), decimals };
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
