// api/_lib/decide.ts — From what the upstreams said to the verdict.
//
// PURE: it takes the data the scan has already collected and returns the verdict and everything that explains it. No network, no Redis,
// no clock, no log: the same input always gives the same decision, so it can be tested on its own, and the scan handler only has to
// collect the data (before) and keep the result (after).
//
// What it does, in order: builds the seven layers from the data, merges their trust into a score, adds the flags that need the layers
// together (post-layer flags), decides the safe-gate reasons and the LP safety net, applies the safe-gate override and the score clip,
// the established-token bonus, counts the flags the verdict reads, and decides the verdict (and what kind of RUG it is).
//
// The two things the handler used to log from the middle of this code come back as `notes`: it logs them with the request id.

import type {
  DexScreenerPair, DexScreenerResponse, GoPlusTokenResult, HeliusHolder, LayerSnapshot, OHLCVCandle, RugCheckReport, RugCheckSummary,
  RugKind, SafeBlockedReason, ScanFlag, Severity, SolscanTransfer, Verdict,
} from "./types";
import type { CreatorReputation } from "./fetchers";
import type { HoldersSource } from "./holders-memory";
import {
  layerDexScreener, layerRugCheck, layerGoPlus, layerHelius, layerSolscan, layerChart, layerCrossValidation, isBlueChipByMarket, isTop10Proven, isLivingMarket, historyIsClean, isAthFlagCandidate, type Top10ReliefFacts,
} from "./layers";
import { computeFinalScore, classifySafeBlockedReasons } from "./scoring";
import {
  evaluatePostLayerFlags, applySafeGateOverride, applyEstablishedBonus, determineVerdict, rugKindOf, dedupeFlags, countVerdictFlags,
} from "./pipeline";
import { computeLpPctOfSupply, getLpRiskBucket } from "./lp-risk-matrix";
import { weightedBurnPct, type AuthorityFacts } from "./facts";
import { HARD_BLOCK_REASONS, LAYER_WEIGHTS, SOLSCAN_AGE_AND_HOLDERS_ONLY, SAFE_MIN_MARKET_DEPTH_USD } from "./constants";
import { asNumber } from "./math";
import { athDropPct, type AllTimeHigh } from "./ath";
import { makeFlag } from "./helpers";
import { issuerKindOf, judgeIssuerAsset, lstPriceInSol, type IssuerKind } from "./issuer-assets";

/** Everything the decision needs, already collected. */
export interface DecideInput {
  pair: DexScreenerPair | null;
  dexData: DexScreenerResponse | null;
  resolvedMint: string;
  marketCap: number | null;
  tokenAgeMinutes: number | null;
  holders: number | null;
  rugData: RugCheckSummary | null;
  rugReport: RugCheckReport | null;
  tokenName: string | null;
  goplus: GoPlusTokenResult | null;
  authFacts: AuthorityFacts;
  totalSupplyUi: number;
  solscanTokenAgeHours: number | null;
  dexTokenAgeHours: number | null;
  resolvedHolderAccounts: HeliusHolder[];
  solscanTrades24h: number | null;
  solscanTraders24h: number | null;
  /** Solscan answered at least one of its three calls. */
  solscanAnswered: boolean;
  candles: OHLCVCandle[];
  dailyCandles: OHLCVCandle[];
  recentTransfers: SolscanTransfer[];
  creatorReputation: CreatorReputation | null;
  /** The highest daily price the token ever traded at (Solscan), asked for only when the verdict can use it (api/_lib/ath.ts); null or absent when unknown. */
  allTimeHigh?: AllTimeHigh | null;
  /** Jupiter's organic score (real trading activity, 0 to 100), asked for only when a relief or a bridge depends on it (api/_lib/jupiter.ts); null or absent when unknown, which is no relief. */
  organicScore?: number | null;
  /** The side of the line the token is on, with the memory of where it was (judgeHistory in ath.ts); absent: the plain line on the fall computed here. */
  athCollapsed?: boolean | null;
  /** Where the list of the biggest holders came from (api/_lib/holders-memory.ts). "rugcheck": RugCheck's own report, which no second source confirmed. Absent or null: Helius, or no list. */
  holdersSource?: HoldersSource | null;
}

