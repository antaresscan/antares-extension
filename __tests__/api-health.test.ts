// __tests__/api-health.test.ts
//
// /api/health tells the owner why holder data may be missing without exposing
// the key: the shape of the HELIUS_API_KEY value and the statuses of the last
// Helius call. Production lost its holders and nothing could say why.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import handler from "../api/health";
import { _resetHeliusAuthForTests } from "../api/_lib/helius";

const UUID = "8c739183-1a2b-4c3d-8e4f-0123456789ab";

function call(): { body: Record<string, unknown>; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let body: Record<string, unknown> = {};
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (b: Record<string, unknown>) => {
      body = b;
    },
  } as unknown as VercelResponse;
  handler({} as VercelRequest, res);
  return { body, headers };
}

const saved = process.env.HELIUS_API_KEY;

beforeEach(() => {
  _resetHeliusAuthForTests();
});

afterEach(() => {
  if (saved === undefined) delete process.env.HELIUS_API_KEY;
  else process.env.HELIUS_API_KEY = saved;
});

describe("GET /api/health", () => {
  it("keeps the fields the e2e suite relies on", () => {
    delete process.env.HELIUS_API_KEY;
    const { body, headers } = call();

    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof body.timestamp).toBe("number");
    expect(headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("is never cached", () => {
    expect(call().headers["Cache-Control"]).toBe("no-store");
  });

  it("says the Helius key is missing when it is not set", () => {
    delete process.env.HELIUS_API_KEY;

    expect((call().body.helius as { key: { shape: string } }).key.shape).toBe("missing");
  });

  it("reports a clean UUID", () => {
    process.env.HELIUS_API_KEY = UUID;

    const h = call().body.helius as { key: Record<string, unknown>; authMode: string; lastRpc: unknown };
    expect(h.key).toMatchObject({ shape: "uuid", repaired: false, usableLooksLikeUuid: true, length: 36 });
    expect(h.authMode).toBe("bearer");
    expect(h.lastRpc).toBeNull();
  });

  it("tells the owner when the whole RPC URL was pasted", () => {
    process.env.HELIUS_API_KEY = `https://mainnet.helius-rpc.com/?api-key=${UUID}`;

    const h = call().body.helius as { key: Record<string, unknown> };
    expect(h.key).toMatchObject({ shape: "is-url", repaired: true, usableLooksLikeUuid: true });
  });

  it("never exposes any part of the key", () => {
    process.env.HELIUS_API_KEY = `https://mainnet.helius-rpc.com/?api-key=${UUID}`;

    const out = JSON.stringify(call().body);
    expect(out).not.toContain(UUID);
    expect(out).not.toContain(UUID.slice(0, 8));
    expect(out).not.toContain("api-key");
  });
});
