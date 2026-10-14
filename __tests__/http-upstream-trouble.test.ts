// __tests__/http-upstream-trouble.test.ts
//
// Two things added to api/_lib/http.ts after the scans of 2026-10-13, where 6 scans in 40 s had no Helius answer and the logs could not say why:
//   1. Helius gets its own, tolerant circuit breaker. With the default one (5 failures in 30 s, shut for 30 s) a few slow answers in a burst of scans
//      shut Helius out of EVERY scan of the instance for 30 s, and a scan without Helius has no verdict (the overlay shows "Limited data").
//   2. Every refusal, timeout and shut breaker leaves ONE log line per host and kind every 10 s ("upstream trouble"), with how many there were.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const warn = vi.fn();
vi.mock("../api/_lib/logger", () => ({
  logger: { info: vi.fn(), warn: (...args: unknown[]) => warn(...args), error: vi.fn() },
}));

let responses: Array<{ status: number; body?: unknown } | { reject: Error }> = [];
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
afterEach(() => {
  globalThis.fetch = originalFetch;
});

import {
  fetchJson,
  fetchJsonPost,
  isCircuitOpen,
  noteTrouble,
  _resetCircuitBreakersForTests,
  _resetTroubleLogForTests,
} from "../api/_lib/http";

const HELIUS_RPC = "mainnet.helius-rpc.com";
const HELIUS_REST = "api.helius.xyz";

beforeEach(() => {
  warn.mockReset();
  _resetCircuitBreakersForTests();
  _resetTroubleLogForTests();
});

/** The "upstream trouble" lines the logger received, as their metadata. */
const troubleLines = () =>
  warn.mock.calls.filter((c) => c[1] === "upstream trouble").map((c) => c[2] as { host: string; kind: string; count: number; sinceLastLogMs: number | null });

describe("Helius breaker: tolerant, and short", () => {
  for (const host of [HELIUS_RPC, HELIUS_REST]) {
    it(`${host}: 11 failures in a row do not shut it out, the 12th does`, async () => {
      for (let i = 0; i < 12; i++) responses.push({ status: 500 });
      for (let i = 0; i < 11; i++) await fetchJsonPost(`https://${host}/`, {}, 1000, 0);
      expect(isCircuitOpen(host)).toBe(false);
      await fetchJsonPost(`https://${host}/`, {}, 1000, 0);
      expect(isCircuitOpen(host)).toBe(true);
    });

    it(`${host}: once open it stays shut about 6 s, not 30 s`, async () => {
      for (let i = 0; i < 12; i++) responses.push({ status: 500 });
      for (let i = 0; i < 12; i++) await fetchJsonPost(`https://${host}/`, {}, 1000, 0);
      const t = Date.now();
      expect(isCircuitOpen(host, t + 5_000)).toBe(true);
      expect(isCircuitOpen(host, t + 7_000)).toBe(false);
    });
  }

  it("a success still resets the count", async () => {
    responses.push(...Array.from({ length: 11 }, () => ({ status: 500 })), { status: 200, body: { ok: 1 } }, ...Array.from({ length: 11 }, () => ({ status: 500 })));
    for (let i = 0; i < 11; i++) await fetchJsonPost(`https://${HELIUS_RPC}/`, {}, 1000, 0);
    await fetchJsonPost(`https://${HELIUS_RPC}/`, {}, 1000, 0); // success
    for (let i = 0; i < 11; i++) await fetchJsonPost(`https://${HELIUS_RPC}/`, {}, 1000, 0);
    expect(isCircuitOpen(HELIUS_RPC)).toBe(false);
  });

  it("every OTHER host keeps the default breaker: 5 failures shut it for 30 s", async () => {
    for (let i = 0; i < 5; i++) responses.push({ status: 500 });
    for (let i = 0; i < 5; i++) await fetchJson("https://api.rugcheck.xyz/x", {}, 1000, 0);
    const t = Date.now();
    expect(isCircuitOpen("api.rugcheck.xyz", t)).toBe(true);
    expect(isCircuitOpen("api.rugcheck.xyz", t + 20_000)).toBe(true);
    expect(isCircuitOpen("api.rugcheck.xyz", t + 31_000)).toBe(false);
  });

  it("opening the Helius breaker is logged with its own cooldown", async () => {
    for (let i = 0; i < 12; i++) responses.push({ status: 500 });
    for (let i = 0; i < 12; i++) await fetchJsonPost(`https://${HELIUS_RPC}/`, {}, 1000, 0);
    const opened = warn.mock.calls.find((c) => c[1] === "circuit breaker opened");
    expect(opened?.[2]).toMatchObject({ host: HELIUS_RPC, failures: 12, cooldownMs: 6000 });
  });
});