/** The market facts isTop10Candidate reads, from what a scan has collected before it decides (the scan asks for the all-time high only when they say it can matter). */
export function top10ReliefFactsOf(i: Pick<DecideInput, "pair" | "dexData" | "resolvedMint" | "marketCap" | "tokenAgeMinutes" | "holders" | "authFacts">): Top10ReliefFacts {
  const pool = i.pair ? asNumber(i.pair.liquidity?.usd) : null;
  // The depth of the market is ALL the pools of the token, added up (DexScreener lists up to 30: a floor); without the list, the pool the scan reads.
  const summed = (i.dexData?.pairs ?? []).filter((p) => p.baseToken?.address === i.resolvedMint).reduce((sum, p) => sum + asNumber(p.liquidity?.usd), 0);
  return {
    tokenAgeMinutes: i.tokenAgeMinutes, liquidityUsd: pool, poolDepthUsd: summed > 0 ? Math.max(summed, pool ?? 0) : pool, marketCapUsd: i.marketCap, holders: i.holders,
    mintActive: i.authFacts.mint === true && !i.authFacts.trusted && !i.authFacts.mintHolder,
    freezeActive: i.authFacts.freeze === true && !i.authFacts.trusted,
  };
}

/** Something the handler logs for this request (with its id and the mint), decided in the middle of the decision. */
export interface DecisionNote { message: string; data: Record<string, unknown> }

export interface Decision {
  score: number;
  risk: Verdict;
  /** What a RUG verdict means (see RugKind); null for any other verdict. */
  rugKind: RugKind | null;
  /** The bridge that holds the mint authority and whose softening applied to this token ("Wormhole"), else null. */
  mintHeldByBridge?: string | null;
  /** The flags of the layers and the post-layer flags, one per distinct signal, the most severe first. The engine's own: codes included. */
  flags: ScanFlag[];
  safeBlocked: boolean;
  safeBlockedReasons: SafeBlockedReason[];
  confidence: number;
  sources_used: string[];
  layersSnapshot: Record<string, LayerSnapshot>;
  lpBurned: boolean;
  lpLocked: boolean;
  /** The share of the LP that is burned, according to GoPlus, in percent (0 when unknown). */
  lpBurnedPct: number;
  notes: DecisionNote[];
  /** Set for a token of the issuer registry: its kind, and whether DexScreener gave a market reading (when not, scan.ts may serve the last good verdict). */
  issuerBacked: { kind: IssuerKind; marketRead: boolean } | null;
}

