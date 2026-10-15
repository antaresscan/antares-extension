// __tests__/log-ref.test.ts
//
// No log line holds an e-mail address (GDPR: an address is personal data, and the logs are kept by Vercel and read by whoever debugs).
// A line says "the same account as a minute ago" with a reference (api/_lib/log-ref.ts); and the logger itself rewrites any address that
// slips through into "[email]". The same goes for a licence key, which is a credential (whoever holds one can redeem it on an install of their
// own): a log line shows its first 8 characters. The last tests read the source of api/ and fail if a log call writes an address or a key again.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emailRef, maskLicenseKey, redactEmails, redactLicenseKeys } from "../api/_lib/log-ref";
import { logger } from "../api/_lib/logger";

const SECRET = "s".repeat(40);
const KEEP = { LOG_PEPPER: process.env.LOG_PEPPER, SESSION_SECRET: process.env.SESSION_SECRET };

beforeEach(() => {
  delete process.env.LOG_PEPPER;
  process.env.SESSION_SECRET = SECRET;
});
afterEach(() => {
  if (KEEP.LOG_PEPPER === undefined) delete process.env.LOG_PEPPER; else process.env.LOG_PEPPER = KEEP.LOG_PEPPER;
  if (KEEP.SESSION_SECRET === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = KEEP.SESSION_SECRET;
  vi.restoreAllMocks();
});

describe("emailRef", () => {
  it("is 12 hexadecimal characters, and does not contain the address", () => {
    const ref = emailRef("someone@example.com");
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(ref).not.toContain("someone");
    expect(ref).not.toContain("example");
  });

  it("is the same for the same address, whatever its case or spacing, and different for another address", () => {
    const a = emailRef("someone@example.com");
    expect(emailRef("  Someone@Example.COM ")).toBe(a);
    expect(emailRef("other@example.com")).not.toBe(a);
  });

  it("an absent address stays absent: null for what is not a non-empty string", () => {
    for (const v of [null, undefined, "", "   ", 42, {}, []]) expect(emailRef(v)).toBeNull();
  });

  it("depends on the key: another SESSION_SECRET or a LOG_PEPPER gives another reference", () => {
    const base = emailRef("someone@example.com");
    process.env.SESSION_SECRET = "t".repeat(40);
    expect(emailRef("someone@example.com")).not.toBe(base);
    process.env.LOG_PEPPER = "p".repeat(24);
    const pepper = emailRef("someone@example.com");
    expect(pepper).toMatch(/^[0-9a-f]{12}$/);
    expect(pepper).not.toBe(base);
  });

  it("LOG_PEPPER wins over SESSION_SECRET: rotating the session key does not change the references", () => {
    process.env.LOG_PEPPER = "p".repeat(24);
    const before = emailRef("someone@example.com");
    process.env.SESSION_SECRET = "u".repeat(40);
    expect(emailRef("someone@example.com")).toBe(before);
  });

  it("a LOG_PEPPER that is too short is ignored (the session key is used)", () => {
    const viaSession = emailRef("someone@example.com");
    process.env.LOG_PEPPER = "short";
    expect(emailRef("someone@example.com")).toBe(viaSession);
  });

  it("with no key at all it writes the word 'unkeyed': a plain hash of an address can be tested against a list of addresses", () => {
    delete process.env.SESSION_SECRET;
    expect(emailRef("someone@example.com")).toBe("unkeyed");
  });
});

describe("redactEmails and the logger", () => {
  it("replaces every address in a text", () => {
    expect(redactEmails("a@b.co then First.Last+tag@sub.example.org!")).toBe("[email] then [email]!");
    expect(redactEmails("no address here, a mint 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump")).toBe("no address here, a mint 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump");
  });

  it("the logger never writes an address, in a message, in a field, in an error, in a metric", () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(String(s)); });
    vi.spyOn(console, "warn").mockImplementation((s: string) => { out.push(String(s)); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { out.push(String(s)); });

    logger.metric("auth.signup", { who: "victim@example.com" });
    logger.warn("x", "lookup failed for victim@example.com", { nested: { deep: "victim@example.com" } });
    logger.error("x", "boom", { error: String(new Error("no account victim@example.com")) });

    expect(out).toHaveLength(3);
    for (const line of out) {
      expect(line).not.toContain("victim");
      expect(line).toContain("[email]");
    }
  });

  it("a log line stays valid JSON after the rewrite", () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(String(s)); });
    logger.metric("e", { who: "victim@example.com", n: 1 });
    expect(JSON.parse(out[0])).toMatchObject({ level: "metric", event: "e", who: "[email]", n: 1 });
  });
});

