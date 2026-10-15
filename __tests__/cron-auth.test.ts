// __tests__/cron-auth.test.ts
//
// api/_lib/cron-auth.ts: `Authorization: Bearer <CRON_SECRET>` is the one proof that Vercel started a scheduled job (audit A-28), compared in
// constant time, and closed when there is no secret. The last tests read the source: the sweep must not go back to a header a stranger can type.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hasCronSecret } from "../api/_lib/cron-auth";

const SECRET = "a-cron-secret-of-at-least-16-chars";
const req = (headers: Record<string, unknown>) => ({ headers }) as never;
const KEEP = process.env.CRON_SECRET;

beforeEach(() => { process.env.CRON_SECRET = SECRET; });
afterEach(() => { if (KEEP === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = KEEP; });

describe("hasCronSecret", () => {
  it("true for 'Bearer <secret>' exactly", () => {
    expect(hasCronSecret(req({ authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it("false for anything else: another secret, another length, another case, another scheme, no header", () => {
    for (const authorization of [
      "Bearer wrong", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, `bearer ${SECRET}`, `BEARER ${SECRET}`, `Basic ${SECRET}`,
      SECRET, ` Bearer ${SECRET}`, `Bearer ${SECRET} `, "Bearer ", "Bearer", "", undefined,
    ]) {
      expect(hasCronSecret(req({ authorization })), String(authorization)).toBe(false);
    }
    expect(hasCronSecret(req({}))).toBe(false);
  });

  it("false when the header is not a string (an array, a number, null) and nothing is thrown", () => {
    for (const authorization of [[`Bearer ${SECRET}`], 42, null, {}]) {
      expect(hasCronSecret(req({ authorization }))).toBe(false);
    }
    expect(hasCronSecret({} as never)).toBe(false); // no headers at all
  });

  it("the headers a stranger can type never open it", () => {
    expect(hasCronSecret(req({ "x-vercel-cron": "1" }))).toBe(false);
    expect(hasCronSecret(req({ "x-vercel-cron": "1", "x-vercel-cron-schedule": "0 0 * * *", "user-agent": "vercel-cron/1.0" }))).toBe(false);
  });

  it("with no CRON_SECRET on the deployment, nothing is authorised: the door is closed, never open", () => {
    delete process.env.CRON_SECRET;
    for (const authorization of ["Bearer ", "Bearer undefined", "Bearer", "", `Bearer ${SECRET}`, undefined]) {
      expect(hasCronSecret(req({ authorization })), String(authorization)).toBe(false);
    }
    process.env.CRON_SECRET = "";
    expect(hasCronSecret(req({ authorization: "Bearer " }))).toBe(false);
  });
});

describe("the source keeps it that way", () => {
  const src = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8").split(String.fromCharCode(13)).join("");
  // What is left of a file once its comments are gone: the guard reads the code, not the explanation of why it is written this way.
  const code = (file: string) => src(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the payment sweep asks hasCronSecret, and does not read x-vercel-cron any more", () => {
    const sweep = code("api/cron-check-payments.ts");
    expect(sweep).toMatch(/hasCronSecret\(req\)/);
    expect(sweep).not.toMatch(/x-vercel-cron/i);
  });

  it("the comparison is made in constant time, on equal-length digests, never with ===", () => {
    const helper = code("api/_lib/cron-auth.ts");
    expect(helper).toMatch(/timingSafeEqual\(a, b\)/);
    expect(helper).toMatch(/createHash\("sha256"\)/);
    expect(helper).not.toMatch(/authorization\s*===|===\s*`Bearer/);
  });
});