export function decide(input: DecideInput): Decision {
  const {
    pair, dexData, resolvedMint, marketCap, tokenAgeMinutes, holders, rugData, rugReport, tokenName, goplus, authFacts: authFactsAsRead, totalSupplyUi,
    solscanTokenAgeHours, dexTokenAgeHours, resolvedHolderAccounts, solscanTrades24h, solscanTraders24h, solscanAnswered,
    candles, dailyCandles, recentTransfers, creatorReputation, allTimeHigh, athCollapsed, organicScore, holdersSource,
  } = input;
  const notes: DecisionNote[] = [];

  // How far the price stands below the all-time high, when both are known.
  const athDrop = athDropPct(allTimeHigh, asNumber(pair?.priceUsd));
  // Is the market alive? (Jupiter's organic score: a daily price history cannot see a launch that pumped and dumped within hours.)
  const livingMarket = isLivingMarket(organicScore);
  // A mint authority held by a bridge is softened only for a token whose history is not a collapse AND whose market is alive (LUNA -98 %, TRUNK -96 % keep the critical: nobody holds a
  // key for the authority, but the token itself already lost almost everything, and its wrapped supply can only follow that). An unknown history, or a market nobody could read, is no softening.
  const authFacts = authFactsAsRead.mintHolder && !(livingMarket && historyIsClean(athDrop, athCollapsed)) ? { ...authFactsAsRead, mintHolder: null } : authFactsAsRead;

  // Deepest pool of THIS token (it is the base token of the pair). selectBestPair can settle on a thinner pool than the deepest
  // one (JTO: a $62k Raydium pool next to a $1.3M Orca pool); the "no registered links" check asks whether the token has real
  // liquidity somewhere, not whether the chosen pool is deep.
  const deepestPoolUsd = Math.max(0, ...(dexData?.pairs ?? []).filter((p) => p.baseToken?.address === resolvedMint).map((p) => asNumber(p.liquidity?.usd)));

  // 7 layers
  // A blue chip by the market alone (age, the pool's liquidity, market cap): its crashes are critical, not a forced RUG (isBlueChipByMarket).
  const blueChip = isBlueChipByMarket(tokenAgeMinutes, pair ? asNumber(pair.liquidity?.usd) : null, marketCap);
  const l1 = layerDexScreener(pair, marketCap, tokenAgeMinutes, holders, deepestPoolUsd, blueChip);
  // Shared maturity context — rugcheck, goplus, and helius all need
  // the same view of "is this an established token" so soft signals
  // (unburned LP, top-1 concentration on a 100k-holder memecoin) get
  // the established-context treatment consistently. Building once.
  //
  // We use the unified `holders` value (max of all sources) so the
  // helius dampening sees the same holder count the response reports.
  // Earlier version restricted to solscan+rugcheck only, which made
  // the maturity dampening miss every token where Helius/GoPlus
  // were the only sources reporting holders (most blue-chips).
  //
  // _earlyLpBurned ORs rugcheck and goplus signals so MEW/FARTCOIN
  // (LP burn confirmed by GoPlus only) get the established-context
  // treatment in helius, not just in rugcheck/goplus.
  const _gpEarlyBurnPct = weightedBurnPct(goplus?.dex) ?? 0;
  const _earlyLpBurned = rugData?.lpBurned === true ? true
    : _gpEarlyBurnPct >= 50 ? true
    : rugData?.lpBurned === false ? false
    : null;
  // Compute the share of total supply that sits in the LP. Feeds the
  // 2-axis LP risk matrix (api/_lib/lp-risk-matrix.ts) so the verdict
  // reflects actual rug-pull capacity, not just "is LP locked?". See
  // computeLpPctOfSupply for the back-compute math (DexScreener
  // doesn't expose liquidity.base directly in our schema, so we derive
  // it from liquidity.usd × priceUsd × totalSupply, accurate to ~5%
  // on classic AMM pools).
  const _lpPctOfSupply = computeLpPctOfSupply(
    asNumber(pair?.liquidity?.usd),
    asNumber(pair?.priceUsd),
    totalSupplyUi,
  );
  const maturityCtx = {
    holders: holders,
    liquidity: asNumber(pair?.liquidity?.usd),
    tokenAgeHours: solscanTokenAgeHours,
    mintAuthority: authFacts.mint === true && !authFacts.trusted && !authFacts.mintHolder, // a bridge holds it: nobody can inflate the supply, the contract is clean for the LP rule
    freezeAuthority: authFacts.freeze === true && !authFacts.trusted,
    honeypot: authFacts.sellBlocked === true,
    lpBurned: _earlyLpBurned,
    lpPctOfSupply: _lpPctOfSupply,
    top10Proven: false,
    // How far the token stands below its all-time high, only for a token that is read for it (athDropFlag says it from ATH_COLLAPSE_PCT).
    athDropPct: (isAthFlagCandidate({ tokenAgeMinutes, marketCapUsd: marketCap, issuerBacked: issuerKindOf(resolvedMint) !== null }) ? athDrop : null) as number | null,
    athDate: (allTimeHigh?.athDate ?? null) as string | null,
    athCollapsed: athCollapsed ?? null,
  };
  // A token the market has proven, whose market is alive, AND whose history does not say the insiders already sold: its concentrated top 10 is a warning, not a critical (isTop10Proven).
  maturityCtx.top10Proven = isTop10Proven({ ...top10ReliefFactsOf({ ...input, authFacts }), athDropPct: athDrop, athCollapsed, livingMarket });
  const l2 = layerRugCheck(rugData, rugReport, resolvedMint, tokenName, maturityCtx);
  const l3 = layerGoPlus(goplus, maturityCtx, authFacts);
  // Collect all DEXScreener pair addresses for this token.
  // For AMMs that use per-pool PDAs as vault authority (PumpSwap, Meteora DBC…)
  // the pair address IS the decoded authority of the LP vault token account.
  // Passing it here lets layerHelius exclude the LP vault without any extra
  // RPC calls — the data is already in memory from the DEXScreener fetch.
  const dexPairAddresses = new Set<string>(
    (dexData?.pairs ?? [])
      .map((p: DexScreenerPair) => p.pairAddress)
      .filter((a: unknown): a is string => typeof a === "string" && a.length > 0)
  );
  let l4 = layerHelius(resolvedHolderAccounts, totalSupplyUi, maturityCtx, dexPairAddresses);
  // The list came from RugCheck's own report (holders-memory.ts): the concentration is read and counts in the score, but no second source confirmed it, so SAFE stays blocked, for the
  // reason it was blocked before this fallback existed (the holders are unverified), and a line says it. A list from Helius, live or from a few hours ago, needs none of this.
  if (holdersSource === "rugcheck" && l4.available) {
    l4 = {
      ...l4,
      safeBlocked: true,
      flags: [...l4.flags, makeFlag("Holder concentration read from RugCheck — Helius did not answer, no second source confirms it", "info", 0, { fallbackReasons: ["holders"], tags: ["source_status", "concentration"] })],
    };
    notes.push({ message: "holder list from RugCheck (Helius gave none)", data: { holders: resolvedHolderAccounts.length } });
  } else if (holdersSource === "helius-last") {
    notes.push({ message: "holder list from Helius's last answer (recent, or it gave none now)", data: { holders: resolvedHolderAccounts.length } });
  }
  // Holder count: null, as it effectively always was. So the low-holder rules of layerSolscan ("Very few holders (<15)" critical,
  // "Low holders (<50)" warning, the only source of the hard reason "low_holders") never fire, although the scan knows the count
  // (`holders`, pickHolderCount: the chain, Solscan token/meta since 2026-10-13, GoPlus, RugCheck). Passing it would move verdicts:
  // the owner's decision (audit of 2026-10-17, lot 18).
  const l5 = layerSolscan(null, solscanTokenAgeHours, solscanTrades24h, solscanTraders24h, solscanAnswered);
  const l6 = layerChart(candles, pair, tokenAgeMinutes, maturityCtx, dailyCandles.length >= 2 ? dailyCandles : undefined, blueChip);
  // Solscan's age is the token's mint time, DexScreener's is a pool's: two different events, they differ for most tokens. Not a cross-check
  // while only the age is read from Solscan (SOLSCAN_AGE_AND_HOLDERS_ONLY): the -10 % trust of an "age conflict" would hit them all.
  const l7 = layerCrossValidation(rugData, resolvedHolderAccounts, goplus, SOLSCAN_AGE_AND_HOLDERS_ONLY ? null : solscanTokenAgeHours, dexTokenAgeHours, totalSupplyUi, authFacts);

  const allLayers = [l1, l2, l3, l4, l5, l6, l7];
  let score       = computeFinalScore(allLayers);
  let forceRug    = allLayers.some(l => l.forceRug);
  let safeBlocked = allLayers.some(l => l.safeBlocked);

  const buys5m  = asNumber(pair?.txns?.m5?.buys);
  const sells5m = asNumber(pair?.txns?.m5?.sells);
  const liqUsd  = asNumber(pair?.liquidity?.usd);
  const ageMin  = tokenAgeMinutes ?? 0;
  const volLiqRatio = liqUsd > 0 ? asNumber(pair?.volume?.h24) / liqUsd : 0;

  const postLayerResult = evaluatePostLayerFlags({
    buys5m, sells5m, liqUsd, ageMin,
    recentTransfers, creatorReputation, volLiqRatio,
  });
  const postLayerFlags = postLayerResult.flags;
  if (postLayerResult.forceRug) forceRug = true;
  if (postLayerResult.safeBlocked) safeBlocked = true;

  const safeBlockedReasons = classifySafeBlockedReasons(allLayers);
  const _gpBP = weightedBurnPct(goplus?.dex) ?? 0; const lpBurned = _gpBP >= 50 || rugData?.lpBurned === true;
  // Surface lpLocked from RugCheck instead of hard-wiring false. The
  // response was previously claiming "LP not locked" even when
  // RugCheck reported a real lock — which read like a contradiction
  // when the verdict surfaced LP-locked bonuses elsewhere.
  // In fact it is always false: RugCheck's summary has no `lpLocked` field (none of the 1 117 real summaries of the replay corpus;
  // what it has is `lpLockedPct`, which nothing reads). No LP lock is ever detected; an LP counts as safe only when GoPlus sees it
  // burned (lpBurned above). Audit of 2026-10-17, lot 18.
  const lpLocked = rugData?.lpLocked === true;
  const goPlusClean = l3.available && l3.trust >= 0.95 && !l3.forceRug;
  const tokenAgeHours = solscanTokenAgeHours ?? dexTokenAgeHours ?? null;

  // ─── LP fail-closed safety net ────────────────────────────────────
  // When neither RugCheck nor GoPlus can confirm LP is burned or
  // locked AND no layer has emitted an LP-related flag, force the
  // safe gate closed. Without this, brand-new tokens (low holders,
  // RugCheck has no record yet, GoPlus rate-limited) slip through
  // with SAFE verdicts despite the front-end correctly showing
  // "LP LOCK ✗" — exactly the user-reported HORNY/MAGA case.
  //
  // Maturity gate is intentionally LENIENT here (OR'd, not AND'd
  // like in the layer-level checks) because this branch only runs
  // when we have NO source-level LP signal. Failing CAUTION on a
  // mature-looking token whose API metadata happens to be missing
  // (e.g. age unknown when Solscan is degraded) is far worse for
  // the user than failing DANGER on a clean-but-tiny token. We
  // reserve hard 'lp' for tokens that score "young AND small AND
  // unknown-age" on every available signal.
  if (!lpBurned && !lpLocked) {
    const anyLpFlag = allLayers.some(l =>
      l.flags.some(f => f.tags?.includes("lp"))
    );
    if (!anyLpFlag) {
      // Fail-closed safety net: when neither RugCheck nor GoPlus emitted
      // an LP flag (typically because both upstreams returned null lpBurned
      // and lpLocked — blue chips often hit this because RugCheck is
      // patchy on long-established mints), we still need to surface SOME
      // LP signal so the user sees the unverified status.
      //
      // SCORING_VERSION 7.6.0+: this path now ALSO uses the 2-axis LP
      // risk matrix (api/_lib/lp-risk-matrix.ts) — same logic as the
      // layer-level paths — so blue chips with tiny LP % land in the
      // info bucket (no safeBlock) instead of being capped at CAUTION
      // by the old `looksMature` binary. This was the root cause of
      // BONK / WIF still showing CAUTION after the layer-level matrix
      // shipped: the safety net was running with the legacy code path
      // because the layer never emitted an LP flag in the first place.
      const bucket = getLpRiskBucket(_lpPctOfSupply, tokenAgeHours);
      postLayerFlags.push(makeFlag(bucket.flagLabel, bucket.severity, 0));
      if (bucket.safeBlock) {
        safeBlocked = true;
        // Critical buckets classify as hard 'lp'; soft buckets as 'lp_unverified'
        // (back-compat with classifySafeBlockedReasons regex order).
        const reason = bucket.severity === "critical" ? "lp" : "lp_unverified";
        if (!safeBlockedReasons.includes(reason)) safeBlockedReasons.push(reason);
      }
      if (bucket.forceRug) {
        forceRug = true;
      }
    }
  }
  const sourcesAvailableCount = allLayers
    .filter(l => l.available && l.source !== "crossvalidation")
    .length;

  const newSafeBlocked = applySafeGateOverride({
    safeBlocked, safeBlockedReasons, forceRug,
    holders, lpBurned, goPlusClean,
    tokenAgeHours, sourcesAvailableCount,
    mint: resolvedMint,
  });
  if (newSafeBlocked !== safeBlocked) {
    notes.push({ message: "safe gate override", data: { reasons: safeBlockedReasons } });
  }
  safeBlocked = newSafeBlocked;

  // Reason-aware score clipping. Splitting hard from soft reasons
  // here is what lets a mature token with only `lp_unverified` /
  // `holders` reasons land on CAUTION (≥700) instead of being
  // forced to DANGER (<700) by a blanket cap at 500.
  //   forceRug          → 100 (RUG)
  //   hard reason       → 500 (DANGER)
  //   soft reason only  → 850 (high CAUTION ceiling, lets the
  //                       layer geometric mean express how good
  //                       the rest of the profile actually is)
  if (forceRug) {
    score = Math.min(score, 100);
  } else if (safeBlocked) {
    const hasHardReasonForClip = safeBlockedReasons.some(r => HARD_BLOCK_REASONS.has(r));
    score = Math.min(score, hasHardReasonForClip ? 500 : 850);
  }

  const newScore = applyEstablishedBonus({ score, tokenAgeHours, holders, lpBurned, goPlusClean });
  if (newScore !== score) {
    notes.push({ message: "established bonus applied", data: { score: newScore } });
  }
  score = newScore;

  const sources_used: string[] = allLayers
    .filter(l => l.available && l.source !== "crossvalidation")
    .map(l => l.source);

  const _allFlagsForVerdict: ScanFlag[] = allLayers.flatMap(l => l.flags).concat(postLayerFlags);

  // One flag per distinct risk signal (the most severe kept), then the verdict is decided on THAT list: the one the user
  // sees. The counts used to be taken on the raw list, before the deduplication (audit M4). The deduplication, the counts and
  // what each kind of flag counts for are in pipeline.ts (dedupeFlags, countVerdictFlags), where they are tested.
  const flags: ScanFlag[] = dedupeFlags(_allFlagsForVerdict);
  const severityOrder: Record<Severity, number> = { critical:0, warning:1, info:2, bonus:3 };
  flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const _counts = countVerdictFlags(flags);
  let risk: Verdict = determineVerdict({
    score, forceRug, safeBlocked, safeBlockedReasons,
    sourcesUsedCount: sources_used.length,
    warningFlagsCount: _counts.warning,
    criticalFlagsCount: _counts.critical,
    pumpPriceOnlyFlagsCount: _counts.pumpPriceOnly,
  });

  // SAFE needs a market a holder can leave: under SAFE_MIN_MARKET_DEPTH_USD (all the pools added up) a token that has nothing else against it is CAUTION. A token of the issuer
  // registry is judged on its market below (judgeIssuerAsset), not here.
  const marketDepthUsd = top10ReliefFactsOf({ ...input, authFacts }).poolDepthUsd;
  if (risk === "SAFE" && issuerKindOf(resolvedMint) === null && marketDepthUsd != null && marketDepthUsd < SAFE_MIN_MARKET_DEPTH_USD) {
    risk = "CAUTION";
    flags.push(makeFlag(`Thin market — ${marketDepthUsd < 1000 ? "under $1k" : "$" + Math.floor(marketDepthUsd / 1000) + "k"} in the pools: a token needs $100k to be SAFE`, "warning", 0));
    flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    score = Math.min(score, 899);
    safeBlocked = true;
  }

  const confidence = Math.round(sources_used.reduce((sum, src) => sum + (LAYER_WEIGHTS[src] ?? 0), 0) * 100);
  const layersSnapshot: Record<string, LayerSnapshot> = Object.fromEntries(
    allLayers.map(l => [l.source, { trust: +l.trust.toFixed(3), available: l.available }])
  );

  // A stablecoin or a tokenized stock / real-world asset is built as its issuer built it (authorities, supply held by the issuer, pause...):
  // read as a meme coin it comes out RUG (measured: all 46 tokenized stocks of the corpus). Recognised by ADDRESS only, it is judged on its
  // market (api/_lib/issuer-assets.ts); with no market reading it keeps its verdict (SAFE on enough sources), never RUG.
  const issuerKind = issuerKindOf(resolvedMint);
  const issuer = issuerKind ? judgeIssuerAsset({
    kind: issuerKind, mint: resolvedMint, layers: allLayers, flags, sourcesUsedCount: sources_used.length,
    priceChange24hPct: typeof pair?.priceChange?.h24 === "number" ? pair.priceChange.h24 : null,
    priceChange1hPct: typeof pair?.priceChange?.h1 === "number" ? pair.priceChange.h1 : null,
    priceUsd: pair?.priceUsd !== undefined && Number.isFinite(Number(pair.priceUsd)) ? Number(pair.priceUsd) : null,
    poolLiquidityUsd: typeof pair?.liquidity?.usd === "number" ? pair.liquidity.usd : null,
    priceInSol: issuerKind === "lst" ? lstPriceInSol(dexData?.pairs, resolvedMint) : null,
  }) : null;
  if (issuer) notes.push({ message: "issuer-backed token judged on its market", data: { kind: issuerKind, wasRisk: risk, wasScore: score, risk: issuer.risk, score: issuer.score } });

  return {
    mintHeldByBridge: authFacts.mint === true && !authFacts.trusted ? authFacts.mintHolder ?? null : null,
    score: issuer?.score ?? score, risk: issuer?.risk ?? risk, rugKind: issuer ? issuer.rugKind : rugKindOf(risk, allLayers),
    flags: issuer?.flags ?? flags, safeBlocked: issuer?.safeBlocked ?? safeBlocked, safeBlockedReasons: issuer?.safeBlockedReasons ?? safeBlockedReasons,
    confidence, sources_used, layersSnapshot, lpBurned, lpLocked, lpBurnedPct: _gpBP, notes,
    issuerBacked: issuerKind ? { kind: issuerKind, marketRead: allLayers.some((l) => l.available && l.source === "dexscreener") } : null,
  };
}
