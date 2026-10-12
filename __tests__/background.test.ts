// __tests__/background.test.ts
//
// A Vercel function is frozen as soon as it has answered, and a Redis write still in flight is suspended with it: a cache entry
// lost, i.e. one more cold scan for the next visitor of the token. keepAlive() hands such work to waitUntil() so the platform holds
// the function until it settles, never makes the answer wait for it, and never lets its failure reach the user.
import { describe, it, expect, vi, beforeEach } from "vitest";

const warn = vi.fn();
vi.mock("../api/_lib/logger", () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn() },
}));
const { waitUntil } = vi.hoisted(() => ({ waitUntil: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil }));

import { keepAlive } from "../api/_lib/background";

beforeEach(() => {
  warn.mockReset();
  waitUntil.mockReset();
});

describe("keepAlive", () => {
  it("registers the work with waitUntil, and the registered promise settles when the work does", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    keepAlive(work, "cache write");
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const registered = waitUntil.mock.calls[0][0] as Promise<void>;
    let settled = false;
    void registered.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false); // still held while the work runs
    finish();
    await registered;
    expect(settled).toBe(true);
  });

  it("does not make the caller wait: it returns at once, whatever the work does", () => {
    const never = new Promise<void>(() => {});
    expect(keepAlive(never, "slow write")).toBeUndefined();
  });

  it("turns a failed write into a log line, never a rejection", async () => {
    keepAlive(Promise.reject(new Error("redis down")), "cache write");
    const registered = waitUntil.mock.calls[0][0] as Promise<void>;
    await expect(registered).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("background", "cache write failed after the answer", { error: "Error: redis down" });
  });

  it("accepts work that is not a promise (a writer that returned nothing)", async () => {
    keepAlive(undefined, "cache write");
    const registered = waitUntil.mock.calls[0][0] as Promise<void>;
    await expect(registered).resolves.toBeUndefined();
  });

  it("never breaks the scan when waitUntil itself throws", () => {
    waitUntil.mockImplementation(() => { throw new Error("no request context"); });
    expect(() => keepAlive(Promise.resolve(), "cache write")).not.toThrow();
    expect(warn).toHaveBeenCalledWith("background", "waitUntil unavailable", { label: "cache write", error: "Error: no request context" });
  });
});
