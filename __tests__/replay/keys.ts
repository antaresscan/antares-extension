// __tests__/replay/keys.ts
//
// How one upstream exchange (an outgoing HTTP request of /api/scan) is identified. Shared by the capture script, which
// records the exchanges of a real scan, and by the replay harness, which serves them back. Anything secret is removed
// from the key: a recorded corpus is committed to the repository.

/** Replaces the value of query parameters that carry a credential (Helius `?api-key=`, Gemini `?key=`). */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:api-key|apikey|key|token|access_token)=)[^&#]*/gi, "$1REDACTED");
}

/**
 * `METHOD url body`: same request, same key. Headers are not part of it (they carry the credentials), except for ONE bit: whether
 * the request carried an `Authorization` header. GoPlus is asked twice when the authenticated call is rate limited (the same URL
 * with a token, then without): the replay has no credentials and only makes the anonymous call, which must get the anonymous answer.
 */
export function exchangeKey(method: string, url: string, body: string | null | undefined, authorized = false): string {
  return `${method.toUpperCase()} ${redactUrl(url)} ${body ?? ""}${authorized ? " #auth" : ""}`;
}
