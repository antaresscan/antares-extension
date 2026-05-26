// __tests__/http-circuit-breaker.test.ts
//
// Pins the per-host circuit-breaker behaviour added to api/_lib/http.ts.
// The breaker counts consecutive failures (5xx, 429/503 after retry
// exhaustion, network errors). After 5 inside a 30s window the breaker
// opens — subsequent fetches return null immediately for 30s. Any
// success resets the breaker.

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  afterEach,
} from "vitest";

// We don't want the suite hitting the real network — stub global fetch.
// `responses` is a queue: each invocation drains the head.
let responses: Array<{ status: number; body?: unknown } | { reject: Error }> =
  [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  responses = [];
  globalThis.fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("stub queue empty");
    if ("reject" in next) throw next.reject;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

import {
  fetchJson,
  isCircuitOpen,
  _resetCircuitBreakersForTests,
} from "../api/_lib/http";

describe("circuit breaker", () => {
  beforeEach(() => {
    _resetCircuitBreakersForTests();
  });

  it("does not open for a single 500", async () => {
    responses.push({ status: 500 }, { status: 500 });
    // fetchJson with default maxRetries=1 retries 5xx? No — only 429/503.
    // 500 is treated as a hard failure, no retry, so one call = one
    // failure recorded.
    const out = await fetchJson("https://api.example.com/x");
    expect(out).toBe(null);
    expect(isCircuitOpen("api.example.com")).toBe(false);
  });

  it("opens after 5 consecutive 500s within the window", async () => {
    for (let i = 0; i < 5; i++) responses.push({ status: 500 });
    for (let i = 0; i < 5; i++) {
      await fetchJson("https://upstream.test/x");
    }
    expect(isCircuitOpen("upstream.test")).toBe(true);
  });

  it("returns null immediately when the breaker is open (no fetch)", async () => {
    for (let i = 0; i < 5; i++) responses.push({ status: 500 });
    for (let i = 0; i < 5; i++) await fetchJson("https://upstream.test/x");
    expect(isCircuitOpen("upstream.test")).toBe(true);
    // Queue is empty now — any further fetch call would throw "stub
    // queue empty". The breaker must short-circuit before fetch is hit.
    const out = await fetchJson("https://upstream.test/x");
    expect(out).toBe(null);
  });

  it("isolates breaker state per host", async () => {
    // URL.hostname lowercases — so we use all-lower hostnames here to
    // match what the breaker map keys on. A mixed-case test name like
    // `hostA.test` would store under `hosta.test` and surprise the
    // direct isCircuitOpen check.
    for (let i = 0; i < 5; i++) responses.push({ status: 500 });
    for (let i = 0; i < 5; i++) {
      await fetchJson("https://host-a.test/x");
    }
    expect(isCircuitOpen("host-a.test")).toBe(true);
    expect(isCircuitOpen("host-b.test")).toBe(false);
  });

  it("4xx errors (non-429) do NOT trip the breaker — they're caller errors", async () => {
    for (let i = 0; i < 10; i++) responses.push({ status: 404 });
    for (let i = 0; i < 10; i++) {
      await fetchJson("https://host-c.test/x");
    }
    expect(isCircuitOpen("host-c.test")).toBe(false);
  });

  it("a success resets the breaker mid-window", async () => {
    // 4 failures, then 1 success — the breaker should NOT be at 4
    // anymore. A 5th failure after this should not immediately open.
    responses.push(
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 200, body: { ok: true } },
      { status: 500 },
    );
    for (let i = 0; i < 4; i++) await fetchJson("https://host-d.test/x");
    await fetchJson("https://host-d.test/x"); // success, reset
    await fetchJson("https://host-d.test/x"); // 1 failure post-reset
    expect(isCircuitOpen("host-d.test")).toBe(false);
  });

  it("network errors (fetch throws) trip the breaker after retries", async () => {
    // fetchJson with default maxRetries=1 retries once on network error.
    // So a single fetchJson call eats 2 fetch invocations. To hit 5
    // breaker-counted failures, we need 5 successful "all retries
    // exhausted" outcomes = 10 thrown fetches.
    for (let i = 0; i < 10; i++)
      responses.push({ reject: new Error("ECONNRESET") });
    for (let i = 0; i < 5; i++) {
      await fetchJson("https://host-e.test/x");
    }
    expect(isCircuitOpen("host-e.test")).toBe(true);
  });
});
