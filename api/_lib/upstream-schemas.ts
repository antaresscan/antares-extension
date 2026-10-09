// api/_lib/upstream-schemas.ts — Runtime validation for third-party API responses.
//
// Scoring correctness depends on us correctly reading fields like GoPlus
// `is_honeypot`, RugCheck `lpBurned`, or Helius holder `uiAmount`. Previously
// these responses were cast via `as unknown as T` with only a shallow
// top-level existence check, which meant a silent upstream schema change
// could propagate into the scoring engine undetected — the exact failure
// mode that is most damaging to a security product.
//
// These Zod schemas give us:
//   1. A runtime check that each validated response has the shape scoring
//      expects. When it doesn't, we treat the response as missing instead
//      of feeding garbage into the layer.
//   2. A single place where the upstream contract lives, so a schema drift
//      shows up in one file rather than spreading silently.
//
// Schemas use `.optional()` (not `.strict()`) so unknown fields are silently
// dropped — upstream providers regularly add fields and that must not break
// us. Coverage here mirrors the existing TypeScript interfaces in types.ts
// (kept as the public-facing types); schemas are the runtime enforcer.

import { z } from "zod";

// ─── GOPLUS ─────────────────────────────────────────────────────────────────
// GoPlus returns booleans as "0"/"1"/0/1/true/false depending on the field —
// every flag-like field is therefore a union.
const GoPlusFlagSchema = z.union([z.string(), z.number(), z.boolean()]);

// Solana contract: authorities arrive as { status: "0" | "1", authority: [{ address, malicious_address }] }
// (mintable, freezable, closable, balance_mutable_authority, metadata_mutable); a few others are plain flags.
const GoPlusAuthoritySchema = z.union([
  GoPlusFlagSchema,
  z.object({
    status: z.union([z.string(), z.number()]).optional(),
    authority: z.array(z.object({
      address: z.string().optional(),
      malicious_address: z.union([z.string(), z.number()]).optional(),
    })).optional(),
  }),
]);

export const GoPlusDexEntrySchema = z.object({
  // GoPlus returns `burn_percent: null` for pools it can't measure (seen on
  // BONK/WIF/HAWK/USDC since ~2026-09). Rejecting null here dropped the
  // WHOLE token result, so the goplus layer read as "unavailable" on most
  // scans. Every consumer already guards with `typeof === "number"`.
  burn_percent: z.number().nullable().optional(),
  dex_name: z.string().optional(),
  lp_amount: z.string().nullable().optional(),
  tvl: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
});

export const GoPlusTokenResultSchema = z.object({
  is_honeypot: GoPlusFlagSchema.optional(),
  cannot_sell_all: GoPlusFlagSchema.optional(),
  mint_authority: z.string().optional(),
  freeze_authority: z.string().optional(),
  is_blacklisted: GoPlusFlagSchema.optional(),
  transfer_pausable: GoPlusFlagSchema.optional(),
  hidden_owner: GoPlusFlagSchema.optional(),
  is_proxy: GoPlusFlagSchema.optional(),
  sell_tax: z.union([z.string(), z.number()]).optional(),
  buy_tax: z.union([z.string(), z.number()]).optional(),
  owner_percent: z.union([z.string(), z.number()]).optional(),
  creator_percent: z.union([z.string(), z.number()]).optional(),
  is_mintable: GoPlusFlagSchema.optional(),
  slippage_modifiable: GoPlusFlagSchema.optional(),
  is_anti_whale_modifiable: GoPlusFlagSchema.optional(),
  trading_cooldown: GoPlusFlagSchema.optional(),
  is_whitelisted: GoPlusFlagSchema.optional(),
  dex: z.array(GoPlusDexEntrySchema).optional(),
  holder_count: z.union([z.string(), z.number()]).optional(),
  // Solana contract (real field names, checked against live responses)
  mintable: GoPlusAuthoritySchema.optional(),
  freezable: GoPlusAuthoritySchema.optional(),
  closable: GoPlusAuthoritySchema.optional(),
  balance_mutable_authority: GoPlusAuthoritySchema.optional(),
  metadata_mutable: GoPlusAuthoritySchema.optional(),
  non_transferable: GoPlusFlagSchema.optional(),
  trusted_token: GoPlusFlagSchema.optional(),
  transfer_fee: z.unknown().optional(),
  transfer_hook: z.unknown().optional(),
  holders: z.array(z.object({
    token_account: z.string().optional(),
    account: z.string().optional(),
    balance: z.union([z.string(), z.number()]).optional(),
    percent: z.union([z.string(), z.number()]).optional(),
    is_locked: z.union([z.string(), z.number()]).optional(),
    tag: z.string().optional(),
  })).optional(),
});

export const GoPlusResponseSchema = z.object({
  result: z.record(z.string(), GoPlusTokenResultSchema).optional(),
});

// ─── RUGCHECK ───────────────────────────────────────────────────────────────
export const RugCheckRiskSchema = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
  score: z.number().optional(),
  level: z.string().optional(),
  description: z.string().optional(),
});

// /report returns topHolders as an ARRAY of holders (the summary has no such field).
export const RugCheckHolderSchema = z.object({
  pct: z.number().optional(),
  owner: z.string().optional(),
  insider: z.boolean().optional(),
});

export const RugCheckTopHoldersSchema = z.object({
  top1Percentage: z.number().optional(),
  top1HolderPercentage: z.number().optional(),
  top10Percentage: z.number().optional(),
});

export const RugCheckSummarySchema = z.object({
  lpBurned: z.boolean().nullable().optional(),
  lpLocked: z.boolean().nullable().optional(),
  lpLockDurationDays: z.number().optional(),
  lpLockDuration: z.number().optional(),
  lockDurationDays: z.number().optional(),
  metaMutable: z.boolean().optional(),
  topHolders: RugCheckTopHoldersSchema.optional(),
  mintAuthorityEnabled: z.boolean().optional(),
  freezeAuthorityEnabled: z.boolean().optional(),
  lpLockedPct: z.number().nullable().optional(),
  risks: z.array(RugCheckRiskSchema).optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export const RugCheckReportSchema = z.object({
  risks: z.array(RugCheckRiskSchema).optional(),
  topHolders: z.union([RugCheckTopHoldersSchema, z.array(RugCheckHolderSchema)]).optional(),
  totalHolders: z.number().optional(),
  creator: z.string().nullable().optional(),
});

// ─── HELIUS ─────────────────────────────────────────────────────────────────
export const HeliusHolderSchema = z.object({
  address: z.string(),
  owner: z.string().optional(),
  uiAmount: z.number(),
});

export const HeliusLargestAccountsResponseSchema = z.object({
  result: z.object({
    value: z.array(HeliusHolderSchema).optional(),
  }).optional(),
});

export const HeliusSupplyResponseSchema = z.object({
  result: z.object({
    value: z.object({
      uiAmount: z.number().optional(),
    }).optional(),
  }).optional(),
});

export const HeliusTokenAccountsResponseSchema = z.object({
  result: z.object({
    total: z.number().optional(),
  }).optional(),
  total: z.number().optional(),
});
