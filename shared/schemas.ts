import { z } from "zod"
import { CA_RE } from "./constants"

// ─── Message Schemas ────────────────────────────────────────────────────────
export const ScanMessageSchema = z.object({
  type: z.literal("SCAN"),
  ca: z.string().regex(CA_RE, "Invalid Solana contract address"),
})

export const GetHistoryMessageSchema = z.object({
  type: z.literal("GET_HISTORY"),
})

export const MessageSchema = z.discriminatedUnion("type", [
  ScanMessageSchema,
  GetHistoryMessageSchema,
])

export type ScanMessage = z.infer<typeof ScanMessageSchema>
export type GetHistoryMessage = z.infer<typeof GetHistoryMessageSchema>
export type Message = z.infer<typeof MessageSchema>

// ─── API Response Schemas ───────────────────────────────────────────────────
export const ScanResponseFlagSchema = z.object({
  label: z.string(),
  severity: z.string(),
  impact: z.number(),
})

// `.passthrough()` keeps unknown fields in the parsed result — without
// it, Zod's default behaviour strips any key not declared above, and
// the API can never add new fields without us shipping a matching
// schema bump first. We want runtime *validation* (catch the day the
// shape drifts), not strict gating.
// Every optional field below is also nullable: the API serializes
// "missing" upstream values as `null`, not `undefined`. Without
// `.nullable()`, Zod rejected the payload on any field where the
// upstream returned no value — that was the root cause of incident
// PR #510 (silent overlay crash on a single optional-but-null field
// like `pair.url`). The scanner now also fails open (logs Sentry +
// uses raw payload, see contents/modules/scanner.ts) but keeping
// the schema tolerant here makes the Sentry drift signal high-signal:
// when we get a `scan_schema_drift` event, it's a real contract
// break, not just `null` vs `undefined` noise.
export const ScanResponseDataSchema = z.object({
  score: z.number(),
  risk: z.string(),
  flags: z.array(ScanResponseFlagSchema),
  pair: z.object({
    baseToken: z.object({
      symbol: z.string().nullable().optional(),
      name: z.string().nullable().optional(),
      address: z.string().nullable().optional(),
    }).nullable().optional(),
    liquidity: z.object({ usd: z.number().nullable().optional() }).nullable().optional(),
    url: z.string().nullable().optional(),
  }).nullable().optional(),
  resolvedMint: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  sources_used: z.array(z.string()).nullable().optional(),
  holders: z.number().nullable().optional(),
  marketCap: z.number().nullable().optional(),
  priceUsd: z.number().nullable().optional(),
  priceChange1h: z.number().nullable().optional(),
  liquidity: z.number().nullable().optional(),
  tokenSymbol: z.string().nullable().optional(),
  tokenName: z.string().nullable().optional(),
  mintAuthority: z.boolean().nullable().optional(),
  freezeAuthority: z.boolean().nullable().optional(),
  // Critical fields previously missing from validation
  lpBurned: z.boolean().nullable().optional(),
  lpLocked: z.boolean().nullable().optional(),
  honeypot: z.boolean().nullable().optional(),
  safeBlocked: z.boolean().optional(),
  candles: z.array(z.object({ close: z.number() })).optional(),
  // Additional API response fields
  volume24h: z.number().nullable().optional(),
  volume1h: z.number().nullable().optional(),
  priceChange5m: z.number().nullable().optional(),
  priceChange24h: z.number().nullable().optional(),
  pairCreatedAt: z.number().nullable().optional(),
  safeBlockedReasons: z.array(z.string()).optional(),
  tokenLogo: z.string().nullable().optional(),
  tokenCreator: z.string().nullable().optional(),
  tokenDecimals: z.number().nullable().optional(),
  tokenSupply: z.number().nullable().optional(),
  solscanTokenAgeHours: z.number().nullable().optional(),
  solscanVolume24h: z.number().nullable().optional(),
  solscanTrades24h: z.number().nullable().optional(),
  solscanTraders24h: z.number().nullable().optional(),
  layers: z.record(z.string(), z.object({ trust: z.number(), available: z.boolean() })).optional(),
  scoring_version: z.string().optional(),
  fetchedAt: z.number().optional(),
      recentTransfers: z.array(z.object({ from_address: z.string().optional(), to_address: z.string().optional(), from: z.string().optional(), to: z.string().optional(), amount: z.number().optional(), timestamp: z.number().optional(), type: z.string().optional() })).optional(),
    aiSummary: z.string().nullable().optional(),
    topHolderPct: z.number().nullable().optional(),
    top10HolderPct: z.number().nullable().optional(),
}).passthrough()
