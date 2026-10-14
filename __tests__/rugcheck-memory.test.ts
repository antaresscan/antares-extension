// __tests__/rugcheck-memory.test.ts
//
// RugCheck's last good answer for a token, read only when RugCheck does not answer (api/_lib/rugcheck-memory.ts). It must never show something wrong: only a complete valid
// answer is kept, it is used only while it is young enough for the token's age, an error body or a "not found" is never kept or read, and Redis missing or failing changes nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

// A fake Redis: get / set on a Map, with the options of the last set.
const store = new Map<string, unknown>();
const setCalls: Array<{ key: string; value: unknown; opts: unknown }> = [];
let redis: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } | null;
vi.mock("../api/_lib/cache", () => ({ getCacheRedis: () => redis }));

import {
  rememberRugCheck, recallRugCheck, reconcileRugCheck, rugcheckMemoryKey, rugcheckMemoryMaxAgeSec, RUGCHECK_MEMORY_TTL_S, RUGCHECK_MEMORY_MAX_AGE_S,
} from "../api/_lib/rugcheck-memory";
import type { RugCheckReport, RugCheckSummary } from "../api/_lib/types";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const T = 1_800_000_000_000;
const H = 3600_000;
const ESTABLISHED = 90 * 1440; // minutes
const YOUNG = 600;

const summary = (over: Record<string, unknown> = {}): RugCheckSummary =>
  ({ lpBurned: true, lpLocked: false, metaMutable: false, topHolders: { top10Percentage: 25, top1Percentage: 5 }, risks: [], ...over }) as unknown as RugCheckSummary;
const report = (over: Record<string, unknown> = {}): RugCheckReport =>
  ({ risks: [], topHolders: { top10Percentage: 25, top1Percentage: 5 }, totalHolders: 5000, ...over }) as unknown as RugCheckReport;

beforeEach(() => {
  store.clear();
  setCalls.length = 0;
  redis = {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: unknown, opts: unknown) => { setCalls.push({ key: k, value: v, opts }); store.set(k, v); return "OK"; }),
  };
  delete process.env.VERCEL_ENV;
});
afterEach(() => { delete process.env.VERCEL_ENV; });

describe("how long a memory may be used, by the age of the token", () => {
  it("6 hours for a token of a day or more, 20 minutes for a younger one or one of unknown age", () => {
    expect(RUGCHECK_MEMORY_MAX_AGE_S).toEqual({ established: 6 * 3600, young: 20 * 60 });
    expect(rugcheckMemoryMaxAgeSec(ESTABLISHED)).toBe(6 * 3600);
    expect(rugcheckMemoryMaxAgeSec(1440)).toBe(6 * 3600);
    expect(rugcheckMemoryMaxAgeSec(1439)).toBe(20 * 60);
    expect(rugcheckMemoryMaxAgeSec(5)).toBe(20 * 60);
    expect(rugcheckMemoryMaxAgeSec(null)).toBe(20 * 60);
    expect(rugcheckMemoryMaxAgeSec(NaN)).toBe(20 * 60);
    expect(rugcheckMemoryMaxAgeSec(-3)).toBe(20 * 60);
  });
  it("it is kept 6 hours", () => {
    expect(RUGCHECK_MEMORY_TTL_S).toBe(6 * 3600);
  });
});

describe("the key", () => {
  it("is the mint under its own prefix, and a preview deployment keeps its own entries", () => {
    expect(rugcheckMemoryKey(MINT)).toBe(`antares:rugcheck:${MINT}`);
    process.env.VERCEL_ENV = "preview";
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_abc123";
    expect(rugcheckMemoryKey(MINT)).toMatch(/^antares:rugcheck:pv:.+/);
    expect(rugcheckMemoryKey(MINT)).not.toBe(`antares:rugcheck:${MINT}`);
    delete process.env.VERCEL_DEPLOYMENT_ID;
  });
});

