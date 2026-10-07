// api/_lib/upstream-schemas.ts — Runtime validation for third-party API responses.
//
// Scoring correctness depends on us correctly reading fields like GoPlus
// `is_honeypot`, RugCheck's `risks` list, or Helius holder `uiAmount`. Previously
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

export const GoPlusHolderSchema = z.object({
  account: z.string().optional(),
  token_account: z.string().optional(),
  balance: z.union([z.string(), z.number()]).optional(),
  percent: z.union([z.string(), z.number()]).optional(),
  tag: z.string().optional(),
  is_locked: z.number().optional(),
});

export const GoPlusTokenResultSchema = z.object({
  // Token-2022 fields: unknown on purpose, read defensively by api/_lib/goplus.ts.
  mintable: z.unknown().optional(),
  freezable: z.unknown().optional(),
  balance_mutable_authority: z.unknown().optional(),
  default_account_state: z.union([z.string(), z.number()]).optional(),
  non_transferable: z.union([z.string(), z.number()]).optional(),
  transfer_fee: z.unknown().optional(),
  transfer_fee_upgradable: z.unknown().optional(),
  transfer_hook: z.unknown().optional(),
  transfer_hook_upgradable: z.unknown().optional(),
  dex: z.array(GoPlusDexEntrySchema).optional(),
  holder_count: z.union([z.string(), z.number()]).optional(),
  holders: z.array(GoPlusHolderSchema).optional(),
  total_supply: z.union([z.string(), z.number()]).optional(),
});

export const GoPlusResponseSchema = z.object({
  result: z.record(z.string(), GoPlusTokenResultSchema).optional(),
});

// ─── RUGCHECK ───────────────────────────────────────────────────────────────
// Mirrors the real /report/summary payload (see RugCheckSummary in types.ts).
// The earlier schema described fields RugCheck never sent (`lpBurned`,
// `topHolders.top10Percentage`...), and the full-report schema expected
// `topHolders` to be an object when it is a list, so it rejected every real
// report.
export const RugCheckRiskSchema = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
  description: z.string().optional(),
  score: z.number().optional(),
  level: z.string().optional(),
});

export const RugCheckSummarySchema = z.object({
  tokenProgram: z.string().optional(),
  tokenType: z.string().optional(),
  risks: z.array(RugCheckRiskSchema).optional(),
  score: z.number().optional(),
  score_normalised: z.number().optional(),
  lpLockedPct: z.number().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
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
