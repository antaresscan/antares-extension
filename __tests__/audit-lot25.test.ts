// __tests__/audit-lot25.test.ts — Lot 25 of the file-by-file audit (2026-10-17): background.ts and the shared basics of the
// extension. Fails on the previous code.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

describe("background.ts — Sentry in the extension scrubs transactions too", () => {
  it("the browser SDK is given beforeSendTransaction -> scrubEvent, like the server (it sampled 10 % of transactions unscrubbed)", () => {
    const src = readFileSync("background.ts", "utf8");
    const init = src.slice(src.indexOf("sentryInit({"), src.indexOf("})", src.indexOf("sentryInit({")));
    expect(init).toMatch(/tracesSampleRate:/);
    expect(init).toMatch(/beforeSendTransaction:\s*\(event\)\s*=>\s*scrubEvent\(event\)/);
  });
});