describe("rememberRugCheck: only a complete valid answer is kept", () => {
  it("keeps the summary and the report with the moment and a 6 hour life", async () => {
    await rememberRugCheck(MINT, summary(), report(), T);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].key).toBe(rugcheckMemoryKey(MINT));
    expect(setCalls[0].opts).toEqual({ ex: RUGCHECK_MEMORY_TTL_S });
    expect(setCalls[0].value).toMatchObject({ at: T, summary: { lpBurned: true }, report: { totalHolders: 5000 } });
  });

  it.each([
    ["no summary", null, report()],
    ["no report", summary(), null],
    ["neither", null, null],
    ["a summary that is an error body", summary({ error: "unable to generate report" }), report()],
    ["a summary that says not found", summary({ error: "not found" }), report()],
    ["a summary of the wrong shape", { hello: "world" } as unknown as RugCheckSummary, report()],
    ["a report of the wrong shape", summary(), { hello: "world" } as unknown as RugCheckReport],
  ])("%s: nothing is kept", async (_name, s, r) => {
    await rememberRugCheck(MINT, s, r, T);
    expect(setCalls).toHaveLength(0);
  });

  it("without Redis, or with a Redis that fails: nothing happens and it never throws", async () => {
    redis = null;
    await expect(rememberRugCheck(MINT, summary(), report(), T)).resolves.toBeUndefined();
    redis = { get: vi.fn(), set: vi.fn(async () => { throw new Error("redis down"); }) };
    await expect(rememberRugCheck(MINT, summary(), report(), T)).resolves.toBeUndefined();
  });
});

describe("recallRugCheck: young enough, valid, and the token's own", () => {
  it("nothing kept: null; Redis missing: null", async () => {
    expect(await recallRugCheck(MINT, ESTABLISHED, T)).toBeNull();
    redis = null;
    expect(await recallRugCheck(MINT, ESTABLISHED, T)).toBeNull();
  });

  it("an established token gets a memory up to 6 hours old, not older", async () => {
    await rememberRugCheck(MINT, summary(), report(), T);
    expect(await recallRugCheck(MINT, ESTABLISHED, T + 6 * H - 1)).toMatchObject({ summary: { lpBurned: true } });
    expect(await recallRugCheck(MINT, ESTABLISHED, T + 6 * H + 1000)).toBeNull();
  });

  it("a young token, or one of unknown age, gets a memory up to 20 minutes old, not older (an LP can be pulled minutes after a launch)", async () => {
    await rememberRugCheck(MINT, summary(), report(), T);
    for (const age of [YOUNG, null]) {
      expect(await recallRugCheck(MINT, age, T + 20 * 60_000 - 1)).not.toBeNull();
      expect(await recallRugCheck(MINT, age, T + 20 * 60_000 + 1000)).toBeNull();
    }
  });

  it("a moment in the future (a clock that jumped) or not a number: not read", async () => {
    store.set(rugcheckMemoryKey(MINT), { at: T + H, summary: summary(), report: report() });
    expect(await recallRugCheck(MINT, ESTABLISHED, T)).toBeNull();
    store.set(rugcheckMemoryKey(MINT), { at: "yesterday", summary: summary(), report: report() });
    expect(await recallRugCheck(MINT, ESTABLISHED, T)).toBeNull();
  });

  it("a value that is not what we wrote (the wrong shape, an error body) is never read", async () => {
    for (const bad of [
      "garbage", 42, [], { at: T },
      { at: T, summary: { hello: 1 }, report: report() },
      { at: T, summary: summary(), report: { hello: 1 } },
      { at: T, summary: summary({ error: "unable to generate report" }), report: report() },
    ]) {
      store.set(rugcheckMemoryKey(MINT), bad);
      expect(await recallRugCheck(MINT, ESTABLISHED, T + 1000)).toBeNull();
    }
  });

  it("a Redis that fails: null, never throws", async () => {
    redis = { get: vi.fn(async () => { throw new Error("redis down"); }), set: vi.fn() };
    await expect(recallRugCheck(MINT, ESTABLISHED, T)).resolves.toBeNull();
  });

  it("another token's memory is not this token's", async () => {
    await rememberRugCheck("OtherMint11111111111111111111111111111111111", summary({ lpBurned: false }), report(), T);
    expect(await recallRugCheck(MINT, ESTABLISHED, T + 1000)).toBeNull();
  });
});

