// __tests__/facts.test.ts
//
// Mint / freeze / sell facts, run on REAL on-chain mint accounts (getAccountInfo, jsonParsed, captured 2026-10-09/10 from a
// public Solana RPC) and REAL GoPlus answers for the same tokens (see __tests__/fixtures/upstream-real):
//   BONK    classic mint, both authorities renounced
//   PAPER   Token-2022 with only harmless extensions (metadata)
//   RENDER  classic mint, mint AND freeze authority still active   (the overlay used to show "Mint check, Freeze check")
//   HNT     classic mint, mint authority active, listed as trusted by GoPlus
//   PYUSD   Token-2022 with permanentDelegate, transferFeeConfig, transferHook... (extension names as the RPC returns them)
//   USELESS classic mint whose mint authority was SET to the System Program address (nobody can sign as it: renounced for good)
// The invariant: "not verified" is NEVER turned into "renounced" or "can sell".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseMintState, mintSupplyUi, gpStatus, deriveAuthorityFacts, type MintState } from "../api/_lib/facts";
import { pickGoPlusResult } from "../api/_lib/helpers";
import type { GoPlusTokenResult } from "../api/_lib/types";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const RENDER = "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof";
const HNT = "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux";
const PAPER = "GesEHJvkMwsaNKKVPowAhDD7P8XooDKtpswTQQ3Fpump";
const USELESS = "HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4";
const rawMint = (info: Record<string, unknown>): unknown => ({ result: { value: { data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6, supply: "1", ...info } } } } } });

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/upstream-real/${name}`, import.meta.url), "utf8"));
const chain = (name: string): MintState => parseMintState(fx(`mint-${name}.json`)) as MintState;
const goplus = (name: string, mint: string): GoPlusTokenResult => pickGoPlusResult(fx(`goplus-${name}.json`), mint) as GoPlusTokenResult;
const state = (o: Partial<MintState> = {}): MintState => ({ program: "spl-token", decimals: 6, supplyRaw: "1000000", mintAuthority: false, freezeAuthority: false, extensions: [], ...o });

describe("parseMintState on real mint accounts", () => {
  it("BONK: classic program, both authorities renounced, no extensions", () => {
    expect(chain("bonk")).toMatchObject({ program: "spl-token", mintAuthority: false, freezeAuthority: false, decimals: 5, extensions: [] });
  });

  it("RENDER: both authorities active", () => {
    expect(chain("render")).toMatchObject({ program: "spl-token", mintAuthority: true, freezeAuthority: true });
  });

  it("HNT: mint authority active, freeze authority renounced", () => {
    expect(chain("hnt")).toMatchObject({ mintAuthority: true, freezeAuthority: false });
  });

  it("USELESS: a mint authority set to the System Program is renounced, not active (nobody can sign as it)", () => {
    expect(chain("useless")).toMatchObject({ program: "spl-token", mintAuthority: false, freezeAuthority: false });
  });

  it("only the System Program counts as renounced: any other address is an active authority", () => {
    const SYSTEM = "11111111111111111111111111111111";
    // witnesses: the System Program with one character changed, a real wallet, and each authority alone at the System Program
    expect(parseMintState(rawMint({ mintAuthority: "11111111111111111111111111111112", freezeAuthority: null }))).toMatchObject({ mintAuthority: true, freezeAuthority: false });
    expect(parseMintState(rawMint({ mintAuthority: BONK, freezeAuthority: SYSTEM }))).toMatchObject({ mintAuthority: true, freezeAuthority: false });
    expect(parseMintState(rawMint({ mintAuthority: SYSTEM, freezeAuthority: BONK }))).toMatchObject({ mintAuthority: false, freezeAuthority: true });
    expect(parseMintState(rawMint({ mintAuthority: SYSTEM }))).toMatchObject({ mintAuthority: false, freezeAuthority: null }); // a missing field is still unknown
  });

  it("PAPER: Token-2022, authorities renounced, harmless extensions only", () => {
    expect(chain("paper")).toMatchObject({ program: "spl-token-2022", mintAuthority: false, freezeAuthority: false, extensions: ["metadataPointer", "tokenMetadata"] });
  });

  it("PYUSD: Token-2022 with the real extension names", () => {
    expect(chain("pyusd").extensions).toEqual(expect.arrayContaining(["permanentDelegate", "transferFeeConfig", "transferHook", "confidentialTransferFeeConfig"]));
  });

  it("reads the supply in UI units from the raw supply and the decimals", () => {
    const bonk = chain("bonk");
    expect(mintSupplyUi(bonk)).toBeCloseTo(Number(bonk.supplyRaw) / 10 ** 5, 0);
    expect(mintSupplyUi(bonk)).toBeGreaterThan(8e13);
    expect(mintSupplyUi(null)).toBe(0);
    expect(mintSupplyUi(state({ supplyRaw: "0" }))).toBe(0);
  });

  it("returns null for anything that is not a mint account answer", () => {
    expect(parseMintState(null)).toBeNull();
    expect(parseMintState({})).toBeNull();
    expect(parseMintState({ result: { value: null } })).toBeNull();
    expect(parseMintState({ result: { value: { data: { program: "spl-token", parsed: { type: "account", info: {} } } } } })).toBeNull();
  });

  it("a missing authority field is NOT 'renounced': only an explicit null is", () => {
    const s = parseMintState({ result: { value: { data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6, supply: "1" } } } } } }) as MintState;
    expect(s.mintAuthority).toBeNull();
    expect(s.freezeAuthority).toBeNull();
    expect(deriveAuthorityFacts(s, null).mint).toBeNull();
  });
});

describe("gpStatus", () => {
  it.each([
    ["1", true], [1, true], [true, true], [{ status: "1", authority: [] }, true],
    ["0", false], [0, false], [false, false], [{ status: 0 }, false],
    [undefined, null], [null, null], ["maybe", null], [{}, null],
  ])("%j -> %s", (input, expected) => {
    expect(gpStatus(input)).toBe(expected);
  });
});

describe("deriveAuthorityFacts: the chain decides, GoPlus relays", () => {
  it("BONK: everything renounced and nothing can block a sale", () => {
    const f = deriveAuthorityFacts(chain("bonk"), goplus("bonk", BONK));
    expect(f).toMatchObject({ mint: false, freeze: false, sellBlocked: false, trusted: false, source: "onchain", compared: true, conflicts: [] });
  });

  it("RENDER: both authorities active, and an active freeze authority means a sale cannot be guaranteed", () => {
    const f = deriveAuthorityFacts(chain("render"), goplus("render", RENDER));
    expect(f).toMatchObject({ mint: true, freeze: true, sellBlocked: null, trusted: false, source: "onchain", conflicts: [] });
  });

  it("HNT: mint authority active but GoPlus lists the token as trusted", () => {
    const f = deriveAuthorityFacts(chain("hnt"), goplus("hnt", HNT));
    expect(f).toMatchObject({ mint: true, freeze: false, trusted: true, sellBlocked: false });
  });

  it("USELESS: the chain (System Program authority) and GoPlus (mintable 0) agree that nobody can mint: no conflict, nothing active", () => {
    const f = deriveAuthorityFacts(chain("useless"), goplus("useless", USELESS));
    expect(f).toMatchObject({ mint: false, freeze: false, sellBlocked: false, source: "onchain", compared: true, conflicts: [] });
  });

  it("PAPER (Token-2022, harmless extensions): no mechanism can block a sale", () => {
    expect(deriveAuthorityFacts(chain("paper"), goplus("paper", PAPER)).sellBlocked).toBe(false);
  });

  it("PYUSD-like Token-2022 (permanent delegate, transfer fee, transfer hook): a sale cannot be guaranteed even without a freeze authority", () => {
    const f = deriveAuthorityFacts({ ...chain("pyusd"), freezeAuthority: false }, null);
    expect(f.sellBlocked).toBeNull();
    expect(f.riskyExtensions).toEqual(expect.arrayContaining(["permanentDelegate", "transferFeeConfig", "transferHook"]));
    expect(f.riskyExtensions).not.toContain("metadataPointer");
  });

  it("a non-transferable token cannot be sold", () => {
    expect(deriveAuthorityFacts(state({ program: "spl-token-2022", extensions: ["nonTransferable"] }), null).sellBlocked).toBe(true);
  });

  it("an unknown Token-2022 extension is not assumed harmless", () => {
    expect(deriveAuthorityFacts(state({ program: "spl-token-2022", extensions: ["someFutureExtension"] }), null).sellBlocked).toBeNull();
  });

  it("chain unreadable: GoPlus relays the authorities, and the sale verdict needs every GoPlus field to be clean", () => {
    const f = deriveAuthorityFacts(null, goplus("bonk", BONK));
    expect(f).toMatchObject({ mint: false, freeze: false, source: "goplus", compared: false, sellBlocked: false });
    const partial = deriveAuthorityFacts(null, { mintable: { status: "0" }, freezable: { status: "0" } } as GoPlusTokenResult);
    expect(partial).toMatchObject({ mint: false, freeze: false, sellBlocked: null }); // no hook / fee information: not assumed clean
  });

  it("chain unreadable: GoPlus can report an active authority", () => {
    expect(deriveAuthorityFacts(null, { mintable: { status: "1" } } as GoPlusTokenResult)).toMatchObject({ mint: true, freeze: null, source: "goplus" });
  });

  it("nothing readable: every fact stays null, never false", () => {
    expect(deriveAuthorityFacts(null, null)).toEqual({ mint: null, freeze: null, sellBlocked: null, trusted: false, source: null, compared: false, conflicts: [], riskyExtensions: [] });
  });

  it("the chain and GoPlus disagree: the chain wins and the conflict is reported", () => {
    const f = deriveAuthorityFacts(chain("render"), { mintable: { status: "0" }, freezable: { status: "1" } } as GoPlusTokenResult);
    expect(f.mint).toBe(true);
    expect(f.conflicts).toEqual(["mint"]);
    expect(f.compared).toBe(true);
  });
});
