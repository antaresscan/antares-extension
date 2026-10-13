// __tests__/issuer-registry-watch.test.ts
//
// The registry of issuer-backed tokens (api/_lib/issuer-assets.data.ts) is built once from Jupiter's verified list. Every Monday
// .github/workflows/issuer-registry-watch.yml compares the list with it (scripts/issuer-assets/watch.mjs) and opens ONE issue when they
// differ. What is pinned here: the comparison reads the real data file correctly (a change of its shape would silently blind the watch),
// the sorting rules are the ones that built the registry, a symbol from the third-party list cannot do anything in the issue it ends up in,
// and the workflow can do no more than read the code and write issues.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LST_MINTS, STABLE_MINTS, TOKENIZED_MINTS, VAULT_MINTS, WRAPPED_MINTS, YIELD_MINTS } from "../api/_lib/issuer-assets.data";

type Kind = "stable" | "tokenized" | "lst" | "wrapped" | "yield" | "vault";
type Mints = Record<Kind, string[]>;
type Registry = Mints & { date: string; verified: number };
interface Diff { kinds: Record<Kind, { added: string[]; removed: string[] }>; added: number; removed: number }
interface Token { id?: string; symbol?: string; tags?: string[] }
interface Lib {
  KINDS: Array<{ kind: Kind; name: string }>;
  WRAPPED_EXTRA: string[];
  VAULT_EXTRA: string[];
  classify(list: Token[]): Mints;
  assertPlausible(list: Token[], registry: Mints): void;
  parseRegistry(text: string): Registry;
  diffRegistry(committed: Mints, fresh: Mints): Diff | null;
  symbolsOf(list: Token[]): Map<string, string>;
  safeSymbol(s: unknown): string;
  renderReport(diff: Diff, ctx: { symbols?: Map<string, string>; committedDate: string; committedVerified: number; freshVerified: number; today: string }): string;
}
// .mjs is not type-checked in this repo: load it dynamically.
const lib = (await import(/* @vite-ignore */ new URL("../scripts/issuer-assets/lib.mjs", import.meta.url).href)) as unknown as Lib;

const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const TBTC = "6DNSN2BJsaPFdFFc1zP37kkeNe4Usc1Sqkzr9C9vPWcU";
const JLP = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const WSOL = "So11111111111111111111111111111111111111112";

// A valid-looking mint (base58, 43 characters), different for every i.
const ALPHABET = "abcdefghijkmnopqrstu";
const mint = (i: number) => { let s = ""; for (let n = i + 1; n > 0; n = Math.floor(n / 20)) s = ALPHABET[n % 20] + s; return s.padStart(43, "A"); };
const tok = (i: number, tags: string[], symbol = `T${i}`): Token => ({ id: mint(i), symbol, tags });
const emptyMints = (): Mints => ({ stable: [], tokenized: [], lst: [], wrapped: [], yield: [], vault: [] });

describe("parseRegistry: reads the committed data file back", () => {
  const text = readFileSync(new URL("../api/_lib/issuer-assets.data.ts", import.meta.url), "utf8");
  const parsed = lib.parseRegistry(text);

  it("finds every mint of every kind of the real file, in the order it is written", () => {
    expect(parsed.stable).toEqual([...STABLE_MINTS]);
    expect(parsed.tokenized).toEqual([...TOKENIZED_MINTS]);
    expect(parsed.lst).toEqual([...LST_MINTS]);
    expect(parsed.wrapped).toEqual([...WRAPPED_MINTS]);
    expect(parsed.yield).toEqual([...YIELD_MINTS]);
    expect(parsed.vault).toEqual([...VAULT_MINTS]);
  });

  it("finds the date and the size of the list it was built from", () => {
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parsed.verified).toBeGreaterThan(1000);
  });

  it("refuses a file whose shape it does not know (the watch would be blind, so the run turns red instead)", () => {
    expect(() => lib.parseRegistry(text.replace("export const YIELD_MINTS", "export const YIELD_TOKENS"))).toThrow(/YIELD_MINTS was not found/);
    expect(() => lib.parseRegistry(text.replace(/read by tags on/, "read on"))).toThrow(/header/);
    expect(() => lib.parseRegistry(text.replace(STABLE_MINTS[0], "not-a-mint"))).toThrow(/not a mint address/);
  });

  it("the committed registry is what the sorting rules give for its own kinds (disjoint, sorted)", () => {
    const all = lib.KINDS.flatMap(({ kind }) => parsed[kind]);
    expect(new Set(all).size).toBe(all.length);
    for (const { kind } of lib.KINDS) expect(parsed[kind]).toEqual([...parsed[kind]].sort());
  });
});

