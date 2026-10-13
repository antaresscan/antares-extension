import { describe, it, expect, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import { serveLastGood } from "../api/_lib/last-good";
import { initCache, setLastGoodResult, getLastGoodResult, lastGoodKey, LAST_GOOD_TTL_SEC } from "../api/_lib/cache";
import { ENGINE_VERSION } from "../api/_lib/constants";
import { withServeWindows } from "../api/_lib/helpers";
import type { ScanResult } from "../api/_lib/types";

// The memory of an issuer-backed token's last good verdict (api/_lib/last-good.ts): served again, with its age, when DexScreener cannot be read.

const NOW = 1_800_000_000_000;
const scan = (over: Record<string, unknown> = {}): ScanResult => ({
  risk: "SAFE", score: 950, rugKind: null, flags: [], fetchedAt: NOW, requestId: "req-now", resolvedMint: "Mint1111111111111111111111111111111111111111", ...over,
}) as unknown as ScanResult;

describe("serveLastGood: what to answer for an issuer-backed token whose market cannot be read", () => {
  it("serves the memory: its own verdict and its own moment, marked degraded and from memory, with this request's id", () => {
    const good = scan({ fetchedAt: NOW - 6 * 60_000, requestId: "req-old", score: 950, priceUsd: 1.0001 });
    const served = serveLastGood(good, scan({ requestId: "req-now" }))!;
    expect(served.risk).toBe("SAFE");
    expect(served.priceUsd).toBe(1.0001);
    expect(served.fetchedAt).toBe(NOW - 6 * 60_000); // when the market was read, not now
    expect(served.requestId).toBe("req-now");
    expect(served.degraded).toBe(true);
    expect(served.servedFromMemory).toBe(true);
  });

  it("does not touch what it was given (the stored memory and the scan stay as they are)", () => {
    const good = scan({ fetchedAt: NOW - 1000 });
    const current = scan();
    serveLastGood(good, current);
    expect("servedFromMemory" in good).toBe(false);
    expect(good.requestId).toBe("req-now");
    expect("servedFromMemory" in current).toBe(false);
  });

  it("no memory, nothing to serve", () => {
    expect(serveLastGood(null, scan())).toBeNull();
    expect(serveLastGood(undefined as unknown as null, scan())).toBeNull();
  });

  it("a memory that cannot be used is not served: no moment, a moment that is not a number, a verdict that is not one", () => {
    expect(serveLastGood(scan({ fetchedAt: undefined }), scan())).toBeNull();
    expect(serveLastGood(scan({ fetchedAt: NaN }), scan())).toBeNull();
    expect(serveLastGood(scan({ fetchedAt: "yesterday" }), scan())).toBeNull();
    expect(serveLastGood(scan({ risk: "FINE" }), scan())).toBeNull();
    expect(serveLastGood("garbage" as unknown as ScanResult, scan())).toBeNull();
  });

  it("never a copy of a copy: a memory that was itself served from memory is not served again", () => {
    expect(serveLastGood(scan({ servedFromMemory: true, fetchedAt: NOW - 1000 }), scan())).toBeNull();
  });

  it("this scan wins when it found something WORSE than the memory (a fact from another source is not hidden by an old SAFE)", () => {
    for (const worse of ["CAUTION", "DANGER", "RUG"] as const) expect(serveLastGood(scan({ fetchedAt: NOW - 1000 }), scan({ risk: worse })), worse).toBeNull();
    expect(serveLastGood(scan({ risk: "CAUTION", fetchedAt: NOW - 1000 }), scan({ risk: "RUG" }))).toBeNull();
  });

  it("the memory wins when it is as bad or worse than this scan (an old bad verdict is safe to show)", () => {
    expect(serveLastGood(scan({ risk: "RUG", fetchedAt: NOW - 3600_000 }), scan({ risk: "SAFE" }))?.risk).toBe("RUG");
    expect(serveLastGood(scan({ risk: "DANGER", fetchedAt: NOW - 3600_000 }), scan({ risk: "CAUTION" }))?.risk).toBe("DANGER");
    expect(serveLastGood(scan({ risk: "CAUTION", fetchedAt: NOW - 1000 }), scan({ risk: "CAUTION" }))?.risk).toBe("CAUTION");
  });
});

describe("withServeWindows: how old a verdict served from memory is", () => {
  it("scannedAgoSec is sent only for a verdict served from memory, counted from when its market was read", () => {
    const base = { risk: "SAFE" as const, rugKind: null, pairCreatedAt: null, solscanTokenAgeHours: null, priceChange1h: null, degraded: true };
    expect(withServeWindows({ ...base, fetchedAt: NOW - 360_000, servedFromMemory: true }, NOW).scannedAgoSec).toBe(360);
    expect(withServeWindows({ ...base, fetchedAt: NOW - 360_999, servedFromMemory: true }, NOW).scannedAgoSec).toBe(360);
    expect(withServeWindows({ ...base, fetchedAt: NOW, servedFromMemory: true }, NOW).scannedAgoSec).toBe(0);
    expect(withServeWindows({ ...base, fetchedAt: NOW - 360_000 }, NOW).scannedAgoSec).toBeUndefined(); // an ordinary answer says nothing
    expect(withServeWindows({ ...base, fetchedAt: NOW - 360_000, servedFromMemory: false }, NOW).scannedAgoSec).toBeUndefined();
  });

  it("never negative (a clock quirk), and not stored: the stored answer is not modified", () => {
    const stored = { risk: "SAFE" as const, rugKind: null, pairCreatedAt: null, solscanTokenAgeHours: null, priceChange1h: null, degraded: true, servedFromMemory: true, fetchedAt: NOW + 5000 };
    expect(withServeWindows(stored, NOW).scannedAgoSec).toBe(0);
    expect("scannedAgoSec" in stored).toBe(false);
  });
});

describe("the memory in Redis: its own key, 6 hours, fail-open", () => {
  const fake = () => {
    const redis = { setex: vi.fn().mockResolvedValue("OK"), get: vi.fn().mockResolvedValue(null) };
    initCache(redis as unknown as Redis);
    return redis;
  };

  it("its own key (not the scan cache's), by engine version, and 6 h", async () => {
    const redis = fake();
    setLastGoodResult("MintAbc", { risk: "SAFE" });
    expect(redis.setex).toHaveBeenCalledWith(lastGoodKey("MintAbc"), LAST_GOOD_TTL_SEC, { risk: "SAFE" });
    expect(LAST_GOOD_TTL_SEC).toBe(6 * 3600);
    expect(lastGoodKey("MintAbc")).toContain(":lastgood:");
    expect(lastGoodKey("MintAbc")).toContain(ENGINE_VERSION);
    expect(lastGoodKey("MintAbc").endsWith(":MintAbc")).toBe(true);
  });

  it("reads what was written, and nothing when there is nothing", async () => {
    const redis = fake();
    redis.get.mockResolvedValueOnce({ risk: "SAFE", fetchedAt: NOW });
    expect(await getLastGoodResult("MintAbc")).toEqual({ risk: "SAFE", fetchedAt: NOW });
    expect(redis.get).toHaveBeenCalledWith(lastGoodKey("MintAbc"));
    expect(await getLastGoodResult("MintAbc")).toBeNull();
  });

  it("fails open: a Redis that refuses to write or to read never breaks a scan", async () => {
    const redis = fake();
    redis.setex.mockRejectedValueOnce(new Error("down"));
    expect(() => setLastGoodResult("MintAbc", { risk: "SAFE" })).not.toThrow();
    redis.get.mockRejectedValueOnce(new Error("down"));
    expect(await getLastGoodResult("MintAbc")).toBeNull();
  });
});
