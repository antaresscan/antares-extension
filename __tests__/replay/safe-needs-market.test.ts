// __tests__/replay/safe-needs-market.test.ts
//
// SAFE is the top verdict: it needs a market a holder can leave. The owner's bar for a blue chip is a $100k pool ("no blue chip has a pool under $100k"); read on ALL the pools of the
// token added up, a token that has nothing else against it and trades in less than that is CAUTION (decide.ts, SAFE_MIN_MARKET_DEPTH_USD). Replayed on the 1 121 recorded tokens, 40
// SAFE became CAUTION: dead memecoins (pools of $6k-$100k, a volume of a few hundred dollars a day), 3 of which had lost their pool 5 days later, and 12 of the 13 tokens that the weak
// labels call dumped and the engine called SAFE are among them. The rule runs on the real engine: the same recording is replayed with its pools scaled to the depth under test.
import { describe, it, expect } from "vitest";
import { loadRecording, replayScan, type Recording } from "./harness";
import { SAFE_MIN_MARKET_DEPTH_USD } from "../../api/_lib/constants";

const MICHI = "5mbK36SZ7J19An8jFochhQS4of8g6BwUjbeCSxBSoWdp"; // SAFE on $401k of pools: the control
const CAT = "7hWcHohzwtLddDUG81H2PkWq6KEkMtSDNkYXsso18Fy3";   // SAFE on master with $73k of pools, 12 904 holders, a volume of a few dollars
const GRPH = "9doRRAik5gvhbEwjbZDbZR6GxXSAfdoomyJR57xKpump"; // SAFE on master, $80k, its pool was gone 5 days later
const NUTS_DEEZ = "DEEZgP19ZPovNeWRJZw7KuNbkLH6xjNjZ4HsUJnmZv7J"; // SAFE on master with $6k of pools, gone 5 days later
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"; // a token of the issuer registry: judged on its market by its own rules

const thin = (flags: string[]) => flags.filter((f) => /Thin market/.test(f));

/** The recording with the pools of the token scaled so that they add up to `totalUsd` (the liquidity DexScreener gave, nothing else touched). */
function withDepth(rec: Recording, totalUsd: number): Recording {
  const copy = structuredClone(rec);
  const ex = copy.exchanges.find((e) => /dexscreener\.com\/latest\/dex\/tokens/.test(e.k) && e.s === 200)!;
  const body = JSON.parse(ex.t) as { pairs: Array<{ baseToken?: { address?: string }; liquidity?: { usd?: number } }> };
  const mine = body.pairs.filter((p) => p.baseToken?.address === rec.mint);
  const sum = mine.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  for (const p of mine) if (p.liquidity) p.liquidity.usd = ((p.liquidity.usd ?? 0) * totalUsd) / sum;
  ex.t = JSON.stringify(body);
  return copy;
}

describe("SAFE needs a market of $100k, on the real engine", () => {
  it("is the owner's bar for a blue chip", () => { expect(SAFE_MIN_MARKET_DEPTH_USD).toBe(100_000); });

  it("control: a token with nothing against it is SAFE at $400k of pools, SAFE at exactly $100k, CAUTION at $99 999 with one warning that says why", async () => {
    const rec = loadRecording(MICHI)!;
    const at400 = await replayScan(withDepth(rec, 400_000));
    expect(at400.result.risk).toBe("SAFE");
    expect(thin(at400.result.flags)).toEqual([]);
    expect((await replayScan(withDepth(rec, 100_000))).result.risk).toBe("SAFE");
    const under = await replayScan(withDepth(rec, 99_999));
    expect(under.result.risk).toBe("CAUTION");
    expect(thin(under.result.flags)).toHaveLength(1);
    expect(thin(under.result.flags)[0]).toMatch(/^warning:Thin market — \$99k in the pools: a token needs \$100k to be SAFE/);
    expect(under.result.score).toBeLessThanOrEqual(899);
  });

  it.each([["CAT", CAT], ["GRPH", GRPH], ["NUTS_DEEZ", NUTS_DEEZ]])("%s, SAFE on master, is CAUTION: its market is under $100k", async (_s, mint) => {
    const r = await replayScan(loadRecording(mint)!);
    expect(r.result.risk).toBe("CAUTION");
    expect(thin(r.result.flags)).toHaveLength(1);
    expect(r.result.score).toBeLessThanOrEqual(899);
  });

  it("a token of the issuer registry is not judged by this rule, whatever its DEX pool", async () => {
    const r = await replayScan(withDepth(loadRecording(JITOSOL)!, 50_000));
    expect(thin(r.result.flags)).toEqual([]);
  });

  it("a token that is not SAFE keeps its verdict: the rule only ever turns SAFE into CAUTION", async () => {
    const rec = loadRecording("KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP")!; // GRIFFAIN, DANGER
    const r = await replayScan(withDepth(rec, 60_000));
    expect(r.result.risk).not.toBe("SAFE");
    expect(thin(r.result.flags)).toEqual([]);
  });
});
