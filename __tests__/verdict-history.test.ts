import { describe, it, expect } from "vitest";
import { deriveEvent } from "../api/_lib/verdict-history";
import type { ScanFlag } from "../api/_lib/types";

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