describe("noteTrouble: one line per host and kind every 10 s", () => {
  it("logs the first one at once, counts the following ones, and logs the count after 10 s", () => {
    noteTrouble("h.test", "rate-limited", 1_000);
    noteTrouble("h.test", "rate-limited", 2_000);
    noteTrouble("h.test", "rate-limited", 3_000);
    expect(troubleLines()).toEqual([{ host: "h.test", kind: "rate-limited", count: 1, sinceLastLogMs: null }]);
    noteTrouble("h.test", "rate-limited", 11_000);
    expect(troubleLines()).toHaveLength(2);
    expect(troubleLines()[1]).toEqual({ host: "h.test", kind: "rate-limited", count: 3, sinceLastLogMs: 10_000 });
  });

  it("does not log again before 10 s", () => {
    noteTrouble("h.test", "timeout", 1_000);
    noteTrouble("h.test", "timeout", 10_999);
    expect(troubleLines()).toHaveLength(1);
  });

  it("keeps each kind and each host apart", () => {
    noteTrouble("a.test", "timeout", 1_000);
    noteTrouble("a.test", "network", 1_000);
    noteTrouble("b.test", "timeout", 1_000);
    expect(troubleLines().map((l) => `${l.host}:${l.kind}`).sort()).toEqual(["a.test:network", "a.test:timeout", "b.test:timeout"]);
  });

  it("ignores a call without a host", () => {
    noteTrouble(null, "timeout", 1_000);
    expect(troubleLines()).toHaveLength(0);
  });
});

describe("what each failure is called in the logs", () => {
  const kindsAfter = async (run: () => Promise<unknown>) => {
    await run();
    return troubleLines().map((l) => l.kind);
  };

  it("a 429 that survived the retries: rate-limited", async () => {
    responses.push({ status: 429 });
    expect(await kindsAfter(() => fetchJson("https://x.test/a", {}, 1000, 0))).toEqual(["rate-limited"]);
  });

  it("a 500: server-error, once", async () => {
    responses.push({ status: 500 });
    expect(await kindsAfter(() => fetchJson("https://x.test/a", {}, 1000, 0))).toEqual(["server-error"]);
  });

  it("a 503 that survived the retries: server-error, once (not counted twice)", async () => {
    responses.push({ status: 503 });
    await fetchJson("https://x.test/a", {}, 1000, 0);
    noteTrouble("x.test", "server-error", Date.now() + 1_000); // still inside the 10 s: counted, not logged
    expect(troubleLines()).toHaveLength(1);
    expect(troubleLines()[0].count).toBe(1);
    // the 503 itself was counted once: the next line, 10 s later, would say count 2 (the 503 is already logged, then this one)
    noteTrouble("x.test", "server-error", Date.now() + 12_000);
    expect(troubleLines()[1].count).toBe(2);
  });

  it("a timeout (AbortError): timeout", async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    responses.push({ reject: e });
    expect(await kindsAfter(() => fetchJson("https://x.test/a", {}, 1000, 0))).toEqual(["timeout"]);
  });

  it("any other network error: network", async () => {
    responses.push({ reject: new Error("ECONNRESET") });
    expect(await kindsAfter(() => fetchJsonPost("https://x.test/a", {}, 1000, 0))).toEqual(["network"]);
  });

  it("a call refused because the breaker is shut: breaker-open", async () => {
    for (let i = 0; i < 5; i++) responses.push({ status: 500 });
    for (let i = 0; i < 5; i++) await fetchJson("https://x.test/a", {}, 1000, 0);
    warn.mockReset();
    _resetTroubleLogForTests();
    expect(isCircuitOpen("x.test")).toBe(true);
    expect(await kindsAfter(() => fetchJson("https://x.test/a", {}, 1000, 0))).toEqual(["breaker-open"]);
    _resetTroubleLogForTests();
    warn.mockReset();
    expect(await kindsAfter(() => fetchJsonPost("https://x.test/a", {}, 1000, 0))).toEqual(["breaker-open"]);
  });

  it("a 404 or an answer that works leaves nothing", async () => {
    responses.push({ status: 404 }, { status: 200, body: { ok: 1 } });
    expect(await kindsAfter(async () => {
      await fetchJson("https://x.test/a", {}, 1000, 0);
      await fetchJson("https://x.test/a", {}, 1000, 0);
    })).toEqual([]);
  });
});
