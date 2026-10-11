import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Holder pages read in waves (audit: Helius consumption) ──────────────────────────────────────────────────────────
// heliusGetHolderPages used to ask for pages 2..10 all at once as soon as page 1 was full. parseChainHolders reads the pages IN ORDER
// and stops at the first short or unreadable one, so every page after that one was paid for (10 Helius credits each) and never read:
// 784 of the 3,299 DAS calls of 365 real scans. The pages are now asked in waves, and not at all when another source already knows the
// token is far beyond what the pages can count.

const mockHeliusRpc = vi.fn();
vi.mock("../api/_lib/helius", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/_lib/helius")>()),
  heliusRpc: (...args: unknown[]) => mockHeliusRpc(...args),
}));

const { heliusGetHolderPages, holderPageWaves } = await import("../api/_lib/fetchers");
const { parseChainHolders } = await import("../api/_lib/facts");
const { HOLDER_PAGE_LIMIT, HOLDER_MAX_PAGES, HOLDER_COUNT_KNOWN_ABOVE, HOLDER_COUNT_WAIT_MS } = await import("../api/_lib/constants");

/** One answer of getTokenAccounts holding `n` accounts, all with a balance; owners are unique per page. */
const pageOf = (page: number, n: number) => ({
  jsonrpc: "2.0",
  result: { total: n, limit: HOLDER_PAGE_LIMIT, token_accounts: Array.from({ length: n }, (_, i) => ({ owner: `p${page}-o${i}`, amount: 1 })) },
});

/**
 * Serves a token whose page lengths are given: `lengths[i]` is the number of accounts of page i+1, or null when that page fails
 * (the request answers nothing). Pages beyond the list are empty. Records which pages were asked.
 */
function serve(lengths: Array<number | null>) {
  const asked: number[] = [];
  mockHeliusRpc.mockImplementation(async (_key: string, body: { params: { page: number } }) => {
    const page = body.params.page;
    asked.push(page);
    const n = lengths[page - 1];
    if (n === null) return null;
    return pageOf(page, n ?? 0);
  });
  return asked;
}

const FULL = HOLDER_PAGE_LIMIT;
/** `full` full pages, then `end` (a short page, an empty page, or a failure). */
const token = (full: number, end: number | null, after: Array<number | null> = []): Array<number | null> => [...Array.from({ length: full }, () => FULL), end, ...after];

/** The behaviour before this change, for comparison: page 1, then (page 1 full) 2..N all at once. */
async function oldHolderPages(lengths: Array<number | null>): Promise<{ pages: unknown[] | null; asked: number }> {
  const asked: number[] = [];
  const fetchPage = async (page: number) => { asked.push(page); const n = lengths[page - 1]; return n === null ? null : pageOf(page, n ?? 0); };
  const first = await fetchPage(1);
  if (!first) return { pages: null, asked: asked.length };
  const fc = parseChainHolders(first);
  if (!fc || fc.complete) return { pages: [first], asked: asked.length };
  const rest = await Promise.all(Array.from({ length: HOLDER_MAX_PAGES - 1 }, (_, i) => fetchPage(i + 2)));
  return { pages: [first, ...rest], asked: asked.length };
}

