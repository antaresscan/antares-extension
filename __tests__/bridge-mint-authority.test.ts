import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { BRIDGE_MINT_AUTHORITIES } from "../api/_lib/constants";
import { deriveAuthorityFacts, parseMintState, type MintState } from "../api/_lib/facts";
import { judgeContractFacts } from "../api/_lib/layers";
import { decide, type DecideInput } from "../api/_lib/decide";
import type { DexScreenerPair, GoPlusTokenResult } from "../api/_lib/types";

// SPX (2.8 years old, 76 000 holders, $2M pool) was DANGER because the authority that can mint its supply is the Wormhole token bridge: the contract
// read as "not clean", and that turned the LP into a second critical that ignores the token's age. Nobody holds a key for that authority.

const WORMHOLE_TOKEN_BRIDGE = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb";
const WORMHOLE_MINT_AUTHORITY = "BCD75RNBHrJJpW4dXVagL5mPjzRLnVZq4YirJdjEYMV7";
const A_WALLET = "8SZRbhepUNSoPn3FaTwiHzTTVJq6sxLvYJk8A5uwJLpE"; // a plain wallet that is not a bridge (any address will do)

// ── The constant is derived, not typed: PDA(["mint_signer"], token bridge program), computed here without any library ────────────────────────────
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const P = 2n ** 255n - 19n;
const modPow = (b: bigint, e: bigint, m: bigint): bigint => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; };
const D = (P - (121665n * modPow(121666n, P - 2n, P)) % P) % P;
const base58Decode = (s: string): Buffer => { let n = 0n; for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c)); return Buffer.from(n.toString(16).padStart(64, "0"), "hex"); };
const base58Encode = (buf: Buffer): string => {
  let n = BigInt("0x" + buf.toString("hex")), out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = "1" + out; else break; }
  return out;
};
/** A 32-byte value is a valid ed25519 point (someone could hold its key) or not (a program-derived address). */
function onCurve(bytes: Buffer): boolean {
  const b = Buffer.from(bytes); b[31] &= 0x7f;
  const y = BigInt("0x" + Buffer.from(b).reverse().toString("hex"));
  if (y >= P) return false;
  const y2 = (y * y) % P, u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;
  const x2 = (u * modPow(v, P - 2n, P)) % P;
  return x2 === 0n || modPow(x2, (P - 1n) / 2n, P) === 1n;
}
function findProgramAddress(seeds: Buffer[], program: string): string {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256").update(Buffer.concat([...seeds, Buffer.from([bump]), base58Decode(program), Buffer.from("ProgramDerivedAddress")])).digest();
    if (!onCurve(h)) return base58Encode(h);
  }
  throw new Error("no bump found");
}

describe("the bridge mint authority list", () => {
  it("holds Wormhole's mint authority, which is the program-derived address of the token bridge (derived here, not typed)", () => {
    expect(findProgramAddress([Buffer.from("mint_signer")], WORMHOLE_TOKEN_BRIDGE)).toBe(WORMHOLE_MINT_AUTHORITY);
    expect(BRIDGE_MINT_AUTHORITIES.get(WORMHOLE_MINT_AUTHORITY)).toBe("Wormhole");
  });
  it("witness: the derivation does not say yes to any address (a wallet and a different seed give other addresses)", () => {
    expect(findProgramAddress([Buffer.from("mint_signer")], WORMHOLE_TOKEN_BRIDGE)).not.toBe(A_WALLET);
    expect(findProgramAddress([Buffer.from("other_seed")], WORMHOLE_TOKEN_BRIDGE)).not.toBe(WORMHOLE_MINT_AUTHORITY);
  });
});

const rawMint = (mintAuthority: string | null) => ({
  result: { value: { data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 8, supply: "1000000000", mintAuthority, freezeAuthority: null } } } } },
});

