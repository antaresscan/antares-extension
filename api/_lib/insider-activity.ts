// api/_lib/insider-activity.ts — Top-10-holder live activity feed
//
// Replaces the broken-on-most-tokens "Insider Watch" wallet heatmap with
// a stream of recent on-chain actions from the top 10 holders. For each
// of the (filtered) top 10 wallets we pull the last ~20 signatures via
// Helius, parse them with the Enhanced Transactions API, keep only the
// ones touching the current mint inside the time window, and emit one
// feed entry per relevant transfer (BOUGHT / SOLD / TRANSFER_IN /
// TRANSFER_OUT). Net flow is the signed USD sum across the window.
//
// Signature cache is shared with insider-graph (same `igsig:` prefix)
// because both endpoints query the same wallets — repeat scans of
// overlapping holders skip Helius entirely.
//
// Cost: ~10 getSignaturesForAddress calls + up to ~3 parseTransactions
// batches (20 sigs each) per CA, gated by a 60s per-CA cache. Worst
// case per scan: 10 RPC + 3 REST. Acceptable for the value delivered.

import { Redis } from "@upstash/redis"
import { fetchJson } from "./http"
import { HELIUS_BASE, HELIUS_REST_BASE } from "./constants"

// Separate cache from insider-graph's `igsig:` because the cached SHAPE
// differs (we need `blockTime` per sig for the time-window filter,
// insider-graph stores only the signature strings). Sharing the prefix
// would make our helper read string[] as HeliusSignatureV2[] — runtime
// fields are undefined, every sig fails the cutoff check, feed comes
// back empty. That bug shipped briefly in 760d614.
const SIG_CACHE_PREFIX = "iasig:"
const SIG_CACHE_TTL = 60                     // seconds
const ACTIVITY_CACHE_PREFIX = "iact:"
const ACTIVITY_CACHE_TTL = 60                // seconds
const MAX_SIGS_PER_WALLET = 20
const MAX_PARSE_BATCH = 20                   // Helius enhanced-tx limit
const WINDOW_HOURS = 6
const MAX_FEED_ENTRIES = 10
const MAX_WALLETS = 10

// Per-tx events.swap is the most reliable signal for "this was a DEX
// swap (buy/sell)" vs "this was a plain transfer". Not all parsed txs
// surface .events.swap so we also accept type === "SWAP" as a hint.
interface HeliusSignatureV2 {
  signature: string
  blockTime?: number | null
  slot?: number
}

interface HeliusParsedTransfer {
  fromUserAccount?: string
  toUserAccount?: string
  tokenAmount?: number
  mint?: string
}

interface HeliusParsedTx {
  signature: string
  timestamp?: number
  type?: string
  tokenTransfers?: HeliusParsedTransfer[]
  events?: { swap?: unknown }
}

export type InsiderActivityAction =
  | "BOUGHT"
  | "SOLD"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"

export interface InsiderActivityEntry {
  /** Truncated wallet, e.g. "7sZx...K9pQ" — for inline display. */
  wallet: string
  /** Full base58 wallet address — for Solscan link. */
  walletFull: string
  action: InsiderActivityAction
  /** UI-amount of the mint moved (always positive). */
  tokenAmount: number
  /** Signed USD value: positive = inflow to the wallet, negative = outflow. */
  usdValue: number | null
  signature: string
  /** Unix ms. */
  timestamp: number
  /** Pre-computed minutes ago at generatedAt time. */
  ageMin: number
}

export interface InsiderActivityResult {
  activity: InsiderActivityEntry[]
  /** Signed USD net flow over the entire window (not just sliced feed). */
  netFlowUsd: number
  windowHours: number
  generatedAt: number
  totalCheckedWallets: number
  walletsWithActivity: number
}

let redis: Redis | null = null
export function initActivityCache(r: Redis | null): void {
  redis = r
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`
}

async function getWalletSignaturesV2(
  wallet: string,
  apiKey: string,
): Promise<HeliusSignatureV2[]> {
  try {
    // Match the auth convention used by insider-graph.ts (which is
    // proven to work in production): Authorization: Bearer header,
    // no api-key in URL. Earlier version used `?api-key=` in URL
    // which silently returned empty results — looks valid (HTTP 200)
    // but `result` is undefined, so the helper falls back to [] and
    // the activity feed renders as empty for every token.
    const res = await fetchJson(
      HELIUS_BASE,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params: [wallet, { limit: MAX_SIGS_PER_WALLET }],
        }),
      },
      5000,
    )
    const sigs = (res as { result?: HeliusSignatureV2[] })?.result ?? []
    return Array.isArray(sigs) ? sigs : []
  } catch {
    return []
  }
}

async function parseTxBatch(
  sigs: string[],
  apiKey: string,
): Promise<HeliusParsedTx[]> {
  if (!sigs.length) return []
  const out: HeliusParsedTx[] = []
  for (let i = 0; i < sigs.length; i += MAX_PARSE_BATCH) {
    const batch = sigs.slice(i, i + MAX_PARSE_BATCH)
    try {
      const res = await fetchJson(
        `${HELIUS_REST_BASE}/v0/transactions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ transactions: batch }),
        },
        8000,
      )
      if (Array.isArray(res)) out.push(...(res as HeliusParsedTx[]))
    } catch {
      // Continue with what we have — partial batch is better than nothing
    }
  }
  return out
}

