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

export const ScanResponseDataSchema = z.object({
  score: z.number(),
  risk: z.string(),
  flags: z.array(ScanResponseFlagSchema),
  pair: z.object({
    baseToken: z.object({
      symbol: z.string().optional(),
      name: z.string().optional(),
      address: z.string().optional(),
    }).optional(),
    liquidity: z.object({ usd: z.number().optional() }).optional(),
    url: z.string().optional(),
  }).nullable().optional(),
  resolvedMint: z.string().optional(),
  confidence: z.number().optional(),
  sources_used: z.array(z.string()).optional(),
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
})
