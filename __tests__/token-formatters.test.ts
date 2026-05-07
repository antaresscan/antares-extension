// __tests__/token-formatters.test.ts — Coverage for the pure formatters
// extracted out of js/token-app.js.
//
// Why this matters: prior to the extraction these helpers were buried
// in a 1700-line script-tag file with no module system. Two `formatAge`
// declarations (hours-input vs minutes-input) coexisted at script
// scope — the later one silently overrode the earlier one for every
// call site, so the on-chain Token Age cell was rendering hours as if
// they were minutes. The split into `js/formatters.js` gave them
// distinct names (`formatAgeHours` / `formatAgeMin`) so each call site
// is now explicit. These tests pin the contract of both.
import { describe, it, expect } from "vitest";
import {
  fmt,
  pct,
  age,
  fmtPrice,
  formatAgeHours,
  formatAgeMin,
  escapeHtml,
  fmtUsd,
  fmtTok,
  getFlagDescription,
  FLAG_DESCRIPTIONS,
} from "../js/formatters.js";

describe("fmt", () => {
  it("returns em-dash for null/undefined", () => {
    expect(fmt(null)).toBe("—");
    expect(fmt(undefined)).toBe("—");
  });
  it("formats with B/M/K suffixes", () => {
    expect(fmt(2_500_000_000)).toBe("$2.50B");
    expect(fmt(1_500_000)).toBe("$1.50M");
    expect(fmt(1_500)).toBe("$1.5K");
    expect(fmt(123)).toBe("$123");
  });
  it("rounds the trailing decimals deterministically", () => {
    expect(fmt(1234)).toBe("$1.2K");
    expect(fmt(999_999)).toBe("$1000.0K");
  });
});

describe("pct", () => {
  it("returns neutral em-dash for null", () => {
    expect(pct(null)).toEqual({ txt: "—", cls: "neu" });
  });
  it("prefixes positive deltas with +", () => {
    expect(pct(2.5)).toEqual({ txt: "+2.50%", cls: "up" });
  });
  it("preserves negative sign without doubling it", () => {
    expect(pct(-3.7)).toEqual({ txt: "-3.70%", cls: "dn" });
  });
  it("classifies exact zero as neutral", () => {
    expect(pct(0)).toEqual({ txt: "0.00%", cls: "neu" });
  });
});

describe("age", () => {
  it("returns null for falsy input", () => {
    expect(age(null)).toBeNull();
    expect(age(0)).toBeNull();
    expect(age(undefined)).toBeNull();
  });
  it("renders hours under 24 with the 'old' suffix", () => {
    expect(age(5)).toBe("5h old");
    expect(age(23)).toBe("23h old");
  });
  it("renders days between 1 and 30", () => {
    expect(age(48)).toBe("2d old");
    expect(age(24 * 29)).toBe("29d old");
  });
  it("renders months past 30 days", () => {
    expect(age(24 * 30)).toBe("1mo old");
    expect(age(24 * 90)).toBe("3mo old");
  });
});

describe("fmtPrice", () => {
  it("returns em-dash for falsy input", () => {
    expect(fmtPrice(null)).toBe("—");
    expect(fmtPrice(0)).toBe("—");
  });
  it("uses scientific notation below 0.000001", () => {
    expect(fmtPrice(0.00000023)).toBe("$2.30e-7");
  });
  it("uses 6 decimals between 0.000001 and 0.01", () => {
    expect(fmtPrice(0.001234)).toBe("$0.001234");
  });
  it("uses 4 decimals between 0.01 and 1", () => {
    expect(fmtPrice(0.5)).toBe("$0.5000");
  });
  it("uses 2 decimals at 1 and above", () => {
    expect(fmtPrice(1234.56)).toBe("$1234.56");
  });
});

