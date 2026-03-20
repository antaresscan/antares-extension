import { describe, it, expect } from "vitest";
import { asNumber, _mean, _std, _pct, makeFlag, computeCacheTTL } from "../api/helpers";

describe("asNumber", () => {
  it("returns number directly", () => {
    expect(asNumber(42)).toBe(42);
  });
  it("parses string float", () => {
    expect(asNumber("3.14")).toBeCloseTo(3.14);
  });
  it("returns 0 for undefined", () => {
    expect(asNumber(undefined)).toBe(0);
  });
  it("returns 0 for NaN", () => {
    expect(asNumber(NaN)).toBe(0);
  });
  it("returns 0 for non-numeric string", () => {
    expect(asNumber("abc")).toBe(0);
  });
});

describe("_mean", () => {
  it("returns 0 for empty array", () => {
    expect(_mean([])).toBe(0);
  });
  it("returns single element", () => {
    expect(_mean([10])).toBe(10);
  });
  it("calculates mean of array", () => {
    expect(_mean([2, 4, 6])).toBe(4);
  });
});

describe("_std", () => {
  it("returns 0 for constant array", () => {
    expect(_std([5, 5, 5])).toBe(0);
  });
});

describe("_pct", () => {
  it("returns 0 when from is 0 (division guard)", () => {
    expect(_pct(0, 100)).toBe(0);
  });
  it("calculates percentage change", () => {
    expect(_pct(100, 150)).toBe(50);
  });
});

describe("makeFlag", () => {
  it("creates flag object", () => {
    expect(makeFlag("test", "warning", 5)).toEqual({
      label: "test",
      severity: "warning",
      impact: 5,
    });
  });
});

describe("computeCacheTTL", () => {
  it("returns 20 for null", () => {
    expect(computeCacheTTL(null)).toBe(20);
  });
  it("returns 15 for age < 60", () => {
    expect(computeCacheTTL(30)).toBe(15);
  });
  it("returns 30 for age 60-1440", () => {
    expect(computeCacheTTL(120)).toBe(30);
  });
  it("returns 120 for age > 1440", () => {
    expect(computeCacheTTL(2000)).toBe(120);
  });
});
