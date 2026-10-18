import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// e2e/pro.ts: the specs that check the full analysis (api-engine-contract, api-pro-gate, api-scan, api-scan-structure, scan-integration, token-page-deep) ask as a Pro INSTALL, given by the
// environment variable E2E_PRO_INSTALL, and are SKIPPED without it, the run staying green. The variable has to reach the step that runs them: the workflow did not pass it, so those specs could
// never run in CI, whatever the secrets of the repository held.

const ci = readFileSync(".github/workflows/ci.yml", "utf8");

describe("the CI passes the Pro install to the e2e step", () => {
  it("the step that runs the API and integration e2e carries E2E_PRO_INSTALL, read from the secret of the same name", () => {
    const at = ci.indexOf("npx playwright test --project=api --project=integration");
    expect(at).toBeGreaterThan(-1);
    const stepEnd = ci.indexOf("\n      - ", at);
    const step = ci.slice(at, stepEnd === -1 ? undefined : stepEnd);
    expect(step).toMatch(/E2E_PRO_INSTALL:\s*\$\{\{\s*secrets\.E2E_PRO_INSTALL\s*\}\}/);
  });

  it("the secret is read in that one step only, and never printed", () => {
    expect(ci.match(/secrets\.E2E_PRO_INSTALL/g)).toHaveLength(1);
    expect(ci).not.toMatch(/echo[^\n]*E2E_PRO_INSTALL/);
  });
});
