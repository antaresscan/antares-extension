// __tests__/fixtures/fetch-double.ts
//
// The scan tests answer fetch() with light objects `{ ok, json() }`. fetchJson
// now reads the body through a real Response (text, content-length, stream), so
// a global fetch stub must hand it one. `stubFetch(mock)` keeps the tests as
// they were: they keep scripting `mock.mockImplementation(...)` with the light
// objects, and what reaches the code under test is a real Response.
import { vi } from "vitest";

type LightResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };

async function toResponse(r: unknown): Promise<unknown> {
  if (r instanceof Response || r == null || typeof (r as LightResponse).json !== "function") return r;
  const light = r as LightResponse;
  const body = await light.json();
  return new Response(JSON.stringify(body), { status: light.status ?? (light.ok ? 200 : 404) });
}

/** Install `mock` as the global fetch; its (light) answers are turned into real Responses. */
export function stubFetch(mock: (...args: unknown[]) => unknown): void {
  vi.stubGlobal("fetch", (...args: unknown[]) => Promise.resolve(mock(...args)).then(toResponse));
}