describe("classify: the rules that built the registry", () => {
  it("sorts a token by its tags, one kind only, with the same priority as before", () => {
    const r = lib.classify([
      tok(1, ["verified", "stable"]), tok(2, ["verified", "xstocks"]), tok(3, ["verified", "lst"]), tok(4, ["verified", "major"]),
      tok(5, ["verified", "yb"]), tok(6, ["verified", "jup-lend-earn"]),
      tok(7, ["verified", "stable", "rwa"]), // stable wins over tokenized
      tok(8, ["verified", "jup-lend-earn", "yb"]), // the vault wins over yield
    ]);
    expect(r.stable).toEqual([mint(1), mint(7)].sort());
    expect(r.tokenized).toEqual([mint(2)]);
    expect(r.lst).toEqual([mint(3)]);
    expect(r.wrapped).toEqual([mint(4)]);
    expect(r.yield).toEqual([mint(5)]);
    expect(r.vault).toEqual([mint(6), mint(8)].sort());
  });

  it("leaves out what is not verified, a meme coin that carries the words, deprecated / duplicate / internal tokens, wrapped SOL, a bad address", () => {
    const r = lib.classify([
      tok(1, ["stable"]), // not verified
      tok(2, ["verified", "meme", "rwa"]), tok(3, ["verified", "launchpad", "stable"]), tok(4, ["verified", "deprecated", "lst"]),
      tok(5, ["verified", "duplicate", "stable"]), tok(6, ["verified", "internal", "stable"]),
      { id: WSOL, symbol: "SOL", tags: ["verified", "lst"] },
      { id: "not a mint", tags: ["verified", "stable"] }, { tags: ["verified", "stable"] },
    ]);
    expect(lib.KINDS.flatMap(({ kind }) => r[kind])).toEqual([]);
  });

  it("moonshot-verified is not a reason to leave a token out (USDC, USDT and PYUSD carry it)", () => {
    expect(lib.classify([tok(1, ["verified", "stable", "moonshot-verified"])]).stable).toEqual([mint(1)]);
  });

  it("the tokens checked by hand are in by address, whatever their tags (cbBTC, tBTC wrapped; JLP vault)", () => {
    const r = lib.classify([{ id: CBBTC, tags: ["verified"] }, { id: TBTC, tags: ["verified"] }, { id: JLP, tags: ["verified", "defi", "strict"] }]);
    expect(r.wrapped).toEqual([CBBTC, TBTC].sort());
    expect(r.vault).toEqual([JLP]);
  });

  it("a token listed twice is in once, and each kind is sorted", () => {
    const r = lib.classify([tok(9, ["verified", "stable"]), tok(2, ["verified", "stable"]), tok(9, ["verified", "stable"])]);
    expect(r.stable).toEqual([mint(2), mint(9)].sort());
  });
});

