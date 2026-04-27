import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  deriveEvent,
  initHistoryCache,
  pushVerdictHistory,
  getVerdictHistory,
} from "../api/_lib/verdict-history";
import type { ScanFlag } from "../api/_lib/types";
import type { Redis } from "@upstash/redis";

const flag = (label: string, severity: ScanFlag["severity"], impact = 50): ScanFlag => ({ label, severity, impact });

describe("deriveEvent", () => {
  it("returns generic message when no flags", () => {
    expect(deriveEvent("SAFE", [])).toMatch(/clean/i);
    expect(deriveEvent("CAUTION", [])).toMatch(/watch/i);
    expect(deriveEvent("DANGER", [])).toMatch(/risk signal/i);
    expect(deriveEvent("RUG", [])).toMatch(/verdict update/i);
  });

  it("picks the highest-severity flag label", () => {
    const flags: ScanFlag[] = [
      flag("Top 10 holders > 70%", "warning", 100),
      flag("Honeypot detected — cannot sell", "critical", 80),
      flag("Strong holder base (5K+) ✓", "bonus", 30),
    ];
    expect(deriveEvent("RUG", flags)).toBe("Honeypot detected — cannot sell");
  });

  it("breaks ties on impact magnitude within the same severity", () => {
    const flags: ScanFlag[] = [
      flag("Wash trading detected", "critical", 30),
      flag("LP not burned or locked", "critical", 90),
      flag("Mint Authority enabled", "critical", 60),
    ];
    expect(deriveEvent("RUG", flags)).toBe("LP not burned or locked");
  });

  it("ignores bonus flags when other severities are present", () => {
    const flags: ScanFlag[] = [
      flag("Established token (30d+) ✓", "bonus", 100),
      flag("Top 10 holders > 50%", "warning", 40),
    ];
    expect(deriveEvent("CAUTION", flags)).toBe("Top 10 holders > 50%");
  });
});

// ─── Redis-backed push/get path (mocked) ──────────────────────────────
function makeMockRedis() {
  const store = new Map<string, Array<{ score: number; member: string }>>();
  // Match Redis range semantics: negative indices count from the end,
  // out-of-bounds resolves to an empty range (not a wrap-around).
  function resolveRange(len: number, start: number, stop: number) {
    if (len === 0) return null;
    const s = start < 0 ? Math.max(0, len + start) : start;
    const e = stop < 0 ? len + stop : stop;
    if (e < 0 || s > e || s >= len) return null;
    return { s, e: Math.min(e, len - 1) };
  }
  const redis = {
    zrange: vi.fn(async (key: string, start: number, stop: number) => {
      const z = store.get(key) ?? [];
      const sorted = z.slice().sort((a, b) => a.score - b.score);
      const r = resolveRange(sorted.length, start, stop);
      if (!r) return [];
      return sorted.slice(r.s, r.e + 1).map(e => e.member);
    }),
    zadd: vi.fn(async (key: string, entry: { score: number; member: string }) => {
      const arr = store.get(key) ?? [];
      arr.push(entry);
      store.set(key, arr);
    }),
    zremrangebyrank: vi.fn(async (key: string, start: number, stop: number) => {
      const arr = (store.get(key) ?? []).slice().sort((a, b) => a.score - b.score);
      const r = resolveRange(arr.length, start, stop);
      if (!r) return;
      const remove = new Set(arr.slice(r.s, r.e + 1));
      store.set(key, arr.filter(e => !remove.has(e)));
    }),
    expire: vi.fn(async () => 1),
    _store: store,
  } as unknown as Redis & { _store: typeof store };
  return redis;
}

describe("pushVerdictHistory + getVerdictHistory (mocked Redis)", () => {
  beforeEach(() => {
    initHistoryCache(null as unknown as Redis); // reset
  });

  it("returns [] when redis is not initialized", async () => {
    const out = await getVerdictHistory("ca-no-redis");
    expect(out).toEqual([]);
  });

  it("appends an entry and reads it back", async () => {
    const redis = makeMockRedis();
    initHistoryCache(redis);
    await pushVerdictHistory("ca-1", { ts: 1000, verdict: "RUG", score: 100, event: "Honeypot" });
    const out = await getVerdictHistory("ca-1");
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe("RUG");
    expect(out[0].event).toBe("Honeypot");
  });

  it("dedupes entries within the 60s window", async () => {
    const redis = makeMockRedis();
    initHistoryCache(redis);
    await pushVerdictHistory("ca-2", { ts: 1000, verdict: "RUG", score: 100, event: "A" });
    await pushVerdictHistory("ca-2", { ts: 1500, verdict: "RUG", score: 100, event: "B" });
    const out = await getVerdictHistory("ca-2");
    expect(out).toHaveLength(1);
    expect(out[0].event).toBe("A");
  });

  it("dedupes when verdict + score are unchanged across the window", async () => {
    const redis = makeMockRedis();
    initHistoryCache(redis);
    await pushVerdictHistory("ca-3", { ts: 1000,  verdict: "DANGER", score: 200, event: "A" });
    await pushVerdictHistory("ca-3", { ts: 200000, verdict: "DANGER", score: 201, event: "B" });
    const out = await getVerdictHistory("ca-3");
    expect(out).toHaveLength(1);
  });

  it("appends when verdict changes", async () => {
    const redis = makeMockRedis();
    initHistoryCache(redis);
    await pushVerdictHistory("ca-4", { ts: 1000, verdict: "CAUTION", score: 500, event: "Launched" });
    await pushVerdictHistory("ca-4", { ts: 200000, verdict: "RUG", score: 100, event: "Pump exhausted" });
    const out = await getVerdictHistory("ca-4");
    expect(out).toHaveLength(2);
    expect(out[0].verdict).toBe("CAUTION");
    expect(out[1].verdict).toBe("RUG");
  });

  it("survives malformed entries in the ZSET", async () => {
    const redis = makeMockRedis();
    initHistoryCache(redis);
    redis._store.set("vh:ca-5", [
      { score: 100, member: "{not json" },
      { score: 200, member: JSON.stringify({ ts: 200, verdict: "RUG", score: 0, event: "OK" }) },
    ]);
    const out = await getVerdictHistory("ca-5");
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe("RUG");
  });
});