describe("formatAgeHours (the hours-input variant — formerly the SHADOWED first declaration)", () => {
  it("returns null for nullish input but allows zero", () => {
    expect(formatAgeHours(null)).toBeNull();
    expect(formatAgeHours(undefined)).toBeNull();
    expect(formatAgeHours(0)).toBe("0m");
  });
  it("renders sub-hour input as minutes", () => {
    expect(formatAgeHours(0.5)).toBe("30m");
    expect(formatAgeHours(0.083)).toBe("5m");
  });
  it("renders hours under 24", () => {
    expect(formatAgeHours(5)).toBe("5h");
    expect(formatAgeHours(23.4)).toBe("23h");
  });
  it("renders whole-day inputs", () => {
    expect(formatAgeHours(48)).toBe("2d");
    expect(formatAgeHours(72)).toBe("3d");
  });
  it("appends remaining hours when not divisible by 24", () => {
    expect(formatAgeHours(28)).toBe("1d 4h");
    expect(formatAgeHours(750)).toBe("31d 6h");
  });
});

describe("formatAgeMin (the minutes-input variant — was the SHADOWING second declaration)", () => {
  it("returns em-dash for non-finite input", () => {
    expect(formatAgeMin(NaN)).toBe("—");
    expect(formatAgeMin(Infinity)).toBe("—");
    expect(formatAgeMin("12" as unknown as number)).toBe("—");
  });
  it("renders sub-minute as 'just now'", () => {
    expect(formatAgeMin(0)).toBe("just now");
    expect(formatAgeMin(0.5)).toBe("just now");
  });
  it("renders minutes below 60", () => {
    expect(formatAgeMin(45)).toBe("45min");
  });
  it("renders hours below 24", () => {
    expect(formatAgeMin(120)).toBe("2h");
  });
  it("renders days past 24h", () => {
    expect(formatAgeMin(60 * 24 * 3)).toBe("3d");
  });
});

describe("escapeHtml", () => {
  it("returns empty string for falsy input", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml("")).toBe("");
  });
  it("escapes the standard HTML entities", () => {
    expect(escapeHtml(`<script>alert("x'y")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&#39;y&quot;)&lt;/script&gt;",
    );
  });
  it("coerces non-strings before escaping", () => {
    expect(escapeHtml(123)).toBe("123");
  });
});

describe("fmtUsd", () => {
  it("renders M/K thresholds with sign-bearing magnitude", () => {
    expect(fmtUsd(2_500_000)).toBe("$2.50M");
    expect(fmtUsd(-2_500_000)).toBe("$-2.50M");
    expect(fmtUsd(1500)).toBe("$1.5K");
    expect(fmtUsd(-1500)).toBe("$-1.5K");
  });
  it("renders bare dollars under 1K with abs value", () => {
    expect(fmtUsd(123)).toBe("$123");
    expect(fmtUsd(-456)).toBe("$456");
  });
});

describe("fmtTok", () => {
  it("returns em-dash for non-finite input", () => {
    expect(fmtTok(NaN)).toBe("—");
    expect(fmtTok(Infinity)).toBe("—");
    expect(fmtTok(null as unknown as number)).toBe("—");
  });
  it("renders M/K thresholds without dollar prefix", () => {
    expect(fmtTok(2_500_000)).toBe("2.50M");
    expect(fmtTok(1500)).toBe("1.5K");
    expect(fmtTok(123)).toBe("123");
  });
});

describe("getFlagDescription", () => {
  it("returns the canonical description on exact match", () => {
    expect(getFlagDescription("Honeypot detected — cannot sell")).toBe(
      FLAG_DESCRIPTIONS["Honeypot detected — cannot sell"],
    );
  });
  it("falls back to a prefix match for label suffixes", () => {
    // "Single wallet holds 18% of supply" should match the "Single wallet holds" key
    expect(getFlagDescription("Single wallet holds 18% of supply")).toBe(
      FLAG_DESCRIPTIONS["Single wallet holds"],
    );
  });
  it("returns null when nothing matches", () => {
    expect(getFlagDescription("This is not a known flag at all")).toBeNull();
  });
});
