// __tests__/audit-lot01.test.ts — Lot 1 of the file-by-file audit (2026-10-17): http.ts, settle.ts, concurrency.ts, math.ts,
// (deployment.ts: nothing to fix). Each test pins a defect that the previous code had, so it fails on the old code and passes on the corrected one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  fetchJson,
  fetchJsonPost,
  isCircuitOpen,
  scrubSensitive,
  _resetCircuitBreakersForTests,
  MAX_BODY_BYTES,
} from "../api/_lib/http";
import { isSourceDown } from "../api/_lib/outage";
import { settleWithin } from "../api/_lib/settle";
import { runWithConcurrency } from "../api/_lib/concurrency";
import { asNumber } from "../api/_lib/math";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** A body whose bytes arrive in the given chunks, then (if `hang`) never ends. */
function streamed(chunks: Uint8Array[], hang = false, status = 200): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else if (!hang) controller.close();
      else return new Promise<void>(() => undefined); // trickle: never closes
    },
  });
  return new Response(stream, { status });
}

beforeEach(() => {
  _resetCircuitBreakersForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("http.ts — the deadline covers the body", () => {
  it("returns null within the deadline when the headers arrive but the body never ends", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamed([new TextEncoder().encode('{"a":')], true)));
    const t0 = Date.now();
    const out = await fetchJson("https://slow.test/x", {}, 150, 0);
    expect(out).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("http.ts — body size ceiling", () => {
  it("refuses a declared Content-Length above the ceiling without reading it, and does not ask again", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-length": String(MAX_BODY_BYTES + 1) } }));
    vi.stubGlobal("fetch", f);
    expect(await fetchJson("https://big.test/x", {}, 1000, 1)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("cuts a streamed body as soon as it crosses the ceiling", async () => {
    const mib = new Uint8Array(1024 * 1024).fill(0x20);
    const chunks = Array.from({ length: MAX_BODY_BYTES / mib.byteLength + 2 }, () => mib);
    vi.stubGlobal("fetch", vi.fn(async () => streamed(chunks)));
    expect(await fetchJson("https://big2.test/x", {}, 5000, 0)).toBeNull();
  });
});

describe("http.ts — decoding", () => {
  it("decodes a character split across two chunks, and drops a UTF-8 byte-order mark", async () => {
    const bytes = new TextEncoder().encode('﻿{"name":"café"}');
    const cut = bytes.length - 4; // inside the two bytes of "é"
    vi.stubGlobal("fetch", vi.fn(async () => streamed([bytes.slice(0, cut), bytes.slice(cut)])));
    expect(await fetchJson("https://utf8.test/x")).toEqual({ name: "café" });
  });
});

describe("http.ts — what is retried and what is counted", () => {
  it("a 503 is counted ONCE: four calls that end on a 503 do not open the breaker, the fifth does", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 503)));
    for (let i = 0; i < 4; i++) await fetchJson("https://busy.test/x", {}, 1000, 0);
    expect(isCircuitOpen("busy.test")).toBe(false);
    await fetchJson("https://busy.test/x", {}, 1000, 0);
    expect(isCircuitOpen("busy.test")).toBe(true);
  });

  it("a 503 counts once in the outage ledger too (RugCheck is down at 2 failures, not at 1 call)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 503)));
    await fetchJson("https://api.rugcheck.xyz/v1/tokens/x/report", {}, 1000, 0);
    expect(isSourceDown("rugcheck")).toBe(false);
  });

  it("an answer that is not JSON is not asked again (a second request would be billed again)", async () => {
    const f = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    vi.stubGlobal("fetch", f);
    expect(await fetchJson("https://html.test/x", {}, 1000, 1)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a nonsense maxRetries (NaN) reads as 0, never as a loop", async () => {
    const f = vi.fn(async () => json({}, 503));
    vi.stubGlobal("fetch", f);
    await fetchJson("https://nan.test/x", {}, 1000, Number.NaN);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a body that cannot be serialised is the caller's bug: no request, no failure counted", async () => {
    const f = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", f);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await fetchJsonPost("https://rpc.test/", cyclic)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("http.ts — a call the caller abandons", () => {
  it("is not counted against the host and is not retried", async () => {
    const f = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", f);
    for (let i = 0; i < 6; i++) {
      const c = new AbortController();
      const p = fetchJson("https://cancel.test/x", { signal: c.signal }, 5000, 1);
      c.abort();
      expect(await p).toBeNull();
    }
    expect(f).toHaveBeenCalledTimes(6); // one attempt each, no retry
    expect(isCircuitOpen("cancel.test")).toBe(false);
  });
});

describe("http.ts — half-open breaker", () => {
  async function openBreaker(host: string) {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 500)));
    for (let i = 0; i < 5; i++) await fetchJson(`https://${host}/x`, {}, 1000, 0);
    expect(isCircuitOpen(host)).toBe(true);
  }

  it("after the cooldown, ONE probe goes out while the other calls fail fast; a failed probe re-opens at once", async () => {
    await openBreaker("probe.test");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);

    let release!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", f);

    const probe = fetchJson("https://probe.test/x", {}, 5000, 0);
    const other = await fetchJson("https://probe.test/x", {}, 5000, 0);
    expect(other).toBeNull();
    expect(f).toHaveBeenCalledTimes(1); // only the probe went out

    release(json({}, 500));
    expect(await probe).toBeNull();
    expect(isCircuitOpen("probe.test")).toBe(true); // re-opened by the failed probe, without five new failures
  });

  it("a probe that gets an answer closes the breaker", async () => {
    await openBreaker("heal.test");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true })));
    expect(await fetchJson("https://heal.test/x")).toEqual({ ok: true });
    expect(isCircuitOpen("heal.test")).toBe(false);
  });

  it("a probe the caller abandons gives the slot back (the breaker is not stuck)", async () => {
    await openBreaker("stuck.test");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    vi.stubGlobal(
      "fetch",
      vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_r, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
    );
    const c = new AbortController();
    const p = fetchJson("https://stuck.test/x", { signal: c.signal }, 5000, 0);
    c.abort();
    expect(await p).toBeNull();
    expect(isCircuitOpen("stuck.test")).toBe(false); // half-open again: the next call may probe
  });
});

