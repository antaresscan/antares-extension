// shared/fetch-deadline.ts
//
// fetch() with a deadline for the answer, still obeying the caller's own signal.
//
// The overlay used to wait for /api/scan with no limit at all: a server that never answers (or a network that swallows the request)
// left the skeleton on screen until the page was closed. The server stops a scan at 24 s (GLOBAL_TIMEOUT_MS in api/scan.ts), so
// an answer that has not started after FETCH_TIMEOUT_MS is not coming.
//
// Not AbortSignal.any / AbortSignal.timeout: the extension does not require a recent Chrome (they need 116 / 103), and a missing
// function would break every scan instead of improving one. Two listeners and a timer do the same.
//
// The deadline covers the wait for the HEADERS, which is where a scan hangs: /api/scan answers with one small JSON body, sent with
// its headers. It is cleared as soon as they arrive.

/** Longer than the 24 s the server gives a scan, so a slow-but-alive answer is never cut. */
export const FETCH_TIMEOUT_MS = 25_000

export function fetchWithDeadline(
  url: string,
  init: Omit<RequestInit, "signal">,
  signal: AbortSignal,
  ms: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const attempt = new AbortController()
  const abortFromCaller = () => attempt.abort()
  if (signal.aborted) attempt.abort()
  else signal.addEventListener("abort", abortFromCaller, { once: true })
  // An AbortError on purpose: the retry loop of the scanner never retries one (a hung server asked three more times is 100 s of
  // skeleton), and the overlay shows its error state with the retry button.
  const timer = setTimeout(
    () => attempt.abort(new DOMException(`No answer from the Antares API within ${ms} ms`, "AbortError")),
    ms,
  )
  return fetch(url, { ...init, signal: attempt.signal }).finally(() => {
    clearTimeout(timer)
    signal.removeEventListener("abort", abortFromCaller)
  })
}