describe("assertPlausible: a broken list stops the run", () => {
  // Enough of everything to pass: 1000+ tokens, and each kind above its floor, with the tokens checked by hand.
  const fullList = (): Token[] => {
    const l: Token[] = [];
    let i = 0;
    for (let n = 0; n < 12; n++) l.push(tok(i++, ["verified", "stable"]));
    for (let n = 0; n < 110; n++) l.push(tok(i++, ["verified", "xstocks"]));
    for (let n = 0; n < 55; n++) l.push(tok(i++, ["verified", "lst"]));
    for (let n = 0; n < 6; n++) l.push(tok(i++, ["verified", "major"]));
    for (let n = 0; n < 6; n++) l.push(tok(i++, ["verified", "yb"]));
    for (let n = 0; n < 6; n++) l.push(tok(i++, ["verified", "jup-lend-earn"]));
    l.push({ id: CBBTC, tags: ["verified"] }, { id: TBTC, tags: ["verified"] }, { id: JLP, tags: ["verified"] });
    while (l.length < 1100) l.push(tok(i++, ["verified"]));
    return l;
  };

  it("accepts a complete list", () => {
    const l = fullList();
    expect(() => lib.assertPlausible(l, lib.classify(l))).not.toThrow();
  });

  it("refuses a list that is too short, or not a list", () => {
    const l = fullList().slice(0, 900);
    expect(() => lib.assertPlausible(l, lib.classify(l))).toThrow(/unexpected list/);
    expect(() => lib.assertPlausible({} as unknown as Token[], emptyMints())).toThrow(/unexpected list/);
  });

  it("refuses a list where a token checked by hand is gone, or became another kind", () => {
    const noCb = fullList().filter((t) => t.id !== CBBTC);
    expect(() => lib.assertPlausible(noCb, lib.classify(noCb))).toThrow(/cbbtc.*checked by hand/);
    const noJlp = fullList().filter((t) => t.id !== JLP);
    expect(() => lib.assertPlausible(noJlp, lib.classify(noJlp))).toThrow(/27G8Mt.*checked by hand/);
    const jlpAsMeme = fullList().map((t) => (t.id === JLP ? { ...t, tags: ["verified", "meme"] } : t));
    expect(() => lib.assertPlausible(jlpAsMeme, lib.classify(jlpAsMeme))).toThrow(/checked by hand/);
  });

  it("refuses a list where a kind is nearly empty (a tag renamed upstream)", () => {
    const noStable = fullList().map((t) => ({ ...t, tags: (t.tags ?? []).filter((x) => x !== "stable") }));
    expect(() => lib.assertPlausible(noStable, lib.classify(noStable))).toThrow(/suspiciously small/);
  });
});

describe("diffRegistry: what changed", () => {
  const base = (): Mints => ({ ...emptyMints(), stable: [mint(1), mint(2)], tokenized: [mint(3)], lst: [mint(4)] });

  it("is null when nothing changed", () => {
    expect(lib.diffRegistry(base(), base())).toBeNull();
  });

  it("lists what was added and what was removed, per kind, with the totals", () => {
    const fresh = { ...base(), stable: [mint(1), mint(5)], tokenized: [mint(3), mint(6), mint(7)] };
    const d = lib.diffRegistry(base(), fresh)!;
    expect(d.kinds.stable).toEqual({ added: [mint(5)], removed: [mint(2)] });
    expect(d.kinds.tokenized).toEqual({ added: [mint(6), mint(7)], removed: [] });
    expect(d.kinds.lst).toEqual({ added: [], removed: [] });
    expect(d.added).toBe(3);
    expect(d.removed).toBe(1);
  });

  it("a token that moves from one kind to another is a removal in one and an addition in the other", () => {
    const fresh = { ...base(), lst: [], tokenized: [mint(3), mint(4)] };
    const d = lib.diffRegistry(base(), fresh)!;
    expect(d.kinds.lst).toEqual({ added: [], removed: [mint(4)] });
    expect(d.kinds.tokenized).toEqual({ added: [mint(4)], removed: [] });
  });

  it("a removal alone is a change too (the token is judged the strict way again)", () => {
    const d = lib.diffRegistry(base(), { ...base(), stable: [mint(1)] })!;
    expect(d.added).toBe(0);
    expect(d.removed).toBe(1);
  });
});

