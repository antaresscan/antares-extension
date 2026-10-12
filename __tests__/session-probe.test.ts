import { describe, it, expect } from "vitest";
import { isSessionRejected } from "../shared/session-probe";

// Audit A-20: the Options page dropped the stored session token on ANY non-OK answer of /api/auth/me.
describe("isSessionRejected", () => {
  it("is true for a 401 only: the token is dead, drop it", () => {
    expect(isSessionRejected(401)).toBe(true);
  });

  it("is false for every other failure, which says nothing about the token", () => {
    for (const status of [400, 403, 404, 408, 429, 500, 502, 503, 504]) {
      expect(isSessionRejected(status), String(status)).toBe(false);
    }
  });

  it("is false for success", () => {
    expect(isSessionRejected(200)).toBe(false);
  });
});