beforeEach(() => { mockHeliusRpc.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe("holderPageWaves", () => {
  it("cuts pages 2..10 in growing waves", () => {
    expect(holderPageWaves(10)).toEqual([[2, 3], [4, 5, 6], [7, 8, 9, 10]]);
  });
  it("covers every page after the first, once, in order, whatever the cap", () => {
    for (const max of [1, 2, 3, 4, 10, 25, 60]) {
      expect(holderPageWaves(max).flat()).toEqual(Array.from({ length: Math.max(0, max - 1) }, (_, i) => i + 2));
    }
  });
});

describe("the count is exactly what the old way gave, with fewer pages asked", () => {
  // Every place the list can end, with every kind of end, and junk after it.
  const cases: Array<[string, Array<number | null>]> = [];
  for (let full = 0; full <= HOLDER_MAX_PAGES; full++) {
    cases.push([`${full} full pages then a short one`, token(full, 541, [FULL, FULL])]);
    cases.push([`${full} full pages then an empty one`, token(full, 0, [FULL, 541])]);
    cases.push([`${full} full pages then a FAILED one`, token(full, null, [FULL, FULL, 7])]);
  }
  cases.push(["a failure in the middle of full pages", [FULL, FULL, null, FULL, FULL, FULL, FULL, FULL, FULL, FULL]]);

  it.each(cases)("%s", async (_name, lengths) => {
    const before = await oldHolderPages(lengths);
    const asked = serve(lengths);

    const pages = await heliusGetHolderPages("mint", "key");

    expect(pages === null).toBe(before.pages === null);
    if (pages && before.pages) expect(parseChainHolders(pages)).toEqual(parseChainHolders(before.pages));
    expect(asked.length).toBeLessThanOrEqual(before.asked);
    expect(new Set(asked).size).toBe(asked.length); // no page asked twice
  });
});

describe("how many requests a token costs", () => {
  it("under 1,000 holders: ONE request", async () => {
    const asked = serve([541]);
    await heliusGetHolderPages("mint", "key");
    expect(asked).toEqual([1]);
  });

  it("1,500 holders: page 1, then the first wave (2 and 3), which holds the end of the list: 3 requests, not 10", async () => {
    const asked = serve(token(1, 500));
    const pages = await heliusGetHolderPages("mint", "key");
    expect(asked.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(parseChainHolders(pages)).toMatchObject({ count: 1500, complete: true });
  });

  it("3,200 holders: the second wave is needed: 6 requests, not 10", async () => {
    const asked = serve(token(3, 200));
    await heliusGetHolderPages("mint", "key");
    expect(asked.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("9,500 holders: every page is needed: 10 requests, as before", async () => {
    const asked = serve(token(9, 500));
    const pages = await heliusGetHolderPages("mint", "key");
    expect(asked).toHaveLength(10);
    expect(parseChainHolders(pages)).toMatchObject({ count: 9500, complete: true });
  });

  it("a wave only starts when the previous one did not reach the end of the list", async () => {
    const asked = serve(token(1, 500));
    await heliusGetHolderPages("mint", "key");
    expect(asked.some((p) => p >= 4)).toBe(false);
  });

  it("page 1 failing is a failure, nothing else is asked", async () => {
    const asked = serve([null]);
    expect(await heliusGetHolderPages("mint", "key")).toBeNull();
    expect(asked).toEqual([1]);
  });

  it("a failed page stops the waves: the pages after it are ignored by the count, so they are not asked", async () => {
    const asked = serve([FULL, null, FULL, FULL, FULL, FULL, FULL, FULL, FULL, FULL]);
    const pages = await heliusGetHolderPages("mint", "key");
    expect(asked.sort((a, b) => a - b)).toEqual([1, 2, 3]); // page 1, then the wave that holds the failure
    expect(parseChainHolders(pages)).toMatchObject({ count: FULL, complete: false }); // a floor, as before
  });
});

describe("another source already counts far more holders than the pages can", () => {
  const allFull = Array.from({ length: HOLDER_MAX_PAGES }, () => FULL);

  it("asks ONE page when it counts at least twice the cap", async () => {
    const asked = serve(allFull);
    const pages = await heliusGetHolderPages("mint", "key", Promise.resolve(HOLDER_COUNT_KNOWN_ABOVE));
    expect(asked).toEqual([1]);
    expect(pages).toHaveLength(1);
  });

  it("the threshold is twice the cap: GoPlus overcounts by up to 1.8x on recorded tokens, so just above the cap is not enough", async () => {
    expect(HOLDER_COUNT_KNOWN_ABOVE).toBe(2 * HOLDER_PAGE_LIMIT * HOLDER_MAX_PAGES);
    const asked = serve(token(9, 818)); // a token of 9,818 holders that GoPlus counts at 11,186 (BURNIE)
    const pages = await heliusGetHolderPages("mint", "key", Promise.resolve(11_186));
    expect(asked).toHaveLength(10);
    expect(parseChainHolders(pages)).toMatchObject({ count: 9818, complete: true });
  });

  it("just under the threshold, the pages are read", async () => {
    const asked = serve(allFull);
    await heliusGetHolderPages("mint", "key", Promise.resolve(HOLDER_COUNT_KNOWN_ABOVE - 1));
    expect(asked).toHaveLength(10);
  });

  it("a source that has no count (null), or that fails, changes nothing", async () => {
    const a = serve(allFull);
    await heliusGetHolderPages("mint", "key", Promise.resolve(null));
    expect(a).toHaveLength(10);
    mockHeliusRpc.mockReset();
    const b = serve(allFull);
    await heliusGetHolderPages("mint", "key", Promise.reject(new Error("goplus down")));
    expect(b).toHaveLength(10);
  });

  it("a source that is too slow is waited for HOLDER_COUNT_WAIT_MS at most, then the pages are read", async () => {
    vi.useFakeTimers();
    const asked = serve(allFull);
    let settled = false;
    const p = heliusGetHolderPages("mint", "key", new Promise<number>(() => {})).then((r) => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(HOLDER_COUNT_WAIT_MS - 1);
    expect(settled).toBe(false);
    expect(asked).toEqual([1]); // still waiting for the other source
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(asked).toHaveLength(10);
  });

  it("it is not waited for when page 1 already holds the whole list (a small token)", async () => {
    vi.useFakeTimers();
    serve([541]);
    const pages = await heliusGetHolderPages("mint", "key", new Promise<number>(() => {}));
    expect(pages).toHaveLength(1);
  });
});
