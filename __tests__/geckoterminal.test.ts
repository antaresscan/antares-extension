// __tests__/geckoterminal.test.ts
//
// GeckoTerminal as the stand-in for DexScreener. On 2026-10-07 DexScreener's API
// answered {"pairs": null} for every token, and every scan of a dexscreener.com
// page (whose URL holds a PAIR address) then scored the pool as if it were a token.
// The answers below are real ones, captured that evening (see the fixture's _about).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { geckoLookup, geckoPoolToPair } from "../api/_lib/geckoterminal";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(here, "fixtures", "geckoterminal.json"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const POOL = "HU22UBaTZa7AjMkDJaSyoDHtfFw6XVS6d9bSXLt9ugDB";
const MINT = "J9qzFhTLYnmf3tZYvHBaF96rH3YKToELAAVMzz66pump";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Answer = { status: number; body: unknown };
const ok = (body: unknown): Answer => ({ status: 200, body });
const notFound: Answer = { status: 404, body: FIXTURE.notFound };

/** Answer GeckoTerminal requests by path (what follows /networks/solana/, without the query). */
function gecko(routes: Record<string, Answer>) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url).split("/networks/solana/")[1]?.split("?")[0] ?? "";
    const a = routes[path] ?? notFound;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body, text: async () => JSON.stringify(a.body) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geckoPoolToPair on a real PumpSwap pool (SNDWITCH)", () => {
  const doc = FIXTURE.sndwitchPool;
  const pair = geckoPoolToPair(doc.data, new Map(
    (doc.included as Array<{ id: string; attributes: Record<string, string> }>).map((t) => [t.id.slice(7), { address: t.attributes.address, name: t.attributes.name, symbol: t.attributes.symbol, imageUrl: t.attributes.image_url }]),
  ));

  it("keeps the pool's address and the token behind it", () => {
    expect(pair?.pairAddress).toBe(POOL);
    expect(pair?.baseToken).toEqual({ address: MINT, symbol: "SNDWITCH", name: "Sand Witch Kitten" });
    expect(pair?.quoteToken?.address).toBe("So11111111111111111111111111111111111111112");
    expect(pair?.dexId).toBe("pumpswap");
  });

  it("reads the market numbers the engine uses, as numbers", () => {
    const a = doc.data.attributes;
    expect(pair?.liquidity?.usd).toBe(Number(a.reserve_in_usd));
    expect(pair?.liquidity?.usd).toBeGreaterThan(40_000);
    expect(pair?.volume?.h24).toBe(Number(a.volume_usd.h24));
    expect(pair?.priceChange?.h24).toBe(Number(a.price_change_percentage.h24));
    expect(pair?.txns?.m5).toEqual({ buys: a.transactions.m5.buys, sells: a.transactions.m5.sells });
    expect(pair?.priceUsd).toBe(a.base_token_price_usd);
    expect(pair?.fdv).toBe(Number(a.fdv_usd));
    expect(pair?.marketCap).toBeUndefined(); // GeckoTerminal says null here
    expect(pair?.pairCreatedAt).toBe(Date.parse("2026-10-06T19:37:18Z"));
  });

  it("has no DexScreener profile (socials, websites), and says so by leaving it out", () => {
    expect(pair?.info?.socials).toBeUndefined();
    expect(pair?.info?.websites).toBeUndefined();
    expect(pair?.info?.imageUrl).toMatch(/^https:\/\//);
  });

  it("falls back on the pool's name for the symbol when the tokens are not included", () => {
    expect(geckoPoolToPair(doc.data, new Map())?.baseToken).toEqual({ address: MINT, symbol: "SNDWITCH", name: undefined });
  });

  it("is null for anything that is not a pool", () => {
    for (const bad of [null, undefined, "x", 3, [], {}, { attributes: {}, relationships: {} }, { attributes: { address: POOL }, relationships: {} }]) {
      expect(geckoPoolToPair(bad, new Map()), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("geckoLookup", () => {
  it("a pool address (what dexscreener.com puts in its URL) gives the market and the token behind it", async () => {
    const f = gecko({
      [`pools/${POOL}`]: ok(FIXTURE.sndwitchPool),
      [`tokens/${MINT}/pools`]: ok(FIXTURE.sndwitchTokenPools),
    });

    const m = await geckoLookup(POOL);

    expect(m?.baseMint).toBe(MINT);
    expect(m?.pair.pairAddress).toBe(POOL);
    expect(m?.pair.baseToken?.symbol).toBe("SNDWITCH");
    // the token's other pool (the bonding curve, $0 liquidity) follows, for the holder analysis
    expect(m?.pairs.map((p) => p.pairAddress?.slice(0, 6))).toEqual(["HU22UB", "AUJ3eN"]);
    expect(f).toHaveBeenCalledTimes(3); // pool, token-as-address (404), then the token's pools
  });

  it("a token mint gives its most liquid pool first", async () => {
    gecko({ [`tokens/${MINT}/pools`]: ok(FIXTURE.sndwitchTokenPools) });

    const m = await geckoLookup(MINT);

    expect(m?.baseMint).toBe(MINT);
    expect(m?.pair.pairAddress).toBe(POOL);
    expect(m?.pairs).toHaveLength(2);
    expect(m!.pairs[0].liquidity!.usd!).toBeGreaterThan(m!.pairs[1].liquidity!.usd!);
  });

  it("a token that is only ever the QUOTE of its pools (USDC) has no market here: its pools describe other tokens", async () => {
    gecko({ [`tokens/${USDC}/pools`]: ok(FIXTURE.usdcTokenPools) });

    expect(await geckoLookup(USDC)).toBeNull();
  });

  it("an address GeckoTerminal does not know is null", async () => {
    gecko({});

    expect(await geckoLookup("11111111111111111111111111111111")).toBeNull();
  });

  it("a rate limit (429) or an error page is null, not an exception", async () => {
    gecko({ [`pools/${POOL}`]: { status: 429, body: { errors: [{ status: "429" }] } }, [`tokens/${POOL}/pools`]: { status: 500, body: "boom" } });

    expect(await geckoLookup(POOL)).toBeNull();
  });

  it("a network failure is null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    expect(await geckoLookup(MINT)).toBeNull();
  });

  it("an answer of another shape is null", async () => {
    gecko({ [`pools/${POOL}`]: ok({ data: { nonsense: true } }), [`tokens/${POOL}/pools`]: ok({ data: "x" }) });

    expect(await geckoLookup(POOL)).toBeNull();
  });
});