describe("reconcileRugCheck: a scan always asks RugCheck first, the memory only fills what did not come back", () => {
  it("both parts came back: returned as they are, kept for the next time, nothing is read", async () => {
    const live = { summary: summary(), report: report() };
    const out = await reconcileRugCheck(MINT, live, ESTABLISHED, T);
    expect(out).toEqual({ ...live, fromMemory: false });
    expect(redis!.get).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(setCalls).toHaveLength(1);
  });

  it("the write is not waited for (a slow Redis does not slow the scan)", async () => {
    redis = { get: vi.fn(), set: vi.fn(() => new Promise(() => {})) }; // never answers
    const out = await Promise.race([
      reconcileRugCheck(MINT, { summary: summary(), report: report() }, ESTABLISHED, T),
      new Promise<string>((r) => setTimeout(() => r("waited"), 200)),
    ]);
    expect(out).not.toBe("waited");
  });

  it("nothing came back and a memory exists: both parts from the memory, and it says so", async () => {
    await rememberRugCheck(MINT, summary({ lpBurned: true }), report({ totalHolders: 777 }), T);
    const out = await reconcileRugCheck(MINT, { summary: null, report: null }, ESTABLISHED, T + 2 * H);
    expect(out.fromMemory).toBe(true);
    expect(out.summary).toMatchObject({ lpBurned: true });
    expect(out.report).toMatchObject({ totalHolders: 777 });
  });

  it("only the summary came back: the report is read from the memory; the live summary stays the live one", async () => {
    await rememberRugCheck(MINT, summary({ lpBurned: false }), report({ totalHolders: 777 }), T);
    const out = await reconcileRugCheck(MINT, { summary: summary({ lpBurned: true }), report: null }, ESTABLISHED, T + H);
    expect(out.fromMemory).toBe(true);
    expect(out.summary).toMatchObject({ lpBurned: true }); // today's, not the memory's
    expect(out.report).toMatchObject({ totalHolders: 777 });
  });

  it("only the report came back: the summary is read from the memory", async () => {
    await rememberRugCheck(MINT, summary({ lpBurned: true }), report(), T);
    const out = await reconcileRugCheck(MINT, { summary: null, report: report({ totalHolders: 9 }) }, ESTABLISHED, T + H);
    expect(out.fromMemory).toBe(true);
    expect(out.summary).toMatchObject({ lpBurned: true });
    expect(out.report).toMatchObject({ totalHolders: 9 });
  });

  it("nothing came back and nothing is kept: nothing, as before", async () => {
    const out = await reconcileRugCheck(MINT, { summary: null, report: null }, ESTABLISHED, T);
    expect(out).toEqual({ summary: null, report: null, fromMemory: false });
  });

  it("the memory is too old for the token's age: not used", async () => {
    await rememberRugCheck(MINT, summary(), report(), T);
    expect((await reconcileRugCheck(MINT, { summary: null, report: null }, ESTABLISHED, T + 7 * H)).fromMemory).toBe(false);
    expect((await reconcileRugCheck(MINT, { summary: null, report: null }, YOUNG, T + 30 * 60_000)).fromMemory).toBe(false);
  });

  it("RugCheck answered \"not found\" (it does not know the token): that is an answer, the memory is not read", async () => {
    await rememberRugCheck(MINT, summary(), report(), T);
    redis!.get.mockClear();
    const out = await reconcileRugCheck(MINT, { summary: summary({ error: "not found" }), report: null }, ESTABLISHED, T + H);
    expect(out.fromMemory).toBe(false);
    expect(out.summary).toMatchObject({ error: "not found" });
    expect(redis!.get).not.toHaveBeenCalled();
  });

  it("a Redis that fails or is missing: the scan gets exactly what RugCheck gave", async () => {
    redis = null;
    expect(await reconcileRugCheck(MINT, { summary: summary(), report: null }, ESTABLISHED, T)).toEqual({ summary: summary(), report: null, fromMemory: false });
    redis = { get: vi.fn(async () => { throw new Error("redis down"); }), set: vi.fn() };
    expect(await reconcileRugCheck(MINT, { summary: null, report: null }, ESTABLISHED, T)).toEqual({ summary: null, report: null, fromMemory: false });
  });
});
