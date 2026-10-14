// __tests__/outage.test.ts
//
// When is a source DOWN (api/_lib/outage.ts)? "Limited data" is a last resort, for an outage: a source that did not ANSWER, several times within the last minute.
// A source that answered with nothing for this token (a 200 with no data, a 404, an error body) is not down: Helius cannot list the holders of BONK or JUP, RugCheck
// does not know a brand-new token. This pins the ledger itself and what feeds it (the HTTP layer), call by call.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../api/_lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), metric: vi.fn() } }));

import {
  noteSourceFailure, isSourceDown, downSources, _resetOutageForTests, OUTAGE_SOURCES, OUTAGE_THRESHOLD, OUTAGE_WINDOW_MS,
} from "../api/_lib/outage";
import { fetchJson, fetchJsonPost, _resetCircuitBreakersForTests } from "../api/_lib/http";

const HELIUS = "mainnet.helius-rpc.com";
const T = 1_800_000_000_000;

beforeEach(() => {
  _resetCircuitBreakersForTests(); // resets the ledger too
});

describe("the ledger", () => {
  it("the three sources and their thresholds: Helius 3 (a scan makes 3 to 10 calls), RugCheck 2, GoPlus 2, within a minute", () => {
    expect([...OUTAGE_SOURCES].sort()).toEqual(["goplus", "helius", "rugcheck"]);
    expect(OUTAGE_THRESHOLD).toEqual({ helius: 3, rugcheck: 2, goplus: 2 });
    expect(OUTAGE_WINDOW_MS).toBe(60_000);
  });

  it("nothing failed: nothing is down", () => {
    expect(downSources(T)).toEqual({ helius: false, rugcheck: false, goplus: false });
  });

  it.each([
    ["helius", "mainnet.helius-rpc.com", 3],
    ["helius", "api.helius.xyz", 3], // the REST host is the same source
    ["rugcheck", "api.rugcheck.xyz", 2],
    ["goplus", "api.gopluslabs.io", 2],
  ] as const)("%s (%s): down at exactly %i failed calls within the minute, not before", (source, host, k) => {
    for (let i = 0; i < k - 1; i++) noteSourceFailure(host, T + i * 1000);
    expect(isSourceDown(source, T + 10_000)).toBe(false);
    noteSourceFailure(host, T + 10_000);
    expect(isSourceDown(source, T + 10_000)).toBe(true);
  });

  it("a failure counts for a minute, not longer: the outage ends by itself", () => {
    for (let i = 0; i < 3; i++) noteSourceFailure(HELIUS, T);
    expect(isSourceDown("helius", T + 59_999)).toBe(true);
    expect(isSourceDown("helius", T + 60_001)).toBe(false);
  });

  it("failures spread over more than a minute never add up (a blip an hour is not an outage)", () => {
    noteSourceFailure(HELIUS, T);
    noteSourceFailure(HELIUS, T + 40_000);
    noteSourceFailure(HELIUS, T + 80_000);
    expect(isSourceDown("helius", T + 80_000)).toBe(false);
  });

  it("the sources are kept apart: Helius failing does not make RugCheck or GoPlus down", () => {
    for (let i = 0; i < 5; i++) noteSourceFailure(HELIUS, T);
    expect(downSources(T)).toEqual({ helius: true, rugcheck: false, goplus: false });
  });

  it("a host that is none of the three (DexScreener, GeckoTerminal, Solscan, the public RPCs, an unknown one) never makes anything down", () => {
    for (const host of ["api.dexscreener.com", "api.geckoterminal.com", "pro-api.solscan.io", "api.mainnet-beta.solana.com", "example.com"]) {
      for (let i = 0; i < 20; i++) noteSourceFailure(host, T);
    }
    expect(downSources(T)).toEqual({ helius: false, rugcheck: false, goplus: false });
  });

  it("a look-alike host is not a source", () => {
    for (let i = 0; i < 10; i++) noteSourceFailure("helius-rpc.com.evil.example", T);
    expect(isSourceDown("helius", T)).toBe(false);
  });

  it("no host, or garbage, is ignored and never throws", () => {
    expect(() => noteSourceFailure(null, T)).not.toThrow();
    expect(() => noteSourceFailure("", T)).not.toThrow();
    expect(() => noteSourceFailure(undefined as unknown as string, T)).not.toThrow();
    expect(downSources(T)).toEqual({ helius: false, rugcheck: false, goplus: false });
  });

  it("a long outage keeps the list short", () => {
    for (let i = 0; i < 5000; i++) noteSourceFailure(HELIUS, T + i);
    expect(isSourceDown("helius", T + 5000)).toBe(true);
  });
});

