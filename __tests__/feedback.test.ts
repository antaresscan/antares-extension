// __tests__/feedback.test.ts — Coverage for the user feedback bucket
// (`api/_lib/feedback.ts`). Tests run against an in-memory mock that
// emulates the Upstash Redis subset we actually use (set NX + EX,
// lpush, ltrim, expire, lrange).
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initFeedbackStore,
  submitFeedback,
  getFeedbackSummary,
  getDisagreementSignal,
  ipToPrefix24,
} from "../api/_lib/feedback";

// Minimal Upstash-compatible mock. We only model the methods feedback.ts
// touches — any other method call should explode loudly so the test
// catches accidental drift.
function makeMockRedis() {
  const kv = new Map<string, { value: unknown; ttl?: number }>();
  const lists = new Map<string, string[]>();
  return {
    set: vi.fn(async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && kv.has(key)) return null;
      kv.set(key, { value, ttl: opts?.ex });
      return "OK";
    }),
    lpush: vi.fn(async (key: string, value: string) => {
      const list = lists.get(key) ?? [];
      list.unshift(value);
      lists.set(key, list);
      return list.length;
    }),
    ltrim: vi.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key) ?? [];
      lists.set(key, list.slice(start, stop + 1));
      return "OK";
    }),
    expire: vi.fn(async (_key: string, _seconds: number) => 1),
    lrange: vi.fn(async (key: string, start: number, stop: number) => {
      const list = lists.get(key) ?? [];
      return list.slice(start, stop + 1);
    }),
    _state: { kv, lists },
  };
}

describe("ipToPrefix24", () => {
  it("returns the /24 for a valid IPv4", () => {
    expect(ipToPrefix24("1.2.3.4")).toBe("1.2.3");
    expect(ipToPrefix24("192.168.1.250")).toBe("192.168.1");
  });
  it("returns null for IPv6 (we don't bucket those)", () => {
    expect(ipToPrefix24("2a01:cb14:1111::1")).toBeNull();
  });
  it("returns null for sentinels and malformed input", () => {
    expect(ipToPrefix24("unknown")).toBeNull();
    expect(ipToPrefix24("")).toBeNull();
    expect(ipToPrefix24(null)).toBeNull();
    expect(ipToPrefix24(undefined)).toBeNull();
    expect(ipToPrefix24("999.999.999.999.999")).toBeNull();
  });
});

