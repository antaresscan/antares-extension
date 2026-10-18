// __tests__/audit-lot13.test.ts — Lot 13 of the file-by-file audit (2026-10-17): api/_lib/types.ts, upstream-schemas.ts,
// upstream-text.ts. Fails on the previous code.
import { describe, it, expect } from "vitest";
import { isRugCheckReport } from "../api/_lib/helpers";

describe("RugCheck /report — `topHolders: null` is a real answer, not a broken one", () => {
  it("a report with topHolders null is read (9 of the 1 117 real reports of the replay corpus were dropped whole)", () => {
    const report = {
      risks: [{ name: "Mutable metadata", value: "", description: "Token metadata can be changed by the owner", score: 100, level: "warn" }],
      topHolders: null,
      totalHolders: 1234,
      creator: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    };
    expect(isRugCheckReport(report)).toBe(true);
  });
});
