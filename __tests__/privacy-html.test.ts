import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Unit-test the canonical privacy policy by parsing privacy.html from the
// repository. Keeping these assertions out of the e2e suite is deliberate:
// e2e runs against the production URL in CI, which by construction lags the
// PR under review by one deploy. A content regression in a PR that touches
// privacy.html would silently pass e2e until after merge. Running the same
// invariants at build time catches drift before anything ships.

const privacyHtmlPath = join(__dirname, "..", "privacy.html");
const body = readFileSync(privacyHtmlPath, "utf-8");

describe("privacy.html structure", () => {
  it("is a valid HTML document", () => {
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("<html");
    expect(body).toContain("</html>");
  });

  it("has a Privacy Policy title", () => {
    expect(body).toContain("Privacy Policy");
  });

  it("has a last-updated date with a four-digit year", () => {
    expect(body).toMatch(/Last updated.*\d{4}/);
  });
});

describe("privacy.html GDPR / Chrome Web Store sections", () => {
  // Each heading below is load-bearing for GDPR Art. 13/14 disclosure or
  // for Chrome Web Store listing validation. If a section is renamed, both
  // the policy AND this file must be updated in the same commit.
  const requiredSections = [
    "Data we process",
    "Where the Extension injects",
    "Third-party processors",
    "International transfers",
    "Data retention",
    "Chrome permissions",
    "Your rights",
    "Children's privacy",
    "Security and disclosure",
    "Contact",
  ];

  for (const section of requiredSections) {
    it(`discloses the "${section}" section`, () => {
      expect(body).toContain(section);
    });
  }
});

describe("privacy.html processor disclosure (audit findings)", () => {
  // The audit specifically flagged Gemini, Upstash, and Vercel as missing.
  // Locking all of them in guards against accidental removal in future edits.
  // GitHub was historically listed because the source repo and the
  // Private Vulnerability Reporting flow lived there; the repo is now
  // private and security disclosure runs via email, so GitHub is no
  // longer a user-data processor and was removed from the table.
  const processors = [
    "Vercel",
    "Upstash",
    "Gemini",
    "Sentry",
    "DexScreener",
    "RugCheck",
    "GoPlus",
    "Helius",
    "Solscan",
    "GeckoTerminal",
  ];

  for (const processor of processors) {
    it(`names the processor "${processor}"`, () => {
      expect(body).toContain(processor);
    });
  }
});

describe("privacy.html injection hosts (manifest alignment)", () => {
  // Must match contents/antares-inject.ts `matches` and package.json
  // host_permissions after #280. Drift between these lists is how users end
  // up surprised by extension behaviour.
  const hosts = [
    "dexscreener.com",
    "birdeye.so",
    "pump.fun",
    "photon-sol.tinyastro.io",
    "axiom.trade",
    "gmgn.ai",
    "app.telemetry.io",
    "geckoterminal.com",
  ];

  for (const host of hosts) {
    it(`lists ${host} as a supported injection host`, () => {
      expect(body).toContain(host);
    });
  }

  it("does not silently keep the removed bullx hosts from #280", () => {
    expect(body).not.toContain("bullx.io");
  });
});

describe("privacy.html subject rights", () => {
  it("discloses each GDPR right the maintainer must respond to", () => {
    // Concrete rights a user can exercise under GDPR Art. 15–21 / CCPA.
    for (const right of ["Access", "Rectification", "Erasure", "Portability", "Objection"]) {
      expect(body).toContain(right);
    }
  });

  it("pins a response SLA", () => {
    expect(body).toMatch(/respond within\s*<strong>\s*30 days\s*<\/strong>/);
  });
});
