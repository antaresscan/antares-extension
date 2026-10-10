// __tests__/holders.test.ts
//
// Holder count from the chain (Helius DAS getTokenAccounts) and the order of the sources. Run on REAL pages captured on
// 2026-10-10 with the paid Helius key (see __tests__/fixtures/upstream-real/helius-token-accounts-*.json).
// What the live measurements showed, and these tests pin:
//  - a page that is not full holds EVERY holder: BREAK 53 and PAPER 37 holders, while RugCheck said 173 and 427 (it also
//    counts the accounts that were emptied). GoPlus has no holder_count yet for such new tokens;
//  - the cursor comes back on a page that is not full too (53 accounts, limit 1000, cursor present), and `total` is the
//    page size: neither can tell "complete" from "truncated". The page SIZE does.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseChainHolders, pickHolderCount, type ChainHolders } from "../api/_lib/facts";
import { HOLDER_PAGE_LIMIT, HOLDER_MAX_PAGES } from "../api/_lib/constants";

const fx = (name: string): { result: { total: number; limit: number; cursor?: string; token_accounts: unknown[] } } =>
  JSON.parse(readFileSync(new URL(`./fixtures/upstream-real/${name}`, import.meta.url), "utf8"));
const page = (accounts: Array<{ owner?: string; amount?: number | string }>) => ({ jsonrpc: "2.0", id: "x", result: { total: accounts.length, limit: 1000, cursor: "c", token_accounts: accounts } });
const accounts = (n: number) => Array.from({ length: n }, (_, i) => ({ owner: `owner${i}`, amount: i + 1 }));

describe("parseChainHolders on real Helius pages", () => {
  it("a small token: 53 holders in a page that is not full -> exact, although the cursor is present", () => {
    const raw = fx("helius-token-accounts-small.json");
    expect(typeof raw.result.cursor).toBe("string");   // the real page carries a cursor...
    expect(raw.result.limit).toBe(1000);
    expect(parseChainHolders(raw)).toEqual({ count: 53, complete: true }); // ...and is still complete
  });

  it("the real answer for a big token has the same shape (cursor, total = page size) and is accepted", () => {
    const raw = fx("helius-token-accounts-bigtoken-sample.json"); // trimmed to 2 accounts: only the shape matters here
    expect(raw.result.total).toBe(1000);
    expect(parseChainHolders(raw)).not.toBeNull();
  });

  it("a mint Helius knows nothing about: a complete page of 0 (not a count to show)", () => {
    expect(parseChainHolders(fx("helius-token-accounts-unknown-mint.json"))).toEqual({ count: 0, complete: true });
  });
});

describe("parseChainHolders: completeness is the page SIZE", () => {
  it(`${HOLDER_PAGE_LIMIT - 1} accounts: complete; ${HOLDER_PAGE_LIMIT}: only a floor`, () => {
    expect(parseChainHolders(page(accounts(HOLDER_PAGE_LIMIT - 1)))).toEqual({ count: HOLDER_PAGE_LIMIT - 1, complete: true });
    expect(parseChainHolders(page(accounts(HOLDER_PAGE_LIMIT)))).toEqual({ count: HOLDER_PAGE_LIMIT, complete: false });
  });

  it("does not trust the cursor or `total`: a full page without a cursor is still not complete", () => {
    const full = page(accounts(HOLDER_PAGE_LIMIT));
    delete (full.result as { cursor?: string }).cursor;
    full.result.total = 5; // a lying total changes nothing
    expect(parseChainHolders(full)).toEqual({ count: HOLDER_PAGE_LIMIT, complete: false });
  });
});

describe("parseChainHolders: what counts as a holder", () => {
  it("leaves out empty accounts (number or string 0) and counts a numeric string balance", () => {
    expect(parseChainHolders(page([{ owner: "a", amount: 0 }, { owner: "b", amount: "0" }, { owner: "c", amount: "5" }, { owner: "d", amount: 7 }])))
      .toEqual({ count: 2, complete: true });
  });

  it("a wallet with several token accounts counts once", () => {
    expect(parseChainHolders(page([{ owner: "a", amount: 1 }, { owner: "a", amount: 2 }, { owner: "b", amount: 3 }]))).toEqual({ count: 2, complete: true });
  });

  it("an account without an owner is counted on its own, never merged with another", () => {
    expect(parseChainHolders(page([{ amount: 1 }, { amount: 2 }, { owner: "a", amount: 3 }]))).toEqual({ count: 3, complete: true });
  });
});

describe("parseChainHolders: anything else is 'not verified' (null)", () => {
  it.each([
    ["null", null], ["undefined", undefined], ["empty object", {}], ["no accounts list", { result: {} }],
    ["accounts not an array", { result: { token_accounts: "nope" } }], ["a JSON-RPC error", { jsonrpc: "2.0", error: { code: -32000, message: "x" }, id: "x" }],
    ["an account that is not an object", { result: { token_accounts: [1] } }],
  ])("%s", (_name, raw) => {
    expect(parseChainHolders(raw)).toBeNull();
  });
});