describe("submitFeedback", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
    initFeedbackStore(redis as unknown as Parameters<typeof initFeedbackStore>[0]);
  });

  it("rejects when the storage layer is not configured", async () => {
    initFeedbackStore(null);
    const out = await submitFeedback({
      ca: "abc",
      originalVerdict: "SAFE",
      reportedVerdict: "RUG",
    });
    expect(out).toEqual({ ok: false, reason: "no_storage" });
  });

  it("rejects when original and reported verdicts are identical", async () => {
    const out = await submitFeedback({
      ca: "abc",
      originalVerdict: "SAFE",
      reportedVerdict: "SAFE",
    });
    expect(out).toEqual({ ok: false, reason: "same_verdict" });
    expect(redis.lpush).not.toHaveBeenCalled();
  });

  it("persists a valid report and returns the running count", async () => {
    const out = await submitFeedback({
      ca: "tokenAAA",
      originalVerdict: "SAFE",
      reportedVerdict: "RUG",
      note: "Got rugged 2h after scan",
      installId: "install-12345678",
      ip: "203.0.113.45",
    });
    expect(out).toEqual({ ok: true, totalReports: 1 });

    const stored = redis._state.lists.get("feedback:v1:tokenAAA");
    expect(stored).toHaveLength(1);
    const entry = JSON.parse(stored![0]);
    expect(entry.originalVerdict).toBe("SAFE");
    expect(entry.reportedVerdict).toBe("RUG");
    expect(entry.note).toBe("Got rugged 2h after scan");
    expect(entry.ipPrefix).toBe("203.0.113");
    expect(typeof entry.ts).toBe("number");
  });

  it("blocks a duplicate report from the same install on the same CA", async () => {
    const opts = {
      ca: "tokenBBB",
      originalVerdict: "SAFE" as const,
      reportedVerdict: "RUG" as const,
      installId: "install-87654321",
      ip: "1.2.3.4",
    };
    const first = await submitFeedback(opts);
    expect(first.ok).toBe(true);

    const second = await submitFeedback(opts);
    expect(second).toEqual({ ok: false, reason: "duplicate" });

    // Only the first write made it into the list.
    const stored = redis._state.lists.get("feedback:v1:tokenBBB");
    expect(stored).toHaveLength(1);
  });

  it("does not dedup across DIFFERENT CAs from the same install", async () => {
    const installId = "install-aaabbbccc";
    const r1 = await submitFeedback({
      ca: "tokenA",
      originalVerdict: "SAFE",
      reportedVerdict: "RUG",
      installId,
    });
    const r2 = await submitFeedback({
      ca: "tokenB",
      originalVerdict: "SAFE",
      reportedVerdict: "RUG",
      installId,
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it("does not dedup when no installId is provided (different IPs treated as different reporters)", async () => {
    // Without an install_id, the dedup lock key cannot be computed —
    // we accept the trade-off (more anonymous reports admitted) because
    // the IP-level rate limit applied at the endpoint layer is the
    // primary anti-spam gate. Unit-test this explicitly so a future
    // regression doesn't silently start blocking install-less reports.
    await submitFeedback({
      ca: "tokenC",
      originalVerdict: "SAFE",
      reportedVerdict: "RUG",
      ip: "1.2.3.4",
    });
    const second = await submitFeedback({
      ca: "tokenC",
      originalVerdict: "SAFE",
      reportedVerdict: "RUG",
      ip: "1.2.3.4",
    });
    expect(second.ok).toBe(true);
  });

  it("truncates note at 500 chars", async () => {
    const long = "a".repeat(800);
    const out = await submitFeedback({
      ca: "tokenD",
      originalVerdict: "SAFE",
      reportedVerdict: "RUG",
      note: long,
    });
    expect(out.ok).toBe(true);
    const stored = redis._state.lists.get("feedback:v1:tokenD")!;
    const entry = JSON.parse(stored[0]);
    expect(entry.note).toHaveLength(500);
  });

  it("calls lpush + ltrim + expire on every successful write", async () => {
    await submitFeedback({
      ca: "tokenE",
      originalVerdict: "SAFE",
      reportedVerdict: "DANGER",
      installId: "install-zzzz1111",
    });
    expect(redis.lpush).toHaveBeenCalledTimes(1);
    expect(redis.ltrim).toHaveBeenCalledTimes(1);
    expect(redis.expire).toHaveBeenCalledTimes(1);
    // ltrim cap = PER_CA_CAP - 1 = 99
    expect(redis.ltrim).toHaveBeenCalledWith("feedback:v1:tokenE", 0, 99);
    // expire = 90 days in seconds
    expect(redis.expire).toHaveBeenCalledWith("feedback:v1:tokenE", 60 * 60 * 24 * 90);
  });
});

describe("getFeedbackSummary", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
    initFeedbackStore(redis as unknown as Parameters<typeof initFeedbackStore>[0]);
  });

  it("returns an empty summary when no reports exist", async () => {
    const summary = await getFeedbackSummary("emptyToken");
    expect(summary).toEqual({ ca: "emptyToken", count: 0, pairs: {}, recent: [] });
  });

  it("aggregates pair counts across multiple reports", async () => {
    for (let i = 0; i < 3; i++) {
      await submitFeedback({
        ca: "tokenAgg",
        originalVerdict: "SAFE",
        reportedVerdict: "RUG",
        installId: `install-${i}-${"x".repeat(10)}`,
      });
    }
    await submitFeedback({
      ca: "tokenAgg",
      originalVerdict: "SAFE",
      reportedVerdict: "DANGER",
      installId: "install-different-1",
    });
    await submitFeedback({
      ca: "tokenAgg",
      originalVerdict: "DANGER",
      reportedVerdict: "SAFE",
      installId: "install-different-2",
    });

    const summary = await getFeedbackSummary("tokenAgg");
    expect(summary?.count).toBe(5);
    expect(summary?.pairs["SAFE_RUG"]).toBe(3);
    expect(summary?.pairs["SAFE_DANGER"]).toBe(1);
    expect(summary?.pairs["DANGER_SAFE"]).toBe(1);
  });

  it("returns null when no Redis is configured", async () => {
    initFeedbackStore(null);
    const summary = await getFeedbackSummary("anyToken");
    expect(summary).toBeNull();
  });

  it("skips malformed entries without throwing", async () => {
    // Inject a manually-corrupted entry to simulate a bad write
    redis._state.lists.set("feedback:v1:dirty", [
      "not-valid-json",
      JSON.stringify({
        originalVerdict: "SAFE",
        reportedVerdict: "RUG",
        ts: 1,
        ipPrefix: null,
      }),
    ]);
    const summary = await getFeedbackSummary("dirty");
    expect(summary?.count).toBe(1);
    expect(summary?.pairs["SAFE_RUG"]).toBe(1);
  });
});