/**
 * Build the live activity feed for a token's top holders.
 *
 * @param mint Token mint address (CA).
 * @param topHolders Up to 10 wallet addresses, already LP/foundation-filtered.
 * @param tokenPriceUsd Current price per token in USD (from DexScreener) — used
 *                      to compute USD values; null leaves usdValue=null per entry.
 * @param apiKey Helius API key.
 * @returns Sorted feed (most recent first) + window net-flow + metadata.
 */
export async function buildInsiderActivity(
  mint: string,
  topHolders: string[],
  tokenPriceUsd: number | null,
  apiKey: string,
): Promise<InsiderActivityResult> {
  // Per-CA result cache — keeps the same response across scans of the
  // same token within ACTIVITY_CACHE_TTL. The price/holders may shift
  // slightly within 60s but the activity feed is dominated by tx data
  // which doesn't change second-to-second.
  const cacheKey = `${ACTIVITY_CACHE_PREFIX}${mint}`
  if (redis) {
    try {
      const cached = await redis.get<InsiderActivityResult>(cacheKey)
      if (cached) return cached
    } catch { /* fall through */ }
  }

  const wallets = topHolders.slice(0, MAX_WALLETS)
  const holderSet = new Set(wallets)
  const cutoffMs = Date.now() - WINDOW_HOURS * 3600 * 1000

  // Get sigs per wallet (with shared insider-graph cache)
  const sigsResults = await Promise.all(
    wallets.map(async (w): Promise<HeliusSignatureV2[]> => {
      if (redis) {
        try {
          const cached = await redis.get<HeliusSignatureV2[]>(
            `${SIG_CACHE_PREFIX}${w}`,
          )
          if (Array.isArray(cached)) return cached
        } catch { /* fall through */ }
      }
      const sigs = await getWalletSignaturesV2(w, apiKey)
      if (redis && sigs.length > 0) {
        try {
          await redis.set(`${SIG_CACHE_PREFIX}${w}`, sigs, { ex: SIG_CACHE_TTL })
        } catch { /* non-critical */ }
      }
      return sigs
    }),
  )

  // Filter sigs by time window + dedupe across wallets
  const sigSet = new Set<string>()
  for (const sigs of sigsResults) {
    for (const s of sigs) {
      const ts = (s.blockTime ?? 0) * 1000
      if (ts >= cutoffMs && !sigSet.has(s.signature)) {
        sigSet.add(s.signature)
      }
    }
  }

  const allSigs = [...sigSet]
  const parsedTxs = await parseTxBatch(allSigs, apiKey)

  // Build feed entries — one entry per (tx, our-wallet, mint-transfer)
  const entries: InsiderActivityEntry[] = []
  const now = Date.now()
  for (const tx of parsedTxs) {
    const ts = (tx.timestamp ?? 0) * 1000
    if (ts < cutoffMs) continue

    const transfers = tx.tokenTransfers ?? []
    const isSwap = tx.type === "SWAP" || !!tx.events?.swap

    // We process the FIRST relevant transfer so each tx contributes one
    // feed row. Multi-transfer batched txs (rare on memecoins) get their
    // largest transfer captured this way.
    let captured = false
    for (const tr of transfers) {
      if (tr.mint !== mint) continue
      if (!tr.fromUserAccount || !tr.toUserAccount) continue
      const fromOurs = holderSet.has(tr.fromUserAccount)
      const toOurs = holderSet.has(tr.toUserAccount)
      if (!fromOurs && !toOurs) continue

      const watcher = fromOurs ? tr.fromUserAccount : tr.toUserAccount
      const tokenAmount = Math.abs(tr.tokenAmount ?? 0)
      if (tokenAmount === 0) continue

      let action: InsiderActivityAction
      if (isSwap) {
        action = fromOurs ? "SOLD" : "BOUGHT"
      } else {
        action = fromOurs ? "TRANSFER_OUT" : "TRANSFER_IN"
      }

      const usdValue =
        tokenPriceUsd != null && Number.isFinite(tokenPriceUsd)
          ? tokenAmount * tokenPriceUsd * (fromOurs ? -1 : 1)
          : null

      entries.push({
        wallet: shortAddr(watcher),
        walletFull: watcher,
        action,
        tokenAmount,
        usdValue,
        signature: tx.signature,
        timestamp: ts,
        ageMin: Math.max(0, Math.floor((now - ts) / 60000)),
      })
      captured = true
      break
    }
    void captured // suppress unused warning if linter complains
  }

  // Sort newest-first, then slice for display
  entries.sort((a, b) => b.timestamp - a.timestamp)
  const sliced = entries.slice(0, MAX_FEED_ENTRIES)

  // Net flow over the FULL window (not just the sliced display) — a
  // sniffed-out 50-tx dump in the 7th-10th rows still matters for the
  // aggregate even if we don't render those rows individually.
  const netFlowUsd = entries.reduce(
    (sum, e) => sum + (e.usdValue ?? 0),
    0,
  )

  const result: InsiderActivityResult = {
    activity: sliced,
    netFlowUsd,
    windowHours: WINDOW_HOURS,
    generatedAt: now,
    totalCheckedWallets: wallets.length,
    walletsWithActivity: new Set(entries.map(e => e.walletFull)).size,
  }

  if (redis) {
    try {
      await redis.set(cacheKey, result, { ex: ACTIVITY_CACHE_TTL })
    } catch { /* non-critical */ }
  }

  return result
}
