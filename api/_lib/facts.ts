// api/_lib/facts.ts
//
// Verified facts about a token's contract, derived from the source that can actually know: the chain itself
// (getAccountInfo on the mint) first, GoPlus (Solana contract) second.
//
// Every fact is tri-state: true = present, false = verified absent, null = NOT verified. "Not verified" is never
// turned into "OK": the overlay shows it as unknown and the AI summary does not narrate it.
import type { GoPlusTokenResult } from "./types";
import { HeliusTokenAccountsResponseSchema } from "./upstream-schemas";
import { HOLDER_PAGE_LIMIT } from "./constants";

export type Tri = boolean | null;

export interface MintState {
  program: "spl-token" | "spl-token-2022" | null;
  decimals: number | null;
  supplyRaw: string | null;
  /** true = an authority exists (it can still mint). null = the field is missing from the response. */
  mintAuthority: Tri;
  freezeAuthority: Tri;
  /** Token-2022 extension names (camelCase, as jsonParsed returns them). Empty for the classic program. */
  extensions: string[];
}

interface ParsedMintResponse {
  result?: {
    value?: {
      data?: {
        program?: string;
        parsed?: {
          type?: string;
          info?: {
            decimals?: number;
            supply?: string;
            mintAuthority?: string | null;
            freezeAuthority?: string | null;
            extensions?: Array<{ extension?: string }>;
          };
        };
      };
    };
  };
}

/** Parse a getAccountInfo(jsonParsed) response for a MINT account. Anything else (or no answer) -> null. */
export function parseMintState(raw: unknown): MintState | null {
  const r = raw as ParsedMintResponse | null;
  const data = r?.result?.value?.data;
  const info = data?.parsed?.info;
  if (!data || !info || data.parsed?.type !== "mint") return null;
  const program = data.program === "spl-token" || data.program === "spl-token-2022" ? data.program : null;
  return {
    program,
    decimals: typeof info.decimals === "number" ? info.decimals : null,
    supplyRaw: typeof info.supply === "string" ? info.supply : null,
    // A missing field is NOT "renounced": only an explicit null means renounced.
    mintAuthority: "mintAuthority" in info ? info.mintAuthority != null : null,
    freezeAuthority: "freezeAuthority" in info ? info.freezeAuthority != null : null,
    extensions: Array.isArray(info.extensions) ? info.extensions.map((e) => String(e?.extension ?? "")) : [],
  };
}

/** Supply in UI units (raw / 10^decimals). 0 when unknown. */
export function mintSupplyUi(m: MintState | null): number {
  if (!m || m.supplyRaw === null || m.decimals === null) return 0;
  const n = Number(m.supplyRaw);
  return Number.isFinite(n) && n > 0 ? n / Math.pow(10, m.decimals) : 0;
}

/** GoPlus status: "1"/1/true -> true, "0"/0/false -> false, anything else -> null. Accepts { status, authority[] }. */
export function gpStatus(v: unknown): Tri {
  const raw = v !== null && typeof v === "object" && "status" in v ? (v as { status: unknown }).status : v;
  if (raw === "1" || raw === 1 || raw === true) return true;
  if (raw === "0" || raw === 0 || raw === false) return false;
  return null;
}

// Token-2022 extensions that cannot stop a holder from selling (names checked on real mints: PAPER, PYUSD).
const BENIGN_EXTENSIONS = new Set([
  "metadataPointer", "tokenMetadata", "groupPointer", "groupMemberPointer", "tokenGroup", "tokenGroupMember",
  "immutableOwner", "memoTransfer", "cpiGuard", "mintCloseAuthority", "interestBearingConfig",
  "scaledUiAmountConfig", "confidentialTransferMint",
]);

export interface AuthorityFacts {
  mint: Tri;
  freeze: Tri;
  /**
   * Can the TOKEN itself stop a holder from selling?
   *  true  = yes (non-transferable);
   *  false = no mechanism exists (classic program or Token-2022 with only harmless extensions, and no freeze authority);
   *  null  = cannot tell (freeze authority active, transfer hook / permanent delegate / fees..., or nothing readable).
   * A liquidity pool that removes its liquidity is a different risk, covered by the liquidity signals.
   */
  sellBlocked: Tri;
  /** GoPlus lists the token as trusted (major issuers): authorities there are expected, not alarming. */
  trusted: boolean;
  source: "onchain" | "goplus" | null;
  /** The chain AND GoPlus both answered for at least one authority, so the two could be compared. */
  compared: boolean;
  /** Authorities on which the chain and GoPlus disagree. */
  conflicts: Array<"mint" | "freeze">;
  /** Token-2022 extensions that make the outcome of a sale uncertain. */
  riskyExtensions: string[];
}

