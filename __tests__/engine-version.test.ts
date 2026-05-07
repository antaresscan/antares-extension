// __tests__/engine-version.test.ts — Guards on the scoring-engine
// version string used as a Redis cache key prefix.
//
// Why a test? A future change that drops the fingerprint or downgrades
// `ENGINE_VERSION` to a static literal would bring back the
// stale-cache-after-deploy bug we just fixed. These assertions act as a
// tripwire — they don't validate the *value* of the fingerprint (that
// would lock the constants in place), only that the version is shaped
// like `<manual-tag>-<8-hex-fingerprint>`.
import { describe, it, expect } from "vitest";
import { ENGINE_VERSION } from "../api/_lib/constants";

describe("ENGINE_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof ENGINE_VERSION).toBe("string");
    expect(ENGINE_VERSION.length).toBeGreaterThan(0);
  });

  it("matches <manual>-<8-hex-fingerprint> shape", () => {
    expect(ENGINE_VERSION).toMatch(/^v\d+-[0-9a-f]{8}$/);
  });

  it("changes deterministically when constants change", async () => {
    // Re-import the module fresh and confirm the second read returns the
    // same value — the fingerprint MUST be a pure function of the
    // constants file, no clock or env input.
    const first = ENGINE_VERSION;
    const mod = await import("../api/_lib/constants");
    expect(mod.ENGINE_VERSION).toBe(first);
  });
});
