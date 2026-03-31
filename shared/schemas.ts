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
})
