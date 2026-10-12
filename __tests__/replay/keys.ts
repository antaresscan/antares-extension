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
  return canonicalKey(`${method.toUpperCase()} ${redactUrl(url)} ${body ?? ""}${authorized ? " #auth" : ""}`);
}

/**
 * The 4-hour candle request of GeckoTerminal asks for as many candles as the engine wants (182, then 1000 for the collapse rule): that
 * number is not what identifies the exchange, so it is replaced by `*`. A recording made with an older number still answers the request
 * of today (it holds the candles it was given: about 30 days), and the replay needs no new capture to follow a change of that number.
 */
export function canonicalKey(key: string): string {
  return key.replace(/(\/ohlcv\/hour\?aggregate=4&limit=)\d+/, "$1*");
}
