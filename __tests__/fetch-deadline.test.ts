// __tests__/fetch-deadline.test.ts
//
// The overlay waited for /api/scan with no limit: a server that never answered left the skeleton on screen until the page was
// closed. fetchWithDeadline gives the wait for the answer a deadline, still obeys the caller's own signal (navigation, new scan,
// session change), and never leaves a timer or a listener behind.
import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchWithDeadline, FETCH_TIMEOUT_MS } from "../shared/fetch-deadline"

const URL_API = "https://antares.example/api/scan?ca=X"

/** A fetch that never answers, and rejects like the real one when its signal aborts. */
function hangingFetch() {
  const seen: { signal?: AbortSignal } = {}
  const fn = vi.fn((_url: string, init?: RequestInit) => {
    seen.signal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const fail = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
      if (signal?.aborted) return fail()
      signal?.addEventListener("abort", fail, { once: true })
    })
  })
  vi.stubGlobal("fetch", fn)
  return { fn, seen }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("fetchWithDeadline", () => {
  it("gives up on a server that never answers, with an AbortError (which the scanner never retries)", async () => {
    hangingFetch()
    const caller = new AbortController()
    const err = await fetchWithDeadline(URL_API, {}, caller.signal, 50).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe("AbortError")
    expect((err as DOMException).message).toMatch(/No answer .* within 50 ms/)
    // the caller's own signal is untouched: this is a timeout, not a navigation
    expect(caller.signal.aborted).toBe(false)
  })

  it("waits longer than the 24 s the server gives a scan", () => {
    expect(FETCH_TIMEOUT_MS).toBeGreaterThan(24_000)
  })

  it("passes the answer through, with the headers the caller gave", async () => {
    const res = new Response("{}", { status: 200 })
    const fn = vi.fn(async () => res)
    vi.stubGlobal("fetch", fn)
    const out = await fetchWithDeadline(URL_API, { headers: { "X-Antares-Install": "abc" } }, new AbortController().signal, 1000)
    expect(out).toBe(res)
    const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.headers).toEqual({ "X-Antares-Install": "abc" })
  })

  it("leaves no timer behind once the answer is in, and no listener on the caller's signal", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))
    const caller = new AbortController()
    const remove = vi.spyOn(caller.signal, "removeEventListener")
    await fetchWithDeadline(URL_API, {}, caller.signal, 25_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  it("does not fire later on a request that already failed", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    await expect(fetchWithDeadline(URL_API, {}, new AbortController().signal, 25_000)).rejects.toThrow("Failed to fetch")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("follows the caller's signal: a navigation aborts the request at once", async () => {
    const { seen } = hangingFetch()
    const caller = new AbortController()
    const pending = fetchWithDeadline(URL_API, {}, caller.signal, 60_000).catch((e: unknown) => e)
    caller.abort()
    const err = (await pending) as DOMException
    expect(err.name).toBe("AbortError")
    expect(seen.signal?.aborted).toBe(true)
  })

  it("does not even wait when the caller has already aborted", async () => {
    hangingFetch()
    const caller = new AbortController()
    caller.abort()
    const t0 = Date.now()
    const err = (await fetchWithDeadline(URL_API, {}, caller.signal, 60_000).catch((e: unknown) => e)) as DOMException
    expect(err.name).toBe("AbortError")
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