describe("renderReport: the issue body", () => {
  const ctx = { committedDate: "2026-10-13", committedVerified: 3838, freshVerified: 3966, today: "2026-10-20" };
  const diffOf = (added: string[], removed: string[] = []): Diff => {
    const fresh: Mints = { ...emptyMints(), tokenized: [...added] };
    const old: Mints = { ...emptyMints(), tokenized: [...removed] };
    return lib.diffRegistry(old, fresh)!;
  };

  it("says how many were added and removed, since when, and how to refresh (the verdicts that move are shown first)", () => {
    const body = lib.renderReport(diffOf([mint(1), mint(2)], [mint(3)]), ctx);
    expect(body).toContain("**2 added, 1 removed** since it was built on 2026-10-13 (3838 verified tokens then, 3966 on 2026-10-20)");
    expect(body).toContain("| tokenized | 2 | 1 |");
    expect(body).toContain("| stable | 0 | 0 |");
    expect(body).toContain("node scripts/issuer-assets/build.mjs");
    expect(body).toContain("REPLAY_UPDATE=1 npx vitest run __tests__/replay");
    expect(body).toContain("ENGINE_VERSION_MANUAL");
    expect(body).toMatch(/never SAFE by mistake/);
  });

  it("shows the symbol of an added token and the address of a removed one", () => {
    const body = lib.renderReport(diffOf([mint(1)], [mint(2)]), { ...ctx, symbols: new Map([[mint(1), "AAPLx"]]) });
    expect(body).toContain(`- \`AAPLx\` \`${mint(1)}\``);
    expect(body).toContain(`- \`${mint(2)}\``);
  });

  it("caps the lists at 20 and says how many more", () => {
    const many = Array.from({ length: 126 }, (_, i) => mint(i));
    const body = lib.renderReport(diffOf(many), ctx);
    expect(body).toContain("**Added** (126)");
    expect(body.match(/^- `/gm)).toHaveLength(20);
    expect(body).toContain("- … and 106 more");
  });

  it("a symbol from the third-party list cannot mention anybody, open a link, close the code span or start a heading", () => {
    const payload = "AAPLx`)[click](http://evil.example) @everyone\n# pwn";
    const body = lib.renderReport(diffOf([mint(1)]), { ...ctx, symbols: new Map([[mint(1), payload]]) });
    // what is left of it is plain letters in a code span: no link (no "://", no brackets), no mention, no heading, no line break
    for (const bad of ["evil", "@", "](", "[", "://", "# pwn", "everyone"]) expect(body.split("### To refresh")[0]).not.toContain(bad);
    expect(lib.safeSymbol(payload)).toBe("AAPLxclickhttpev");
    expect(lib.safeSymbol(undefined)).toBe("?");
    expect(lib.safeSymbol("<script>`")).toBe("script");
    expect(lib.safeSymbol("")).toBe("?");
    expect(lib.safeSymbol("a".repeat(40))).toHaveLength(16);
    expect(lib.safeSymbol("USD*")).toBe("USD*");
  });

  it("symbolsOf keeps the symbol of a token with a valid address only", () => {
    const m = lib.symbolsOf([tok(1, [], "AAPLx"), { id: "bad", symbol: "X" }, { symbol: "Y" } as Token]);
    expect([...m.entries()]).toEqual([[mint(1), "AAPLx"]]);
  });
});

describe("the workflow can read the code and write issues, nothing else", () => {
  const yml = readFileSync(new URL("../.github/workflows/issuer-registry-watch.yml", import.meta.url), "utf8");
  const code = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

  it("runs every Monday and by hand", () => {
    expect(code).toMatch(/cron: "0 6 \* \* 1"/);
    expect(code).toMatch(/workflow_dispatch:/);
  });

  it("its token reads the code and writes issues: no pull request, no push, no other write", () => {
    expect(code).toMatch(/permissions:\s*\n\s+contents: read\s*\n\s+issues: write/);
    expect(code).not.toMatch(/(contents|pull-requests|actions|checks|packages|deployments|statuses|id-token|security-events): write/);
    expect(code).not.toMatch(/write-all/);
    expect(code).not.toMatch(/\bgit (push|commit)\b|gh pr (create|merge)|gh api/);
  });

  it("uses no secret and no third-party action (only GitHub's checkout), and installs nothing", () => {
    expect(code).not.toMatch(/secrets\./);
    const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^actions\/checkout@v\d+$/);
    expect(code).not.toMatch(/npm (ci|install)|npx /);
  });

  it("compares with watch.mjs, then opens ONE issue, updates the open one, or closes it when the registry matches again", () => {
    expect(code).toContain("node scripts/issuer-assets/watch.mjs --report");
    expect(code).toMatch(/gh issue list --state open/);
    expect(code).toMatch(/gh issue edit "\$OPEN" --body-file/);
    expect(code).toMatch(/gh issue create --title "\$TITLE" --body-file/);
    expect(code).toMatch(/gh issue close "\$OPEN"/);
  });
});
