import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as keys from "../api/_lib/keys";
import * as account from "../api/_lib/account";
import * as license from "../api/_lib/license";
import * as user from "../api/_lib/user";
import * as payments from "../api/_lib/payments";

// A Redis key is stored data: renaming one orphans every record written under the old name, with no error and no log. These tests pin the
// exact strings, check that every module that used to export a key still exports the very same function, and check that no other file
// writes the string again (license.ts used to keep a copy "to avoid a circular import", user.ts typed one inline twice).

describe("the keys are the strings the data was written under", () => {
  it("who a person is", () => {
    expect(keys.ACCOUNT_KEY("a@b.c")).toBe("account:a@b.c");
    expect(keys.ACCOUNT_INSTALL_KEY("inst-1")).toBe("account:install:inst-1");
  });

  it("what a person has", () => {
    expect(keys.TIER_KEY("inst-1")).toBe("user:inst-1:tier");
    expect(keys.TIER_EXPIRES_KEY("inst-1")).toBe("user:inst-1:tierExpires");
    expect(keys.HISTORY_KEY("inst-1")).toBe("user:inst-1:history");
  });

  it("licences (an e-mail is lower-cased and trimmed)", () => {
    expect(keys.LICENSE_KEY("ANT-XXXX")).toBe("license:ANT-XXXX");
    expect(keys.EMAIL_LICENSES_KEY("  Owner@Example.COM ")).toBe("email:licenses:owner@example.com");
    expect(keys.INTENT_LICENSE_KEY("ref-1")).toBe("intent:license:ref-1");
    expect(keys.INTENT_LICENSE_LOCK_KEY("ref-1")).toBe("intent:license-lock:ref-1");
  });

  it("payments", () => {
    expect(keys.INTENT_KEY("ref-1")).toBe("payment-intent:ref-1");
    expect(keys.INTENT_INDEX_KEY).toBe("payment-intents:pending");
    expect(keys.INTENT_BY_NP_PAYMENT_KEY("p1")).toBe("payment-intent-by-np:p1");
    expect(keys.INTENT_BY_NP_INVOICE_KEY("i1")).toBe("payment-intent-by-inv:i1");
  });
});

describe("every module that exported a key still exports the very same one", () => {
  it.each([
    ["account", account, ["ACCOUNT_KEY", "ACCOUNT_INSTALL_KEY"]],
    ["user", user, ["TIER_KEY", "TIER_EXPIRES_KEY", "HISTORY_KEY"]],
    ["license", license, ["LICENSE_KEY", "EMAIL_LICENSES_KEY", "INTENT_LICENSE_KEY", "INTENT_LICENSE_LOCK_KEY"]],
    ["payments", payments, ["INTENT_KEY", "INTENT_INDEX_KEY", "INTENT_BY_NP_PAYMENT_KEY", "INTENT_BY_NP_INVOICE_KEY"]],
  ] as Array<[string, Record<string, unknown>, string[]]>)("%s", (_name, mod, names) => {
    for (const n of names) expect(mod[n], n).toBe((keys as Record<string, unknown>)[n]);
  });
});

// ─── No other file writes the string ─────────────────────────────────────────────────────────────────────────────────────────
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** The code of a file, without the comments (a comment may name a key to explain it). */
function codeOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
}

describe("each shared key is written in one file only: keys.ts", () => {
  const apiDir = fileURLToPath(new URL("../api", import.meta.url));
  const files = sourceFiles(apiDir);
  const SHAPES = [
    "account:install:", "user:${", "email:licenses:", "intent:license:", "intent:license-lock:",
    "payment-intent:", "payment-intents:pending", "payment-intent-by-np:", "payment-intent-by-inv:",
  ];

  it("finds the api sources", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.endsWith("keys.ts"))).toBe(true);
  });

  it.each(SHAPES)("%s appears in the code of keys.ts and of no other file", (shape) => {
    const holders = files.filter((f) => codeOf(f).includes(shape)).map((f) => f.replace(apiDir, "api").replace(/\\/g, "/"));
    expect(holders).toEqual(["api/_lib/keys.ts"]);
  });
});
