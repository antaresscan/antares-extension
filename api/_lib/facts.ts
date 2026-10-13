// api/_lib/facts.ts
//
// Verified facts about a token's contract, derived from the source that can actually know: the chain itself
// (getAccountInfo on the mint) first, GoPlus (Solana contract) second.
//
// Every fact is tri-state: true = present, false = verified absent, null = NOT verified. "Not verified" is never
// turned into "OK": the overlay shows it as unknown and the AI summary does not narrate it.
import type { GoPlusTokenResult } from "./types";
import { HeliusTokenAccountsResponseSchema } from "./upstream-schemas";
import { HOLDER_PAGE_LIMIT, OFFICIAL_MINTS } from "./constants";

export type Tri = boolean | null;

export interface MintState {
  program: "spl-token" | "spl-token-2022" | null;
  decimals: number | null;
  supplyRaw: string | null;
  /** true = an authority that can sign exists (it can still mint). false = renounced (null, or the System Program). null = the field is missing from the response. */
  mintAuthority: Tri;
  freezeAuthority: Tri;
  /** Token-2022 extension names (camelCase, as jsonParsed returns them). Empty for the classic program. */
  extensions: string[];
  /** The state of each extension as jsonParsed returns it (authority, delegate, fee...). Absent when the response carried none. */
  extensionStates?: Record<string, Record<string, unknown>>;
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
            extensions?: Array<{ extension?: string; state?: Record<string, unknown> | null }>;
          };
        };
      };
    };
  };
}

/**
 * The System Program address (32 zero bytes). It is a program, not a wallet: no key exists for it, so nobody can sign as it.
 * A mint whose authority was set to it can never mint (or freeze) again, exactly like an authority set to null. USELESS did
 * that: the chain says `mintAuthority: "1111...1"`, and GoPlus answers `mintable: 0` while still listing that address.
 */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** Can someone still use this authority? An address that cannot sign (null, the System Program) means no. */
function authorityExists(authority: string | null | undefined): boolean {
  return authority != null && authority !== SYSTEM_PROGRAM_ID;
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
    // A missing field is NOT "renounced": only an explicit null (or the System Program, see authorityExists) means renounced.
    mintAuthority: "mintAuthority" in info ? authorityExists(info.mintAuthority) : null,
    freezeAuthority: "freezeAuthority" in info ? authorityExists(info.freezeAuthority) : null,
    extensions: Array.isArray(info.extensions) ? info.extensions.map((e) => String(e?.extension ?? "")) : [],
    extensionStates: Array.isArray(info.extensions)
      ? Object.fromEntries(info.extensions.filter((e) => e?.extension).map((e) => [String(e.extension), e.state && typeof e.state === "object" ? e.state : {}]))
      : undefined,
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

/**
 * What the Token-2022 extensions of a mint let someone do to the holders (audit A-10). Read from the state of each extension on the chain.
 * Only what is DEFINITELY there is true: an extension whose state we could not read counts as present-with-an-authority (the cautious
 * reading), because a mint with a permanent delegate that we cannot read is not a mint without one.
 */
export interface ExtensionFacts {
  /** An address can transfer or burn ANY holder's tokens (permanentDelegate with a delegate that can sign). */
  permanentDelegate: boolean;
  /** An authority can pause every transfer (pausableConfig). */
  pausable: boolean;
  /** New token accounts start frozen (defaultAccountState = frozen): nobody can sell until the freeze authority thaws their account. */
  defaultFrozen: boolean;
  /** A program runs on every transfer and can refuse it (transferHook with a program set). */
  transferHook: boolean;
  /** The transfer fee in basis points that applies now (the newer one when two are set); null = no fee extension or unreadable. */
  feeBps: number | null;
  /** An authority can change the transfer fee at any time (it can set it to 100 %). */
  feeCanChange: boolean;
}

const hasAddress = (v: unknown): boolean => typeof v === "string" && v.length > 0 && v !== SYSTEM_PROGRAM_ID;

/** The facts the extensions of a mint state. null when the mint is not a Token-2022 mint or no extension state was read. */
export function deriveExtensionFacts(chain: MintState | null | undefined): ExtensionFacts | null {
  if (!chain || chain.program !== "spl-token-2022" || chain.extensions.length === 0) return null;
  const st = chain.extensionStates ?? {};
  const has = (name: string) => chain.extensions.includes(name);
  const state = (name: string): Record<string, unknown> | null => (has(name) ? (st[name] ?? {}) : null);

  const pd = state("permanentDelegate");
  // A state with no `delegate` key at all is an unreadable state: the cautious reading is "there is one".
  const permanentDelegate = pd !== null && (!("delegate" in pd) || hasAddress(pd.delegate));

  const pausable = has("pausableConfig");

  const das = state("defaultAccountState");
  const defaultFrozen = das !== null && String(das.accountState ?? "").toLowerCase() === "frozen";

  const th = state("transferHook");
  const transferHook = th !== null && (!("programId" in th) || hasAddress(th.programId));

  const tf = state("transferFeeConfig");
  let feeBps: number | null = null;
  let feeCanChange = false;
  if (tf !== null) {
    const bps = (o: unknown): number | null => {
      const n = Number((o as { transferFeeBasisPoints?: unknown } | null | undefined)?.transferFeeBasisPoints);
      return Number.isFinite(n) ? n : null;
    };
    // Two fees can be set (the older one applies until its epoch passes): the one that can hit the holder is the higher of the two.
    const a = bps(tf.newerTransferFee), b = bps(tf.olderTransferFee);
    feeBps = a === null && b === null ? null : Math.max(a ?? 0, b ?? 0);
    feeCanChange = !("transferFeeConfigAuthority" in tf) || hasAddress(tf.transferFeeConfigAuthority);
  }
  return { permanentDelegate, pausable, defaultFrozen, transferHook, feeBps, feeCanChange };
}

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
  /**
   * Major issuers hold authorities by design (USDC, USDT...): they are expected, not alarming. GoPlus says so (trusted_token);
   * when GoPlus said nothing about this token, our own list of official mints stands in, so an outage does not turn USDC critical.
   */
  trusted: boolean;
  source: "onchain" | "goplus" | null;
  /** The chain AND GoPlus both answered for at least one authority, so the two could be compared. */
  compared: boolean;
  /** Authorities on which the chain and GoPlus disagree. */
  conflicts: Array<"mint" | "freeze">;
  /** Token-2022 extensions that make the outcome of a sale uncertain. */
  riskyExtensions: string[];
  /** What the Token-2022 extensions let someone do to the holders; null for a classic mint (or nothing readable). */
  extensionFacts?: ExtensionFacts | null;
}

