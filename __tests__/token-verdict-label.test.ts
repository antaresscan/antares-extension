import { describe, it, expect } from "vitest";
import { verdictLabel } from "../js/verdict-label.js";

// RUG is two things (API field rugKind): an event that happened to the token, or a structure that looks like a rug. The page used to
// print "RUG PULL" for both, which claimed an event the engine did not check.
describe("verdictLabel", () => {
  it("prints RUG CONFIRMED only when the API says an event happened", () => {
    expect(verdictLabel("RUG", "confirmed")).toBe("RUG CONFIRMED");
  });

  it("prints RUG RISK for a structural RUG, and for a scan cached before the field existed (no kind: the weaker claim)", () => {
    expect(verdictLabel("RUG", "risk")).toBe("RUG RISK");
    expect(verdictLabel("RUG", undefined)).toBe("RUG RISK");
    expect(verdictLabel("RUG", null)).toBe("RUG RISK");
  });

  it('never prints "RUG PULL", whatever the kind', () => {
    for (const kind of ["confirmed", "risk", null, undefined, "anything"]) {
      expect(verdictLabel("RUG", kind as string | null | undefined)).not.toMatch(/PULL/);
    }
  });

  it("witness: the other verdicts keep their word, whatever the kind says", () => {
    expect(verdictLabel("SAFE", "confirmed")).toBe("SAFE");
    expect(verdictLabel("CAUTION", "risk")).toBe("CAUTION");
    expect(verdictLabel("DANGER", "confirmed")).toBe("DANGER");
  });

  it("an unknown verdict is returned as it came, never invented", () => {
    expect(verdictLabel("WHATEVER", null)).toBe("WHATEVER");
  });
});
