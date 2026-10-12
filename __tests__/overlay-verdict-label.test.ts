import { describe, it, expect } from "vitest";
import { verdictLabel } from "../contents/modules/verdict-label";
import { ScanResponseDataSchema } from "../shared/schemas";

// RUG is two things (API field rugKind): an event that happened to the token, or a structure that looks like a rug. The overlay used to
// print "RUG PULL" for both, which claimed an event the engine did not check. Same rule as js/verdict-label.js on the token page.
describe("overlay verdictLabel", () => {
  it("prints RUG PULL only when the API says an event happened", () => {
    expect(verdictLabel("RUG", "confirmed")).toBe("RUG PULL");
  });

  it("prints RUG RISK for a structural RUG, and for a scan cached before the field existed (no kind: the weaker claim)", () => {
    expect(verdictLabel("RUG", "risk")).toBe("RUG RISK");
    expect(verdictLabel("RUG", undefined)).toBe("RUG RISK");
    expect(verdictLabel("RUG", null)).toBe("RUG RISK");
  });

  it('prints "RUG PULL" for that one kind and for no other: it claims an event', () => {
    for (const kind of ["risk", null, undefined, "anything", "CONFIRMED"]) {
      expect(verdictLabel("RUG", kind)).toBe("RUG RISK");
    }
  });

  it("never prints the long word: RUG CONFIRMED does not fit the overlay", () => {
    for (const kind of ["confirmed", "risk", null, undefined]) {
      expect(verdictLabel("RUG", kind).length).toBeLessThanOrEqual("RUG PULL".length);
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

// Zod drops the keys a schema does not know, so the field has to be in the contract or the overlay would never see it.
describe("ScanResponseDataSchema and rugKind", () => {
  const base = { score: 100, risk: "RUG", flags: [] };

  it("keeps rugKind through the parse", () => {
    expect(ScanResponseDataSchema.parse({ ...base, rugKind: "confirmed" }).rugKind).toBe("confirmed");
    expect(ScanResponseDataSchema.parse({ ...base, rugKind: "risk" }).rugKind).toBe("risk");
  });

  it("accepts a scan with no rugKind (an older cached scan) and a null one", () => {
    expect(ScanResponseDataSchema.parse(base).rugKind).toBeUndefined();
    expect(ScanResponseDataSchema.parse({ ...base, rugKind: null }).rugKind).toBeNull();
  });

  it("witness: an unknown future value does not fail the whole parse", () => {
    expect(ScanResponseDataSchema.safeParse({ ...base, rugKind: "something-new" }).success).toBe(true);
  });
});
