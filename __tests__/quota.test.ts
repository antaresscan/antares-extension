// __tests__/quota.test.ts — the X-Antares-Quota-* headers.
//
// There is no scan quota any more: every tier is unlimited. What api/_lib/quota.ts still does is
// say so on the wire, in the format the PUBLISHED extension (v1.3.22) reads — its overlay draws the
// PRO / YEAR / LIFE badge and the Free view from X-Antares-Quota-Tier and treats limit = -1 as
// unlimited. These tests pin that format, value by value, so that removing the dead counter code
// could not change what the extension receives.
import { describe, it, expect, vi } from "vitest";
import type { VercelResponse } from "@vercel/node";
import { setQuotaHeaders, unlimitedQuota } from "../api/_lib/quota";

const TIERS = ["free", "pro", "yearly", "lifetime"] as const;

function headersSetBy(fn: (res: VercelResponse) => void): Record<string, string> {
  const headers: Record<string, string> = {};
  const res = { setHeader: vi.fn((k: string, v: string) => void (headers[k] = v)) } as unknown as VercelResponse;
  fn(res);
  return headers;
}

describe("unlimitedQuota", () => {
  it.each(TIERS)("%s is unlimited, labelled with its own tier", (tier) => {
    expect(unlimitedQuota(tier)).toEqual({ used: 0, remaining: -1, limit: -1, resetAt: 0, tier });
  });
});

describe("setQuotaHeaders — the wire format the published extension reads", () => {
  it.each(TIERS)("%s: exactly the five headers, limit and remaining -1, used and reset 0", (tier) => {
    expect(headersSetBy((res) => setQuotaHeaders(res, unlimitedQuota(tier)))).toEqual({
      "X-Antares-Quota-Tier": tier,
      "X-Antares-Quota-Limit": "-1",
      "X-Antares-Quota-Used": "0",
      "X-Antares-Quota-Remaining": "-1",
      "X-Antares-Quota-Reset": "0",
    });
  });

  it("stamps what it is given (the headers carry numbers as plain strings)", () => {
    expect(
      headersSetBy((res) => setQuotaHeaders(res, { used: 12, remaining: 38, limit: 50, resetAt: 1714603199999, tier: "free" })),
    ).toEqual({
      "X-Antares-Quota-Tier": "free",
      "X-Antares-Quota-Limit": "50",
      "X-Antares-Quota-Used": "12",
      "X-Antares-Quota-Remaining": "38",
      "X-Antares-Quota-Reset": "1714603199999",
    });
  });

  it("never asks the caller to wait (no Retry-After): nothing here can refuse a scan", () => {
    const headers = headersSetBy((res) => setQuotaHeaders(res, unlimitedQuota("free")));
    expect(Object.keys(headers)).not.toContain("Retry-After");
  });
});