describe("licence keys", () => {
  const KEY = "ANT-7K2M-QX9P-4DHT-WV3R";

  it("maskLicenseKey keeps the first 8 characters and an ellipsis, nothing more", () => {
    expect(maskLicenseKey(KEY)).toBe("ANT-7K2M\u2026");
    expect(maskLicenseKey(`  ${KEY} `)).toBe("ANT-7K2M\u2026");
    expect(maskLicenseKey(KEY)).not.toContain("QX9P");
  });

  it("an absent key stays absent: null for what is not a non-empty string", () => {
    for (const v of [null, undefined, "", "   ", 42, {}, []]) expect(maskLicenseKey(v)).toBeNull();
  });

  it("redactLicenseKeys cuts every whole key in a text, and leaves the rest alone", () => {
    expect(redactLicenseKeys(`a ${KEY} then ANT-AAAA-BBBB-CCCC-DDDD.`)).toBe("a ANT-7K2M\u2026 then ANT-AAAA\u2026.");
    expect(redactLicenseKeys("no key here, a mint 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump, ANT-1234 is too short")).toBe(
      "no key here, a mint 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump, ANT-1234 is too short",
    );
  });

  it("the logger never writes a whole key, in a message, in a field, in an error, in a metric, and the line stays valid JSON", () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(String(s)); });
    vi.spyOn(console, "warn").mockImplementation((s: string) => { out.push(String(s)); });
    vi.spyOn(console, "error").mockImplementation((s: string) => { out.push(String(s)); });

    logger.metric("redeem.success", { licenseKey: KEY });
    logger.warn("x", `no licence ${KEY}`, { nested: { deep: KEY } });
    logger.error("x", "boom", { error: String(new Error(`bad key ${KEY}`)) });

    expect(out).toHaveLength(3);
    for (const line of out) {
      expect(line).not.toContain("QX9P");
      expect(line).toContain("ANT-7K2M\u2026");
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("the logger still cuts an address and a key in the same line", () => {
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((s: string) => { out.push(String(s)); });
    logger.metric("e", { who: "victim@example.com", licenseKey: KEY });
    expect(JSON.parse(out[0])).toMatchObject({ who: "[email]", licenseKey: "ANT-7K2M\u2026" });
  });
});

// ── The guard: the source of api/ writes no address in a log call.
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Removes the calls to `name`( ... ), parentheses balanced, so what is left is what a log call writes by itself. */
function withoutCallsTo(name: string, call: string): string {
  let s = call;
  for (;;) {
    const i = s.indexOf(`${name}(`);
    if (i === -1) return s;
    let depth = 0;
    let j = i + name.length;
    for (; j < s.length; j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")" && --depth === 0) break;
    }
    s = s.slice(0, i) + s.slice(j + 1);
  }
}

/** The text of the quoted strings is a label ("install bound to a different email"), not a value: only the code around it can write an address. */
function withoutStringText(code: string): string {
  return code
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, (t) => (t.match(/\$\{[^}]*\}/g) ?? []).join(" "));
}

describe("no log call of api/ writes an e-mail address or a licence key", () => {
  const calls: Array<{ where: string; text: string }> = [];
  for (const file of sources("api")) {
    const src = readFileSync(file, "utf8").split(String.fromCharCode(13)).join("");
    const re = /\b(?:logger\.(?:info|warn|error|metric|debug)|captureError|captureMessage|console\.(?:log|info|warn|error))\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      let i = m.index + m[0].length;
      let depth = 1;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      calls.push({ where: `${file}:${src.slice(0, m.index).split("\n").length}`, text: src.slice(m.index, i) });
    }
  }

  it("finds the log calls (the guard is not blind)", () => {
    expect(calls.length).toBeGreaterThan(100);
    expect(calls.some((c) => c.text.includes("emailRef("))).toBe(true);
  });

  it("none of them mentions an address, except through emailRef (a boolean 'has an address' is fine)", () => {
    const offenders = calls
      .map((c) => ({
        where: c.where,
        rest: withoutStringText(withoutCallsTo("emailRef", c.text))
          .replace(/\bemailRef\b|\b[a-zA-Z]+Ref\b/g, "") // the keys that hold a reference
          .replace(/hasEmail:\s*!!\s*[\w.]+/g, "") //       a boolean
          .replace(/authedEmail\s*\?/g, ""), //              a test, not a value
      }))
      .filter((c) => /email/i.test(c.rest));
    expect(offenders.map((o) => o.where), "a log call writes an e-mail address: log emailRef(address) (api/_lib/log-ref.ts) instead").toEqual([]);
  });

  it("none of them writes a licence key, except through maskLicenseKey (a test 'a key was issued' is fine)", () => {
    const offenders = calls
      .map((c) => ({
        where: c.where,
        // "key: maskLicenseKey(...)" is a masked key whole (its field name included); what is left is what a log call writes by itself.
        rest: withoutStringText(withoutCallsTo("maskLicenseKey", c.text.replace(/\b\w+\s*:\s*(?=maskLicenseKey\()/g, "")))
          .replace(/licenseKey\s*!==?\s*null/g, ""), // a test, not a value
      }))
      .filter((c) => /\blicenseKey\b|\blicense\.key\b|\bexisting(?:Key|\.key)\b|\bkey\s*:/.test(c.rest));
    expect(offenders.map((o) => o.where), "a log call writes a licence key: log maskLicenseKey(key) (api/_lib/log-ref.ts) instead").toEqual([]);
  });
});