describe("parseChainHolders over several pages (page 1, then 2..N read in parallel)", () => {
  const distinct = (k: number, n: number) => page(Array.from({ length: n }, (_, i) => ({ owner: `p${k}-${i}`, amount: 1 })));

  it("two full pages and a short one: exact, the sum of the three", () => {
    expect(parseChainHolders([distinct(0, 1000), distinct(1, 1000), distinct(2, 347)])).toEqual({ count: 2347, complete: true });
  });

  it("a full page followed by an EMPTY page (exactly 1000 holders): exact", () => {
    expect(parseChainHolders([distinct(0, 1000), distinct(1, 0)])).toEqual({ count: 1000, complete: true });
  });

  it("the pages after the end of the list are not read (parallel requests answer empty or short)", () => {
    expect(parseChainHolders([distinct(0, 1000), distinct(1, 5), distinct(2, 0), null, undefined])).toEqual({ count: 1005, complete: true });
  });

  it(`every one of ${HOLDER_MAX_PAGES} pages full: a floor of ${HOLDER_MAX_PAGES * 1000}, not exact`, () => {
    const pages = Array.from({ length: HOLDER_MAX_PAGES }, (_, k) => distinct(k, 1000));
    expect(parseChainHolders(pages)).toEqual({ count: HOLDER_MAX_PAGES * 1000, complete: false });
  });

  it("a page that failed before the end is reached: only a floor (what the earlier pages hold), never 'exact'", () => {
    expect(parseChainHolders([distinct(0, 1000), distinct(1, 1000), null, distinct(3, 50)])).toEqual({ count: 2000, complete: false });
    expect(parseChainHolders([distinct(0, 1000), { error: { message: "429" } }])).toEqual({ count: 1000, complete: false });
  });

  it("a wallet present on two pages counts once", () => {
    const a = page([...accounts(1000)]);
    const b = page([{ owner: "owner0", amount: 4 }, { owner: "fresh", amount: 4 }]);
    expect(parseChainHolders([a, b])).toEqual({ count: 1001, complete: true });
  });

  it("the first page missing or malformed: null", () => {
    expect(parseChainHolders([null, distinct(1, 10)])).toBeNull();
    expect(parseChainHolders([])).toBeNull();
  });
});

describe("pickHolderCount: order of the sources", () => {
  const exact: ChainHolders = { count: 53, complete: true };
  const floor: ChainHolders = { count: 1000, complete: false };

  it("1. an exact chain count wins over GoPlus and RugCheck (BREAK: 53 vs RugCheck 173)", () => {
    expect(pickHolderCount({ chain: exact, goplus: "70", rugcheck: 173 })).toBe(53);
  });
  it("2. a floor only: GoPlus (matches an independent explorer within 0.01 %)", () => {
    expect(pickHolderCount({ chain: floor, goplus: "1024740", rugcheck: 2088973 })).toBe(1024740);
    expect(pickHolderCount({ chain: floor, goplus: 1024740, rugcheck: null })).toBe(1024740);
  });
  it("3. then RugCheck: an upper bound, but the right order of magnitude when GoPlus is silent", () => {
    expect(pickHolderCount({ chain: floor, goplus: undefined, rugcheck: 2088973 })).toBe(2088973);
    expect(pickHolderCount({ chain: null, goplus: undefined, rugcheck: 478 })).toBe(478);
  });
  it("4. then the full-page floor", () => {
    expect(pickHolderCount({ chain: floor, goplus: undefined, rugcheck: null })).toBe(1000);
  });
  it("a GoPlus or RugCheck figure BELOW the floor is impossible (those holders were counted on the chain): the floor wins", () => {
    expect(pickHolderCount({ chain: { count: 10000, complete: false }, goplus: "6000", rugcheck: null })).toBe(10000);
    expect(pickHolderCount({ chain: { count: 10000, complete: false }, goplus: undefined, rugcheck: 7000 })).toBe(10000);
    expect(pickHolderCount({ chain: { count: 10000, complete: false }, goplus: "25000", rugcheck: 7000 })).toBe(25000);
  });
  it("an exact count is never raised by a larger GoPlus / RugCheck figure", () => {
    expect(pickHolderCount({ chain: { count: 3281, complete: true }, goplus: "6500", rugcheck: 10807 })).toBe(3281);
  });
  it("an empty complete page is not a count of 0: the other sources decide", () => {
    expect(pickHolderCount({ chain: { count: 0, complete: true }, goplus: "12", rugcheck: 90 })).toBe(12);
    expect(pickHolderCount({ chain: { count: 0, complete: true }, goplus: undefined, rugcheck: null })).toBeNull();
  });
  it("0, junk and negative counts from GoPlus / RugCheck are 'no answer'", () => {
    expect(pickHolderCount({ chain: null, goplus: "0", rugcheck: 0 })).toBeNull();
    expect(pickHolderCount({ chain: null, goplus: "abc", rugcheck: -4 })).toBeNull();
    expect(pickHolderCount({ chain: null, goplus: "0", rugcheck: 478 })).toBe(478);
  });
  it("nothing readable: null (never a guess)", () => {
    expect(pickHolderCount({ chain: null, goplus: undefined, rugcheck: null })).toBeNull();
  });
});