describe("http.ts — log hygiene", () => {
  it("redacts access_token too, and stops at a fragment", () => {
    expect(scrubSensitive("https://x.test/?access_token=abc#frag")).toBe("https://x.test/?access_token=[REDACTED]#frag");
    expect(scrubSensitive("https://x.test/?api-key=abc&ok=1")).toBe("https://x.test/?api-key=[REDACTED]&ok=1");
  });
});

describe("settle.ts", () => {
  it("Infinity means 'wait for the writes', not 'do not wait' (setTimeout overflows to 1 ms)", async () => {
    let done = false;
    const slow = new Promise<void>((r) => setTimeout(() => { done = true; r(); }, 50));
    await settleWithin([slow], Infinity);
    expect(done).toBe(true);
  });

  it("NaN does not wait, and a write that rejects later is still observed (no unhandled rejection)", async () => {
    const late = new Promise<void>((_r, reject) => setTimeout(() => reject(new Error("late")), 10));
    await settleWithin([late], Number.NaN);
    await new Promise((r) => setTimeout(r, 30));
  });
});

describe("concurrency.ts", () => {
  it("a NaN limit still runs every item (it used to start no worker and return holes)", async () => {
    const out = await runWithConcurrency([1, 2, 3], Number.NaN, async (x) => x * 2);
    expect(out).toEqual([2, 4, 6]);
    expect(Object.keys(out)).toHaveLength(3);
  });

  it("after a failure no new item is started", async () => {
    const started: number[] = [];
    const run = runWithConcurrency([0, 1, 2, 3, 4, 5], 1, async (x) => {
      started.push(x);
      if (x === 1) throw new Error("boom");
      return x;
    });
    await expect(run).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([0, 1]);
  });

  it("Infinity runs everything at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4], Infinity, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBe(4);
  });
});

describe("math.ts — asNumber reads only plain decimals", () => {
  it.each([
    [42, 42],
    ["42", 42],
    [" -0.5 ", -0.5],
    [".5", 0.5],
    ["1e-3", 0.001],
    ["2.5E+4", 25000],
    [10n, 10],
  ])("%p -> %p", (input, expected) => {
    expect(asNumber(input)).toBe(expected);
  });

  it.each([["12abc"], ["1,234.5"], ["5%"], ["0x10"], [""], ["  "], ["Infinity"], ["NaN"], [null], [undefined], [true], [{}], [[5]], [Number.POSITIVE_INFINITY]])(
    "%p -> 0 (unknown, never a wrong small number)",
    (input) => {
      expect(asNumber(input)).toBe(0);
    },
  );
});