export function deriveAuthorityFacts(chain: MintState | null, goplus: GoPlusTokenResult | null, mintAddress?: string): AuthorityFacts {
  const gpMint = gpStatus(goplus?.mintable);
  const gpFreeze = gpStatus(goplus?.freezable);
  const gpTrusted = gpStatus(goplus?.trusted_token);
  // GoPlus silent on this token (down, or no record): only then does the official list decide. When GoPlus answered, it decides.
  const trusted = gpTrusted === true || (gpTrusted === null && gpMint === null && gpFreeze === null && mintAddress !== undefined && OFFICIAL_MINTS.has(mintAddress));
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

  return { mint, freeze, sellBlocked, trusted, source, compared, conflicts, riskyExtensions, extensionFacts: deriveExtensionFacts(chain) };
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

export function positiveCount(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The holder count to show, from the source that can know it:
 *  1. the chain, when the page is complete: exact and current, independent of any rate limit (BREAK 53 and PAPER 37
 *     holders; RugCheck said 173 and 427 because it counts the accounts that were emptied too);
 *  2. Solscan `holder` (token/meta): as exact as the chain (a median difference of 0.0 % on 40 real tokens, 34 of 40 within 15 %: the rest are
 *     young tokens whose count moved between the capture and the probe), and it has no 10,000 cap;
 *  3. GoPlus holder_count: close to an independent explorer on large tokens, but NOT exact: against the chain on 167 recorded tokens it
 *     counts 1.03x at the median, 1.16x at the 95th percentile, up to 1.80x at the worst (the chain page is full above 10,000 holders);
 *  4. RugCheck totalHolders: an upper bound (it counts emptied accounts, 2-3x too many on large tokens), still the right
 *     order of magnitude when GoPlus does not answer;
 *  5. the chain pages when they are not complete: a floor, "at least N" (N = holders read so far).
 * A Solscan, GoPlus or RugCheck figure below the floor is impossible (the floor holders were counted on the chain), so the floor wins.
 * Never the number of wallets in a top-20 list: that read "20 holders" on tokens with hundreds.
 */
export function pickHolderCount(src: { chain: ChainHolders | null; solscan?: unknown; goplus: unknown; rugcheck: unknown }): number | null {
  if (src.chain?.complete && src.chain.count > 0) return src.chain.count;
  const floor = src.chain && src.chain.count > 0 ? src.chain.count : 0;
  const reported = positiveCount(src.solscan) ?? positiveCount(src.goplus) ?? positiveCount(src.rugcheck);
  if (reported === null) return floor > 0 ? floor : null;
  return Math.max(reported, floor);
}
