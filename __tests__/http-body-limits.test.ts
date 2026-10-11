// __tests__/http-body-limits.test.ts
//
// fetchJson / fetchJsonPost used to clear their timer as soon as the headers
// arrived, so reading the body had no deadline at all, read it whatever its
// size (a 2.8 MB GoPlus answer was seen), and fetchJson replaced the caller's
// own AbortSignal with its timer. Now: the timer runs until the body is read,
// a body over 2 MB is refused (declared or counted), and the caller's signal
// is honoured next to the timer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/_lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  fetchJson,
  fetchJsonPost,
  isCircuitOpen,
  MAX_BODY_BYTES,
  _resetCircuitBreakersForTests,
} from "../api/_lib/http";

const URL_OK = "https://api.example.com/x";
const enc = new TextEncoder();

/** A body that sends one chunk, then stalls until the request's signal aborts. */
function stalledBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('{"partial":'));
      signal?.addEventListener("abort", () =>
        controller.error(new DOMException("Aborted", "AbortError")),
      );
    },
  });
}

/** A chunked body (no content-length) of `chunks` x `chunkBytes` bytes. */
function chunkedBody(chunks: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent++ >= chunks) return controller.close();
      controller.enqueue(new Uint8Array(chunkBytes).fill(32));
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetCircuitBreakersForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
}

describe("body deadline", () => {
  it("aborts a body that stalls after the headers (fetchJson)", async () => {
    stubFetch(async (_u, init) => new Response(stalledBody(init.signal), { status: 200 }));
    const t0 = Date.now();
    const out = await fetchJson(URL_OK, {}, 80, 0);
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("aborts a body that stalls after the headers (fetchJsonPost)", async () => {
    stubFetch(async (_u, init) => new Response(stalledBody(init.signal), { status: 200 }));
    const t0 = Date.now();
    const out = await fetchJsonPost(URL_OK, { a: 1 }, 80, 0);
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("still parses a body that arrives in time", async () => {
    stubFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await fetchJson(URL_OK, {}, 1000, 0)).toEqual({ ok: true });
    expect(await fetchJsonPost(URL_OK, {}, 1000, 0)).toEqual({ ok: true });
  });
});

describe("body size cap", () => {
  it("refuses a declared content-length over the cap without reading, and does not retry", async () => {
    stubFetch(
      async () =>
        new Response(chunkedBody(1, 10), {
          status: 200,
          headers: { "content-length": String(MAX_BODY_BYTES + 1) },
        }),
    );
    expect(await fetchJson(URL_OK, {}, 1000, 2)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a chunked body that grows past the cap, and does not retry", async () => {
    stubFetch(async () => new Response(chunkedBody(3, MAX_BODY_BYTES / 2), { status: 200 }));
    expect(await fetchJson(URL_OK, {}, 5000, 2)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies the same cap to fetchJsonPost", async () => {
    stubFetch(async () => new Response(chunkedBody(3, MAX_BODY_BYTES / 2), { status: 200 }));
    expect(await fetchJsonPost(URL_OK, {}, 5000, 2)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a body just under the cap", async () => {
    const pad = "x".repeat(MAX_BODY_BYTES - 64);
    stubFetch(async () => new Response(JSON.stringify({ pad }), { status: 200 }));
    const out = await fetchJson<{ pad: string }>(URL_OK, {}, 5000, 0);
    expect(out?.pad.length).toBe(pad.length);
  });

  it("an oversized answer is not an unhealthy upstream: the breaker stays closed", async () => {
    stubFetch(
      async () =>
        new Response(chunkedBody(1, 10), {
          status: 200,
          headers: { "content-length": String(MAX_BODY_BYTES + 1) },
        }),
    );
    for (let i = 0; i < 6; i++) await fetchJson(URL_OK, {}, 1000, 0);
    expect(isCircuitOpen("api.example.com")).toBe(false);
  });
});

describe("caller signal", () => {
  it("honours the caller's signal next to the timer", async () => {
    stubFetch(async (_u, init) => new Response(stalledBody(init.signal), { status: 200 }));
    const caller = new AbortController();
    const pending = fetchJson(URL_OK, { signal: caller.signal }, 5000, 2);
    setTimeout(() => caller.abort(), 30);
    const t0 = Date.now();
    expect(await pending).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    // aborted by the caller: no retry
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still applies the timer when the caller's signal never fires", async () => {
    stubFetch(async (_u, init) => new Response(stalledBody(init.signal), { status: 200 }));
    const caller = new AbortController();
    const t0 = Date.now();
    expect(await fetchJson(URL_OK, { signal: caller.signal }, 80, 0)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("does not touch the network when the caller has already aborted", async () => {
    stubFetch(async () => new Response("{}", { status: 200 }));
    const caller = new AbortController();
    caller.abort();
    expect(await fetchJson(URL_OK, { signal: caller.signal })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