describe("facts: who holds the mint authority", () => {
  it("parseMintState keeps the address of an authority that can sign, and nothing for a renounced one", () => {
    expect(parseMintState(rawMint(WORMHOLE_MINT_AUTHORITY))).toMatchObject({ mintAuthority: true, mintAuthorityAddress: WORMHOLE_MINT_AUTHORITY });
    expect(parseMintState(rawMint(null))).toMatchObject({ mintAuthority: false, mintAuthorityAddress: null });
    expect(parseMintState(rawMint("11111111111111111111111111111111"))).toMatchObject({ mintAuthority: false, mintAuthorityAddress: null });
  });
  it("a bridge-held authority is named; a wallet, a renounced authority and an unreadable chain are not", () => {
    expect(deriveAuthorityFacts(parseMintState(rawMint(WORMHOLE_MINT_AUTHORITY)), null, "M")).toMatchObject({ mint: true, mintHolder: "Wormhole" });
    expect(deriveAuthorityFacts(parseMintState(rawMint(A_WALLET)), null, "M")).toMatchObject({ mint: true, mintHolder: null });
    expect(deriveAuthorityFacts(parseMintState(rawMint(null)), null, "M")).toMatchObject({ mint: false, mintHolder: null });
    expect(deriveAuthorityFacts(null, null, "M").mintHolder).toBeNull();
  });
  it("GoPlus saying `mintable` does not name a bridge: only the chain can (a GoPlus-only answer has no address)", () => {
    const goplus = { mintable: { status: "1" } } as unknown as GoPlusTokenResult;
    expect(deriveAuthorityFacts(null, goplus, "M")).toMatchObject({ mint: true, mintHolder: null });
  });
});

describe("judgeContractFacts: the flag of a bridge-held mint authority", () => {
  const facts = (chainAddr: string | null) => deriveAuthorityFacts(parseMintState(rawMint(chainAddr)), null, "M");
  it("is one warning that keeps the token out of SAFE, with its own soft reason, and no critical", () => {
    const v = judgeContractFacts(facts(WORMHOLE_MINT_AUTHORITY));
    expect(v.flags).toHaveLength(1);
    expect(v.flags[0]).toMatchObject({ severity: "warning", reasons: ["bridge_mint"] });
    expect(v.flags[0].label).toContain("Wormhole bridge");
    expect(v.safeBlocked).toBe(true);
  });
  it("a wallet-held authority is still a critical, as before", () => {
    const v = judgeContractFacts(facts(A_WALLET));
    expect(v.flags).toHaveLength(1);
    expect(v.flags[0]).toMatchObject({ severity: "critical", reasons: ["mint"], label: "Mint authority active — supply can be inflated" });
  });
  it("a trusted token (a major issuer) still shows it as information, bridge or not", () => {
    const trusted = { ...facts(WORMHOLE_MINT_AUTHORITY), trusted: true };
    expect(judgeContractFacts(trusted).flags[0]).toMatchObject({ severity: "info", reasons: ["mint"] });
  });
});

