import type { VercelRequest, VercelResponse } from "@vercel/node";

const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";
const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const HONEYPOT_BASE = "https://api.honeypot.is/v2";
const SOLANA_CHAIN = "1399811149";

const CA_RE = /^[A-Za-z0-9]{32,44}$/;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function setHeaders(res: VercelResponse) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
}

function fetchWithTimeout(url: string, opts: RequestInit = {}, ms = 4000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function safeFetch(url: string, opts: RequestInit = {}): Promise<any> {
  try {
    const r = await fetchWithTimeout(url, opts);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setHeaders(res);
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(204).end();

  const ca = req.query.ca as string | undefined;
  if (!ca || !CA_RE.test(ca)) {
    return res.status(400).json({ error: "Invalid token address." });
  }

  try {
    // ── STEP 1: resolve CA → mint (keep existing logic) ──────────────────
    let resolvedMint = ca;

    const [dexTokenData, rugInitial] = await Promise.all([
      safeFetch(`${DEXSCREENER_BASE}/tokens/${ca}`),
      safeFetch(`${RUGCHECK_BASE}/tokens/${ca}/report/summary`),
    ]);

    let pair = dexTokenData?.pairs?.[0] ?? null;
    let rugData = rugInitial;

    const rugMissing =
      !rugData ||
      rugData?.error === "not found" ||
      rugData?.message?.toLowerCase?.().includes("not found");

    if (!pair || rugMissing) {
      const pairData = await safeFetch(`${DEXSCREENER_BASE}/pairs/solana/${ca}`);
      const resolvedPair = pairData?.pairs?.[0] ?? pairData?.pair ?? null;
      const baseMint = resolvedPair?.baseToken?.address;
      if (resolvedPair) pair = pair ?? resolvedPair;
      if (baseMint && baseMint !== ca) {
        resolvedMint = baseMint;
        const [dexRetry, rugRetry] = await Promise.all([
          safeFetch(`${DEXSCREENER_BASE}/tokens/${resolvedMint}`),
          safeFetch(`${RUGCHECK_BASE}/tokens/${resolvedMint}/report/summary`),
        ]);
        if (dexRetry?.pairs?.[0]) pair = dexRetry.pairs[0];
        if (rugRetry) rugData = rugRetry;
      }
    }

    // ── STEP 2: fetch all sources in parallel ─────────────────────────────
    const [goplusData, honeypotData, birdeyeData] = await Promise.all([
      safeFetch(`${GOPLUS_BASE}/token_security/${SOLANA_CHAIN}?contract_addresses=${resolvedMint}`),
      safeFetch(`${HONEYPOT_BASE}/IsHoneypot?address=${resolvedMint}&chainID=${SOLANA_CHAIN}`),
      safeFetch(`${BIRDEYE_BASE}/defi/token_holder?address=${resolvedMint}&offset=0&limit=20`, {
        headers: { "x-api-key": "public", "x-chain": "solana" },
      }),
    ]);

    const gp = goplusData?.result?.[resolvedMint.toLowerCase()] ?? goplusData?.result?.[resolvedMint] ?? null;
    const hp = honeypotData;
    const sources_used: string[] = [];
    if (pair) sources_used.push("DexScreener");
    if (rugData) sources_used.push("RugCheck");
    if (gp) sources_used.push("GoPlus");
    if (hp) sources_used.push("Honeypot.is");
    if (birdeyeData) sources_used.push("Birdeye");

    const confidence = Math.round((sources_used.length / 5) * 100);

    // ── STEP 3: scoring ───────────────────────────────────────────────────
    let score = 1000;
    const flags: { label: string; severity: string; impact: number }[] = [];
    let forceRug = false;
    let honeypotConfirmed = false;

    const deduct = (impact: number, label: string, severity: string) => {
      score -= impact;
      flags.push({ label, severity, impact });
    };
    const bonus = (pts: number, label: string) => {
      score += pts;
      flags.push({ label, severity: "bonus", impact: -pts });
    };

    // ── COUCHE 1: Smart Contract Risk ─────────────────────────────────────
    const mintAuth = rugData?.mintAuthorityEnabled || (gp?.mint_authority && gp.mint_authority !== "0x0000000000000000000000000000000000000000");
    const freezeAuth = rugData?.freezeAuthorityEnabled || (gp?.freeze_authority && gp.freeze_authority !== "0x0000000000000000000000000000000000000000");

    if (mintAuth) deduct(300, "Mint Authority not revoked", "critical");
    if (freezeAuth) deduct(300, "Freeze Authority not revoked", "critical");
    if (mintAuth && freezeAuth) forceRug = true;

    if (gp) {
      if (gp.is_honeypot === "1") { deduct(400, "Honeypot confirmed", "critical"); forceRug = true; honeypotConfirmed = true; }
      if (gp.cannot_sell_all === "1") { deduct(300, "Cannot sell all tokens", "critical"); forceRug = true; }
      if (gp.is_blacklisted === "1") deduct(300, "Blacklist function active", "critical");
      if (gp.transfer_pausable === "1") deduct(300, "Transfers can be paused", "critical");
      if (gp.hidden_owner === "1") deduct(300, "Hidden owner detected", "critical");
      if (gp.is_proxy === "1") deduct(300, "Upgradeable proxy contract", "critical");
      if (parseFloat(gp.sell_tax) > 0.10) deduct(250, `Sell tax ${Math.round(parseFloat(gp.sell_tax) * 100)}%`, "critical");
      if (parseFloat(gp.buy_tax) > 0.10) deduct(250, `Buy tax ${Math.round(parseFloat(gp.buy_tax) * 100)}%`, "critical");
      if (parseFloat(gp.owner_percent) > 0.05) deduct(250, `Owner holds ${Math.round(parseFloat(gp.owner_percent) * 100)}%`, "critical");
      if (parseFloat(gp.creator_percent) > 0.05) deduct(250, `Creator holds ${Math.round(parseFloat(gp.creator_percent) * 100)}%`, "critical");
      if (gp.is_mintable === "1") deduct(150, "Token is mintable", "warning");
      if (gp.slippage_modifiable === "1") deduct(150, "Tax modifiable by owner", "warning");
      if (gp.is_anti_whale_modifiable === "1") deduct(150, "Anti-whale limits modifiable", "warning");
      if (gp.trading_cooldown === "1") deduct(150, "Trading cooldown enabled", "warning");
      if (gp.is_whitelisted === "1") deduct(150, "Whitelist system active", "warning");
    }

    if (rugData) {
      if (rugData.metaMutable) deduct(150, "Mutable metadata", "warning");
      const lpBurned = rugData.lpBurned;
      const lpLocked = rugData.lpLocked;
      const lockDuration = rugData.lpLockDuration ?? 0;
      if (!lpBurned && !lpLocked) deduct(200, "LP not burned or locked", "critical");
      else if (lpLocked && lockDuration < 30) deduct(150, `LP locked < 30 days (${lockDuration}d)`, "warning");
      else if (lpBurned) bonus(100, "LP Burned ✓");
      else if (lpLocked && lockDuration >= 180) bonus(80, `LP Locked ${lockDuration}d ✓`);

      if (rugData.risks?.some((r: any) => /sniper/i.test(r.name))) deduct(150, "Sniper activity detected", "critical");
      if (rugData.risks?.some((r: any) => /bundl/i.test(r.name))) deduct(200, "Bundler launch detected", "critical");
      if (rugData.risks?.some((r: any) => /insider/i.test(r.name))) deduct(120, "Insider wallet detected", "warning");
      if (rugData.risks?.some((r: any) => /rug/i.test(r.name))) { deduct(200, "Rug pull history", "critical"); forceRug = true; }
    }

    if (!gp && !rugData) {
      flags.push({ label: "Smart contract data unavailable", severity: "info", impact: 0 });
    }

    // ── COUCHE 2: Honeypot simulation ─────────────────────────────────────
    if (hp) {
      if (hp.honeypotResult?.isHoneypot) { deduct(400, "HONEYPOT — cannot sell", "critical"); forceRug = true; honeypotConfirmed = true; }
      else if (hp.simulationResult?.sellTax > 15) deduct(200, `Honeypot.is sell tax ${hp.simulationResult.sellTax}%`, "critical");
      if (hp.simulationResult?.buyTax > 15) deduct(100, `Honeypot.is buy tax ${hp.simulationResult.buyTax}%`, "warning");
      if (hp.simulationResult?.canBuy === false) deduct(300, "Cannot buy token", "critical");
      if (hp.simulationResult?.canSell === false) { deduct(400, "Cannot sell token", "critical"); forceRug = true; }
    }

    // ── COUCHE 3: Liquidity & Pool ─────────────────────────────────────────
    if (pair) {
      const liquidity = pair.liquidity?.usd ?? 0;
      const volume24h = pair.volume?.h24 ?? 0;
      const vol5m = pair.volume?.m5 ?? 0;
      const txns5m = (pair.txns?.m5?.buys ?? 0) + (pair.txns?.m5?.sells ?? 0);
      const buys5m = pair.txns?.m5?.buys ?? 0;
      const sells5m = pair.txns?.m5?.sells ?? 0;
      const priceChange24h = pair.priceChange?.h24 ?? 0;
      const priceChange1h = pair.priceChange?.h1 ?? 0;
      const priceChange5m = pair.priceChange?.m5 ?? 0;
      const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 0;
      const ageMinutes = ageMs / 60000;
      const mcap = pair.marketCap ?? pair.fdv ?? 0;

      if (liquidity < 1000) deduct(200, `Very low liquidity ($${Math.round(liquidity).toLocaleString()})`, "critical");
      else if (liquidity < 5000) deduct(100, `Low liquidity ($${Math.round(liquidity).toLocaleString()})`, "warning");
      else if (liquidity < 20000) deduct(30, `Moderate liquidity ($${Math.round(liquidity).toLocaleString()})`, "info");

      if (liquidity > 0 && volume24h / liquidity > 20) deduct(120, "Wash trading suspected (vol/liq > 20x)", "critical");
      else if (liquidity > 0 && volume24h / liquidity > 5) deduct(60, "High vol/liq ratio (> 5x)", "warning");

      if (priceChange1h > 200 && priceChange5m > 50) deduct(100, "Coordinated pump detected", "warning");
      if (priceChange24h < -80) deduct(150, `Fatal dump -${Math.abs(priceChange24h).toFixed(0)}% 24h`, "critical");

      if (ageMinutes > 0 && ageMinutes < 1) deduct(150, "Freshly launched — extreme risk", "critical");
      else if (ageMinutes > 0 && ageMinutes < 5) deduct(80, `Token only ${ageMinutes.toFixed(1)}min old`, "warning");

      if (txns5m < 5 && mcap > 50000) deduct(80, "Low txns 5m vs market cap (wash trading)", "warning");
      if (sells5m > 0 && buys5m > sells5m * 5) deduct(60, "Coordinated buy pressure 5m", "warning");

      if (!pair.info?.socials?.length && !pair.info?.websites?.length) deduct(80, "No socials or website", "warning");
      else if (!pair.info?.socials?.length || !pair.info?.websites?.length) deduct(50, "Incomplete socials", "info");
    } else {
      deduct(100, "Not indexed on DexScreener", "warning");
    }

    // ── COUCHE 4: Holder distribution ─────────────────────────────────────
    const top10Pct = rugData?.topHolders?.top10Percentage ?? null;
    const top1Pct = rugData?.topHolders?.top1Percentage ?? null;

    if (top10Pct !== null) {
      if (top10Pct > 70) deduct(150, `Top 10 holders own ${top10Pct.toFixed(1)}%`, "critical");
      else if (top10Pct > 50) deduct(80, `Top 10 holders own ${top10Pct.toFixed(1)}%`, "warning");
    }
    if (top1Pct !== null && top1Pct > 20) deduct(150, `Top holder owns ${top1Pct.toFixed(1)}%`, "critical");

    // Birdeye holder analysis
    if (birdeyeData?.data?.items) {
      const holders: any[] = birdeyeData.data.items;
      const top1 = holders[0]?.percentage ?? 0;
      if (top1 > 0.20 && top1Pct === null) deduct(150, `Top holder owns ${(top1 * 100).toFixed(1)}% (Birdeye)`, "critical");
      // Detect possible bundle: top 5 holders all >2% with similar percentages
      const top5 = holders.slice(0, 5).map((h: any) => h.percentage ?? 0);
      const top5sum = top5.reduce((a: number, b: number) => a + b, 0);
      if (top5sum > 0.5) deduct(120, `Top 5 wallets hold ${(top5sum * 100).toFixed(1)}% — bundle risk`, "critical");
    }

    if (rugData?.creator) {
      if (rugData.risks?.some((r: any) => /dev.*sell|creator.*dump/i.test(r.name))) deduct(100, "Dev wallet sold tokens", "warning");
    }

    // ── COUCHE 5: Market signals ───────────────────────────────────────────
    // (most already handled in couche 3 above)
    if (!pair && !rugData && !gp) {
      deduct(200, "No data available from any source", "critical");
    }

    // ── FINAL SCORE ────────────────────────────────────────────────────────
    score = Math.max(0, Math.min(1000, score));

    let risk: string;
    if (forceRug || score < 350) risk = "RUG";
    else if (score < 600) risk = "DANGER";
    else if (score < 800) risk = "CAUTION";
    else risk = "SAFE";

    // Sort flags: critical first, then warning, then info, then bonus
    const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2, bonus: 3 };
    flags.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

    const tokenSymbol = pair?.baseToken?.symbol ?? null;
    const tokenName = pair?.baseToken?.name ?? null;

    return res.json({
      score,
      risk,
      flags,
      honeypotConfirmed,
      tokenSymbol,
      tokenName,
      resolvedMint,
      sources_used,
      confidence,
      scoring_version: "2.0",
    });
  } catch (e) {
    console.error("[scan v2]", e);
    return res.status(500).json({ error: "Analysis error." });
  }
}