// ─── what feeds it: only a call that did not ANSWER ─────────────────────────────────────────────────────────────────────────────────────────

describe("what counts as a failed call", () => {
  let responses: Array<{ status: number; body?: unknown } | { reject: Error }>;
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    responses = [];
    globalThis.fetch = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("stub queue empty");
      if ("reject" in next) throw next.reject;
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const heliusPost = () => fetchJsonPost(`https://${HELIUS}/`, {}, 1000, 0);
  const failures = (n: number) => { for (let i = 0; i < n; i++) responses.push({ status: 500 }); };

  it("three server errors in a row from Helius: down", async () => {
    failures(3);
    for (let i = 0; i < 3; i++) await heliusPost();
    expect(isSourceDown("helius")).toBe(true);
  });

  it("a timeout and a network error count as failures too", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    responses.push({ reject: abort }, { reject: new Error("ECONNRESET") }, { reject: abort });
    for (let i = 0; i < 3; i++) await heliusPost();
    expect(isSourceDown("helius")).toBe(true);
  });

  it("'too many requests' that survived the retries counts as a failure", async () => {
    for (let i = 0; i < 3; i++) responses.push({ status: 429 });
    for (let i = 0; i < 3; i++) await heliusPost();
    expect(isSourceDown("helius")).toBe(true);
  });

  it("the source ANSWERED with nothing for this token: HTTP 200 with an error body, a 404, a 400, a 403: never an outage, however many", async () => {
    for (let i = 0; i < 10; i++) responses.push({ status: 200, body: { error: { code: -32602, message: "no holders for this mint" } } });
    for (let i = 0; i < 4; i++) responses.push({ status: 404 }, { status: 400 }, { status: 403 });
    for (let i = 0; i < 10; i++) await heliusPost();
    for (let i = 0; i < 12; i++) await heliusPost();
    expect(isSourceDown("helius")).toBe(false);
  });

  it("an answer in between does not erase the failures of the minute (a flapping source is an outage)... but a plain success does not add to them either", async () => {
    responses.push({ status: 500 }, { status: 200, body: { ok: 1 } }, { status: 500 }, { status: 200, body: { ok: 1 } }, { status: 500 });
    for (let i = 0; i < 5; i++) await heliusPost();
    expect(isSourceDown("helius")).toBe(true); // 3 failed calls inside the minute
  });

  it("RugCheck: the summary and the report both failing is the outage; one of them failing is a blip", async () => {
    responses.push({ status: 500 });
    await fetchJson("https://api.rugcheck.xyz/v1/tokens/x/report/summary", {}, 1000, 0);
    expect(isSourceDown("rugcheck")).toBe(false);
    responses.push({ status: 500 });
    await fetchJson("https://api.rugcheck.xyz/v1/tokens/x/report", {}, 1000, 0);
    expect(isSourceDown("rugcheck")).toBe(true);
  });

  it("a call that was not sent because the circuit breaker is shut counts as a failure (the source is down, that is why it is shut)", async () => {
    failures(5);
    for (let i = 0; i < 5; i++) await fetchJson("https://api.gopluslabs.io/x", {}, 1000, 0); // five server errors shut the breaker (default 5 in 30 s)
    _resetOutageForTests(); // forget those, keep the breaker shut: only the skipped calls below can make it down now
    await fetchJson("https://api.gopluslabs.io/x", {}, 1000, 0);
    expect(isSourceDown("goplus")).toBe(false); // one skipped call
    await fetchJson("https://api.gopluslabs.io/x", {}, 1000, 0);
    expect(isSourceDown("goplus")).toBe(true); // two
  });

  it("a failed call to a host that is not one of the three does not matter", async () => {
    failures(10);
    for (let i = 0; i < 10; i++) await fetchJson("https://api.dexscreener.com/x", {}, 1000, 0);
    expect(downSources()).toEqual({ helius: false, rugcheck: false, goplus: false });
  });
});