export function deriveAuthorityFacts(chain: MintState | null, goplus: GoPlusTokenResult | null): AuthorityFacts {
  const gpMint = gpStatus(goplus?.mintable);
  const gpFreeze = gpStatus(goplus?.freezable);
  const mint: Tri = chain?.mintAuthority ?? gpMint;
  const freeze: Tri = chain?.freezeAuthority ?? gpFreeze;

  const conflicts: Array<"mint" | "freeze"> = [];
  if (chain?.mintAuthority != null && gpMint !== null && chain.mintAuthority !== gpMint) conflicts.push("mint");
  if (chain?.freezeAuthority != null && gpFreeze !== null && chain.freezeAuthority !== gpFreeze) conflicts.push("freeze");
  const compared = (chain?.mintAuthority != null && gpMint !== null) || (chain?.freezeAuthority != null && gpFreeze !== null);

  const source = chain && (chain.mintAuthority !== null || chain.freezeAuthority !== null) ? "onchain"
    : gpMint !== null || gpFreeze !== null ? "goplus" : null;

  const riskyExtensions = (chain?.extensions ?? []).filter((e) => !BENIGN_EXTENSIONS.has(e));
  let sellBlocked: Tri = null;
  if (chain) {
    if (chain.extensions.includes("nonTransferable")) sellBlocked = true;
    else if (freeze === false && (chain.program === "spl-token" || (chain.program === "spl-token-2022" && riskyExtensions.length === 0))) sellBlocked = false;
  } else if (goplus) {
    // Chain unreadable: GoPlus can still say "cannot be sold" (non-transferable) or, with everything clean, "no mechanism".
    const hookEmpty = Array.isArray(goplus.transfer_hook) && goplus.transfer_hook.length === 0;
    const feeEmpty = goplus.transfer_fee !== null && typeof goplus.transfer_fee === "object" && Object.keys(goplus.transfer_fee as object).length === 0;
    if (gpStatus(goplus.non_transferable) === true) sellBlocked = true;
    else if (gpFreeze === false && gpStatus(goplus.non_transferable) === false && hookEmpty && feeEmpty) sellBlocked = false;
  }

  return { mint, freeze, sellBlocked, trusted: gpStatus(goplus?.trusted_token) === true, source, compared, conflicts, riskyExtensions };
}

/**
 * Share of the MEASURABLE liquidity that is burned, weighted by pool TVL, instead of the best single pool.
 * Pools whose burn GoPlus cannot measure (concentrated-liquidity pools have no LP token to burn) are left out of the
 * share. null when no pool reports both a TVL and a burn percentage (nothing to weigh).
 * Why not the maximum: BONK's 94 % came from a $5k pool, while its large pools are burned at 0-24 %.
 */
export function weightedBurnPct(dex: ReadonlyArray<{ burn_percent?: number | null; tvl?: string | number }> | undefined): number | null {
  if (!Array.isArray(dex)) return null;
  let tvlSum = 0;
  let burned = 0;
  for (const d of dex) {
    const tvl = Number(d?.tvl);
    if (!Number.isFinite(tvl) || tvl <= 0) continue;
    if (typeof d.burn_percent !== "number") continue;
    tvlSum += tvl;
    burned += (tvl * d.burn_percent) / 100;
  }
  return tvlSum > 0 ? (burned / tvlSum) * 100 : null;
}

export interface ChainHolders {
  /** Wallets that hold a non-zero balance right now, among the accounts the page returned. */
  count: number;
  /** The page was not full, so it holds EVERY holder and `count` is exact. A full page only proves "at least `count`". */
  complete: boolean;
}

/**
 * Holder count from the pages of Helius getTokenAccounts, in page order (a single page object is accepted too). Zero
 * balances are not returned; an owner with several token accounts counts once, across pages.
 * Exactness is decided by the page SIZE: the cursor comes back on a page that is not full too (seen live: 53 accounts,
 * cursor present), and `total` is the page size, not the number of holders. The count is exact once a page that is not
 * full has been reached; if every page is full, or a page is missing (failed) before that, it is only a floor.
 * Anything that is not a well-formed first page -> null (the count stays "not verified").
 */
export function parseChainHolders(raw: unknown): ChainHolders | null {
  const pages = Array.isArray(raw) ? raw : [raw];
  if (pages.length === 0) return null;
  const owners = new Set<string>();
  let anonymous = 0;
  for (let i = 0; i < pages.length; i++) {
    const parsed = HeliusTokenAccountsResponseSchema.safeParse(pages[i]);
    if (!parsed.success) return i === 0 ? null : { count: owners.size + anonymous, complete: false }; // a missing page: a floor only
    const accounts = parsed.data.result.token_accounts;
    for (const a of accounts) {
      if (!(Number(a.amount) > 0)) continue;
      if (a.owner) owners.add(a.owner); else anonymous++;
    }
    if (accounts.length < HOLDER_PAGE_LIMIT) return { count: owners.size + anonymous, complete: true }; // the end of the list
  }
  return { count: owners.size + anonymous, complete: false }; // every page was full: at least this many
}

function positiveCount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The holder count to show, from the source that can know it:
 *  1. the chain, when the page is complete: exact and current, independent of any rate limit (BREAK 53 and PAPER 37
 *     holders; RugCheck said 173 and 427 because it counts the accounts that were emptied too);
 *  2. GoPlus holder_count: matches an independent explorer within 0.01 % on large tokens (the chain page is full there);
 *  3. RugCheck totalHolders: an upper bound (it counts emptied accounts, 2-3x too many on large tokens), still the right
 *     order of magnitude when GoPlus does not answer;
 *  4. the chain pages when they are not complete: a floor, "at least N" (N = holders read so far).
 * A GoPlus or RugCheck figure below the floor is impossible (the floor holders were counted on the chain), so the floor wins.
 * Never the number of wallets in a top-20 list: that read "20 holders" on tokens with hundreds.
 */
export function pickHolderCount(src: { chain: ChainHolders | null; goplus: unknown; rugcheck: unknown }): number | null {
  if (src.chain?.complete && src.chain.count > 0) return src.chain.count;
  const floor = src.chain && src.chain.count > 0 ? src.chain.count : 0;
  const reported = positiveCount(src.goplus) ?? positiveCount(src.rugcheck);
  if (reported === null) return floor > 0 ? floor : null;
  return Math.max(reported, floor);
}