describe("getDisagreementSignal", () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
    initFeedbackStore(redis as unknown as Parameters<typeof initFeedbackStore>[0]);
  });

  // Helper that bypasses the dedup lock so each call lands a fresh entry.
  // Real submitFeedback would block these as duplicates because they share
  // an installId by default; the no-installId path admits everything.
  const seedFeedback = async (
    ca: string,
    pairs: Array<readonly ["SAFE" | "CAUTION" | "DANGER" | "RUG", "SAFE" | "CAUTION" | "DANGER" | "RUG"]>,
  ) => {
    let i = 0;
    for (const [from, to] of pairs) {
      await submitFeedback({
        ca,
        originalVerdict: from,
        reportedVerdict: to,
        installId: `seed-${i++}-${"x".repeat(10)}`,
      });
    }
  };

  it("returns null below the minTotal floor", async () => {
    await seedFeedback("tokenLow", [
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
    ]);
    expect(await getDisagreementSignal("tokenLow")).toBeNull();
  });

  it("returns the dominant pair when count >= 5 and majority agrees", async () => {
    await seedFeedback("tokenA", [
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
    ]);
    const signal = await getDisagreementSignal("tokenA");
    expect(signal).toEqual({
      totalReports: 5,
      from: "SAFE",
      to: "RUG",
      pairCount: 5,
    });
  });

  it("picks the largest pair when multiple are present, as long as it's dominant", async () => {
    // 6 reports — 4 of SAFE→RUG (66%), 2 of SAFE→DANGER. SAFE→RUG dominates.
    await seedFeedback("tokenB", [
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "DANGER"],
      ["SAFE", "DANGER"],
    ]);
    const signal = await getDisagreementSignal("tokenB");
    expect(signal?.from).toBe("SAFE");
    expect(signal?.to).toBe("RUG");
    expect(signal?.pairCount).toBe(4);
    expect(signal?.totalReports).toBe(6);
  });

  it("returns null when the leading pair fails the dominance threshold", async () => {
    // 6 reports split as 2/2/2 — no single pair owns >= 50%.
    await seedFeedback("tokenSplit", [
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "DANGER"],
      ["SAFE", "DANGER"],
      ["SAFE", "CAUTION"],
      ["SAFE", "CAUTION"],
    ]);
    expect(await getDisagreementSignal("tokenSplit")).toBeNull();
  });

  it("respects the dominanceThreshold override", async () => {
    // 5 reports — 3 SAFE→RUG (60%), 2 SAFE→DANGER (40%).
    await seedFeedback("tokenAdj", [
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "DANGER"],
      ["SAFE", "DANGER"],
    ]);
    // Default 0.5 → 60% >= 50% → returns SAFE→RUG.
    const defaultSig = await getDisagreementSignal("tokenAdj");
    expect(defaultSig?.to).toBe("RUG");
    // Bumping to 0.7 → 60% < 70% → returns null.
    const strictSig = await getDisagreementSignal("tokenAdj", 5, 0.7);
    expect(strictSig).toBeNull();
  });

  it("respects the minTotal override", async () => {
    await seedFeedback("tokenMin", [
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
      ["SAFE", "RUG"],
    ]);
    // Default 5 → 3 reports → null.
    expect(await getDisagreementSignal("tokenMin")).toBeNull();
    // Lowered to 3 → returns the dominant pair.
    const sig = await getDisagreementSignal("tokenMin", 3);
    expect(sig?.totalReports).toBe(3);
    expect(sig?.to).toBe("RUG");
  });

  it("returns null when storage is not configured", async () => {
    initFeedbackStore(null);
    expect(await getDisagreementSignal("anyToken")).toBeNull();
  });
});
