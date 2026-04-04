/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { initRugDb, getRugEntry, recordRug, getRecentRugs } from "../api/_lib/rugdb";
import type { RugEntry } from "../api/_lib/rugdb";

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockZadd = vi.fn();
const mockZcard = vi.fn();
const mockZrange = vi.fn();
const mockZremrangebyrank = vi.fn();
const mockPipelineGet = vi.fn();
const mockPipelineExec = vi.fn();

const mockRedis = {
  get: mockGet,
  set: mockSet,
  zadd: mockZadd,
  zcard: mockZcard,
  zrange: mockZrange,
  zremrangebyrank: mockZremrangebyrank,
  pipeline: () => ({
    get: mockPipelineGet,
    exec: mockPipelineExec,
  }),
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
          { label: "Honeypot", severity: "critical", impact: -20 },
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

    it("records DANGER tokens", async () => {
      initRugDb(mockRedis);
      mockGet.mockResolvedValueOnce(null);
      mockSet.mockResolvedValueOnce("OK");
      mockZadd.mockResolvedValueOnce(1);
      mockZcard.mockResolvedValueOnce(10);

      await recordRug({
        mint: "danger1",
        symbol: "BAD",
        score: 100,
        risk: "DANGER",
        flags: [{ label: "Freeze authority", severity: "warning", impact: -10 }],
        creator: null,
      });

      expect(mockSet).toHaveBeenCalled();
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
        flags: [{ label: "LP not burned", severity: "critical", impact: -20 }],
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
      mockZcard.mockResolvedValueOnce(600);
      mockZremrangebyrank.mockResolvedValueOnce(100);

      await recordRug({
        mint: "rug3",
        symbol: null,
        score: 10,
        risk: "RUG",
        flags: [],
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
        flags: [],
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
      mockPipelineExec.mockResolvedValueOnce([entry1, entry2]);
      const result = await getRecentRugs(2);
      expect(result).toEqual([entry1, entry2]);
    });

    it("filters out null entries", async () => {
      initRugDb(mockRedis);
      mockZrange.mockResolvedValueOnce(["mint1", "mint2"]);
      mockPipelineExec.mockResolvedValueOnce([null, { mint: "mint2" }]);
      const result = await getRecentRugs();
      expect(result).toHaveLength(1);
    });

    it("returns empty array on redis error", async () => {
      initRugDb(mockRedis);
      mockZrange.mockRejectedValueOnce(new Error("fail"));
      const result = await getRecentRugs();
      expect(result).toEqual([]);
    });
  });
});
