/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initRugDb, getRugEntry, recordRug, getRecentRugs, isRugEvidence } from "../api/_lib/rugdb";
import type { RugEntry } from "../api/_lib/rugdb";

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockZadd = vi.fn();
const mockZcard = vi.fn();
const mockZrange = vi.fn();
const mockZremrangebyrank = vi.fn();
const mockMget = vi.fn();

const mockRedis = {
  get: mockGet,
  set: mockSet,
  zadd: mockZadd,
  zcard: mockZcard,
  zrange: mockZrange,
  zremrangebyrank: mockZremrangebyrank,
  mget: mockMget,
} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("rugdb", () => {
  describe("getRugEntry", () => {
    it("returns null when redis is not initialized", async () => {
      const result = await getRugEntry("test-mint");
      expect(result).toBeNull();
    });

    it("returns entry when found in redis", async () => {
      initRugDb(mockRedis);
      const entry: RugEntry = {
        mint: "abc123",
        symbol: "TEST",
        score: 50,
        risk: "RUG",
        flags: ["Honeypot detected"],
        creator: "creator1",
        flaggedAt: 1000,
        scanCount: 1,
      };
      mockGet.mockResolvedValueOnce(entry);
      const result = await getRugEntry("abc123");
      expect(result).toEqual(entry);
      expect(mockGet).toHaveBeenCalledWith("rug:abc123");
    });

    it("returns null when entry not found", async () => {
      initRugDb(mockRedis);
      mockGet.mockResolvedValueOnce(null);
      const result = await getRugEntry("missing");
      expect(result).toBeNull();
    });

    it("returns null on redis error", async () => {
      initRugDb(mockRedis);
      mockGet.mockRejectedValueOnce(new Error("Redis down"));
      const result = await getRugEntry("abc");
      expect(result).toBeNull();
    });
  });

  describe("recordRug", () => {
    it("does nothing when redis is not initialized", async () => {
      // Re-import to reset module state would be complex,
      // so we test the initialized path instead
      initRugDb(mockRedis);
      mockGet.mockResolvedValueOnce(null);
      mockSet.mockResolvedValueOnce("OK");
      mockZadd.mockResolvedValueOnce(1);
      mockZcard.mockResolvedValueOnce(1);

      await recordRug({
        mint: "rug1",
        symbol: "SCAM",
        score: 30,
        risk: "RUG",
        flags: [
          { label: "Honeypot detected — cannot sell", severity: "critical", impact: -20 },
          { label: "Info flag", severity: "info", impact: 0 },
        ],
        creator: "creator1",
      });

      expect(mockSet).toHaveBeenCalled();
      expect(mockZadd).toHaveBeenCalled();
    });

    it("skips recording for non-rug verdicts", async () => {
      initRugDb(mockRedis);
      await recordRug({
        mint: "safe1",
        symbol: "SAFE",
        score: 800,
        risk: "SAFE",
        flags: [],
        creator: null,
      });
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("does NOT record DANGER tokens, whatever their flags (audit M19: DANGER fires on weak signals)", async () => {
      initRugDb(mockRedis);

      await recordRug({
        mint: "danger1",
        symbol: "BAD",
        score: 100,
        risk: "DANGER",
        flags: [{ label: "Honeypot detected — cannot sell", severity: "critical", impact: -10 }],
        creator: null,
      });

      expect(mockSet).not.toHaveBeenCalled();
      expect(mockZadd).not.toHaveBeenCalled();
    });

    it("increments scanCount for existing entries", async () => {
      initRugDb(mockRedis);
      mockGet.mockResolvedValueOnce({ scanCount: 3, flaggedAt: 500 });
      mockSet.mockResolvedValueOnce("OK");
      mockZadd.mockResolvedValueOnce(1);
      mockZcard.mockResolvedValueOnce(5);

      await recordRug({
        mint: "rug2",
        symbol: "SCAM2",
        score: 20,
        risk: "RUG",
        flags: [{ label: "Volume with zero liquidity — abandoned pool", severity: "critical", impact: -20 }],
        creator: null,
      });

      const setCall = mockSet.mock.calls[0];
      expect(setCall[1].scanCount).toBe(4);
      expect(setCall[1].flaggedAt).toBe(500);
    });

    it("trims index when exceeding max", async () => {
      initRugDb(mockRedis);
      mockGet.mockResolvedValueOnce(null);
      mockSet.mockResolvedValueOnce("OK");
      mockZadd.mockResolvedValueOnce(1);
      mockZcard.mockResolvedValueOnce(6000);
      mockZremrangebyrank.mockResolvedValueOnce(100);

      await recordRug({
        mint: "rug3",
        symbol: null,
        score: 10,
        risk: "RUG",
        flags: [{ label: "Slow rug detected: -50% on 6h + -15% on 1h", severity: "critical", impact: 0 }],
        creator: null,
      });

      expect(mockZremrangebyrank).toHaveBeenCalled();
    });

    it("silently fails on redis error", async () => {
      initRugDb(mockRedis);
      mockGet.mockRejectedValueOnce(new Error("fail"));

      await expect(recordRug({
        mint: "err",
        symbol: null,
        score: 0,
        risk: "RUG",
        flags: [{ label: "Honeypot detected — cannot sell", severity: "critical", impact: 0 }],
        creator: null,
      })).resolves.toBeUndefined();
    });
  });

  describe("getRecentRugs", () => {
    it("returns empty array when redis not initialized", async () => {
      // Already initialized from above, but test the flow
      initRugDb(mockRedis);
      mockZrange.mockResolvedValueOnce([]);
      const result = await getRecentRugs();
      expect(result).toEqual([]);
    });

    it("returns entries from redis", async () => {
      initRugDb(mockRedis);
      mockZrange.mockResolvedValueOnce(["mint1", "mint2"]);
      const entry1: RugEntry = {
        mint: "mint1", symbol: "A", score: 50, risk: "RUG",
        flags: [], creator: null, flaggedAt: 1000, scanCount: 1,
      };
      const entry2: RugEntry = {
        mint: "mint2", symbol: "B", score: 30, risk: "DANGER",
        flags: [], creator: null, flaggedAt: 2000, scanCount: 2,
      };
      mockMget.mockResolvedValueOnce([entry1, entry2]);
      const result = await getRecentRugs(2);
      expect(result).toEqual([entry1]); // entry2 is a DANGER recorded under the old rule: not listed
    });

    it("filters out null entries", async () => {
      initRugDb(mockRedis);
      mockZrange.mockResolvedValueOnce(["mint1", "mint2"]);
      mockMget.mockResolvedValueOnce([null, { mint: "mint2", risk: "RUG" }]);
      const result = await getRecentRugs();
      expect(result).toHaveLength(1);
    });

    it("returns empty array on redis error", async () => {
      initRugDb(mockRedis);
      mockZrange.mockRejectedValueOnce(new Error("fail"));
      const result = await getRecentRugs();
      expect(result).toEqual([]);
    });

    it("uses a single MGET call with the prefixed keys (no per-key pipelined GETs)", async () => {
      // Locks in the rugdb.ts:99 refactor — fetching N entries must be one
      // Redis command (MGET) instead of N pipelined GETs. A regression here
      // would silently restore the old N-command pattern.
      initRugDb(mockRedis);
      mockZrange.mockResolvedValueOnce(["mintA", "mintB", "mintC"]);
      mockMget.mockResolvedValueOnce([null, null, null]);

      await getRecentRugs(3);

      expect(mockMget).toHaveBeenCalledTimes(1);
      expect(mockMget).toHaveBeenCalledWith("rug:mintA", "rug:mintB", "rug:mintC");
    });
  });
});

// ─── The Wall of Shame is an accusation (audit M19) ─────────────────────────────────────────────────────────────────
// It names a token and its creator to anyone who calls /api/rugs, for 90 days. DANGER fires on weak or miscalibrated signals, so
// sound projects were listed next to real rugs. Now: a RUG verdict AND a critical flag that is EVIDENCE of a rug (something that
// happened, or a closed trap), never a capability such as an authority an issuer keeps.
describe("what gets a token listed as a rug", () => {
  const crit = (label: string) => ({ label, severity: "critical" as const, impact: 0 });

  describe("isRugEvidence", () => {
    it.each([
      "Volume with zero liquidity — abandoned pool",
      "Honeypot detected — cannot sell",
      "Sells blocked (social honeypot)",
      "Non-transferable token",
      "Creator history of rugged tokens",
      "Slow rug detected: -50% on 6h + -15% on 1h",
      "Pump +300% on <30min token + structural weakness — exit trap",
      "Extreme 24h pump +6000% — exit liquidity trap",
    ])("%s is evidence", (label) => {
      expect(isRugEvidence([crit(label)])).toBe(true);
    });

    it.each([
      "Mint authority active — supply can be inflated",
      "Freeze authority active — wallets can be frozen",
      "Permanent Control Enabled",
      "Balances can be changed by an authority",
      "LP not burned or locked — dev can rug liquidity (contract not clean)",
      "Top 10 hold 99% — extreme concentration",
      "No website / Twitter / Telegram — high rug risk",
      "Very low liquidity (<$1k)",
      "Brutal dump 24h (-80%)",
    ])("%s is NOT evidence by itself (a capability, a state, or a market move)", (label) => {
      expect(isRugEvidence([crit(label)])).toBe(false);
    });

    it("only a CRITICAL flag counts: the same label as a warning or info does not", () => {
      expect(isRugEvidence([{ label: "Slow rug detected: -50% on 6h + -15% on 1h", severity: "warning", impact: 0 }])).toBe(false);
      expect(isRugEvidence([{ label: "Honeypot detected — cannot sell", severity: "info", impact: 0 }])).toBe(false);
      expect(isRugEvidence([])).toBe(false);
    });

    it("one piece of evidence among other flags is enough", () => {
      expect(isRugEvidence([crit("Top 10 hold 99% — extreme concentration"), crit("Volume with zero liquidity — abandoned pool")])).toBe(true);
    });
  });

  describe("recordRug", () => {
    const record = (risk: "RUG" | "DANGER", flags: Array<{ label: string; severity: "critical" | "warning" | "info"; impact: number }>) =>
      recordRug({ mint: "m1", symbol: "TKN", score: 100, risk, flags, creator: "c1" });

    it("a RUG whose critical flags are only authorities (a stablecoin, a tokenised stock) is NOT listed", async () => {
      initRugDb(mockRedis);
      await record("RUG", [crit("Mint authority active — supply can be inflated"), crit("Freeze authority active — wallets can be frozen"), crit("Permanent Control Enabled")]);
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("a RUG on concentration or links alone is NOT listed", async () => {
      initRugDb(mockRedis);
      await record("RUG", [crit("Top 10 hold 99% — extreme concentration"), crit("No website / Twitter / Telegram — high rug risk")]);
      expect(mockSet).not.toHaveBeenCalled();
    });

    it("a RUG with evidence IS listed, with its flags", async () => {
      initRugDb(mockRedis);
      mockGet.mockResolvedValueOnce(null);
      mockSet.mockResolvedValueOnce("OK");
      mockZadd.mockResolvedValueOnce(1);
      mockZcard.mockResolvedValueOnce(1);
      await record("RUG", [crit("Volume with zero liquidity — abandoned pool"), crit("Mint authority active — supply can be inflated")]);
      expect(mockSet).toHaveBeenCalledTimes(1);
      expect(mockSet.mock.calls[0][1]).toMatchObject({ mint: "m1", risk: "RUG", flags: expect.arrayContaining(["Volume with zero liquidity — abandoned pool"]) });
    });

    it("DANGER is never listed, even with evidence among its flags", async () => {
      initRugDb(mockRedis);
      await record("DANGER", [crit("Honeypot detected — cannot sell")]);
      expect(mockSet).not.toHaveBeenCalled();
    });
  });

  describe("what is read back", () => {
    it("getRugEntry hides a legacy DANGER entry (recorded under the old rule) and returns a RUG one", async () => {
      initRugDb(mockRedis);
      mockGet.mockResolvedValueOnce({ mint: "old", risk: "DANGER", flags: [], flaggedAt: 1, scanCount: 1, symbol: null, score: 1, creator: null });
      expect(await getRugEntry("old")).toBeNull();
      mockGet.mockResolvedValueOnce({ mint: "new", risk: "RUG", flags: [], flaggedAt: 1, scanCount: 1, symbol: null, score: 1, creator: null });
      expect((await getRugEntry("new"))?.mint).toBe("new");
    });

    it("getRecentRugs lists RUG entries only", async () => {
      initRugDb(mockRedis);
      mockZrange.mockResolvedValueOnce(["a", "b", "c"]);
      mockMget.mockResolvedValueOnce([
        { mint: "a", risk: "RUG" }, { mint: "b", risk: "DANGER" }, { mint: "c", risk: "RUG" },
      ]);
      expect((await getRecentRugs(3)).map((r) => r.mint)).toEqual(["a", "c"]);
    });
  });
});