describe("decide: a mature token whose mint authority is the bridge", () => {
  const MINT = "J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr";
  const pair = (): DexScreenerPair => ({
    baseToken: { address: MINT, symbol: "SPX", name: "SPX6900 (Wormhole)" },
    priceUsd: "0.35", liquidity: { usd: 2_000_000 }, volume: { h24: 300_000, h1: 12_000 },
    priceChange: { m5: 0.1, h1: 0.1, h6: -0.6, h24: -3 }, txns: { m5: { buys: 6, sells: 5 } },
    pairCreatedAt: 1_700_000_000_000, marketCap: 325_000_000,
    info: { socials: [{ type: "twitter", url: "https://twitter.com/t" }], websites: [{ url: "https://t.example" }] },
  });
  // GoPlus says the liquidity is not burned: the case where "contract not clean" used to turn the LP into a critical that ignores the age.
  const unburnedLp = { dex: [{ burn_percent: 0, dex_name: "Raydium", tvl: 2_000_000 }] } as unknown as GoPlusTokenResult;
  const input = (chain: MintState | null): DecideInput => ({
    pair: pair(), dexData: null, resolvedMint: MINT, marketCap: 325_000_000, tokenAgeMinutes: 60 * 24 * 1000, holders: 76_000,
    rugData: null, rugReport: null, tokenName: "SPX6900 (Wormhole)", goplus: unburnedLp, authFacts: deriveAuthorityFacts(chain, unburnedLp, MINT),
    totalSupplyUi: 930_000_000, solscanTokenAgeHours: 24 * 1000, dexTokenAgeHours: 24 * 1000, resolvedHolderAccounts: [],
    solscanTrades24h: null, solscanTraders24h: null, solscanAnswered: false, candles: [], dailyCandles: [], recentTransfers: [], creatorReputation: null,
    organicScore: 73, // SPX: a living market (Jupiter's organic score), unless a test says otherwise
  });
  const chainOf = (auth: string): MintState => parseMintState(rawMint(auth)) as MintState;

  const high = (ath: number) => ({ ath, athDate: "2025-07-28" }); // the price is $0.35
  it("held by the bridge, a history that is not a collapse (-85 %, SPX) and a living market: no critical flag and not DANGER (the LP rule reads the token's age again)", () => {
    const d = decide({ ...input(chainOf(WORMHOLE_MINT_AUTHORITY)), allTimeHigh: high(2.27) });
    expect(d.flags.filter((f) => f.severity === "critical")).toEqual([]);
    expect(d.risk === "SAFE" || d.risk === "CAUTION").toBe(true);
    expect(d.safeBlockedReasons).toContain("bridge_mint");
    expect(d.mintHeldByBridge).toBe("Wormhole");
  });
  it("held by the bridge but the token collapsed (-96 %, TRUNK; -98 %, LUNA): the critical stays, as if a wallet held it", () => {
    for (const ath of [8.75, 17.5]) {
      const d = decide({ ...input(chainOf(WORMHOLE_MINT_AUTHORITY)), allTimeHigh: high(ath) });
      const critical = d.flags.filter((f) => f.severity === "critical").map((f) => f.label);
      expect(critical).toContain("Mint authority active — supply can be inflated");
      expect(d.risk).toBe("DANGER");
      expect(d.mintHeldByBridge).toBeNull();
    }
  });
  it("held by the bridge, -88 %: clean on the plain line, but the memory says the token had collapsed (it is still above -85 %): the critical stays", () => {
    const d = decide({ ...input(chainOf(WORMHOLE_MINT_AUTHORITY)), allTimeHigh: high(2.9), athCollapsed: true }); // price 0.35 = -88 %
    expect(d.flags.some((f) => f.severity === "critical" && /Mint authority active/.test(f.label))).toBe(true);
    expect(d.risk).toBe("DANGER");
    const clean = decide({ ...input(chainOf(WORMHOLE_MINT_AUTHORITY)), allTimeHigh: high(2.9), athCollapsed: false });
    expect(clean.flags.filter((f) => f.severity === "critical")).toEqual([]);
  });
  it("held by the bridge and the history unknown (Solscan silent, or without a price for the token): no softening, the critical stays", () => {
    for (const allTimeHigh of [null, undefined]) {
      const d = decide({ ...input(chainOf(WORMHOLE_MINT_AUTHORITY)), allTimeHigh });
      expect(d.flags.some((f) => f.severity === "critical" && /Mint authority active/.test(f.label))).toBe(true);
      expect(d.risk).toBe("DANGER");
    }
  });
  // NST (organic 0) and UNI wrapped (0) are held by the bridge too and their history is clean: a market that is not alive, or that nobody could read, gets no softening.
  it("held by the bridge, a clean history but a market that is NOT alive (organic score 0) or unknown: no softening, the critical stays", () => {
    for (const organicScore of [0, 29, null, undefined]) {
      const d = decide({ ...input(chainOf(WORMHOLE_MINT_AUTHORITY)), allTimeHigh: high(2.27), organicScore });
      expect(d.flags.some((f) => f.severity === "critical" && /Mint authority active/.test(f.label)), String(organicScore)).toBe(true);
      expect(d.risk, String(organicScore)).toBe("DANGER");
      expect(d.mintHeldByBridge).toBeNull();
    }
    const alive = decide({ ...input(chainOf(WORMHOLE_MINT_AUTHORITY)), allTimeHigh: high(2.27), organicScore: 30 });
    expect(alive.flags.filter((f) => f.severity === "critical")).toEqual([]);
    expect(alive.mintHeldByBridge).toBe("Wormhole");
  });
  it("held by a wallet: the same token is condemned twice, as before (the mint, and the LP of a contract that is not clean)", () => {
    const d = decide(input(chainOf(A_WALLET)));
    const critical = d.flags.filter((f) => f.severity === "critical").map((f) => f.label);
    expect(critical).toContain("Mint authority active — supply can be inflated");
    expect(critical.some((l) => /LP not burned or locked/.test(l))).toBe(true);
    expect(d.risk).toBe("DANGER");
  });
});
