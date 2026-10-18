// __tests__/audit-lot69.test.ts — Lot 69 of the file-by-file audit (2026-10-17): the replay never writes a credential into its corpus. Fails on the previous code.
//
// The capture script records every outgoing request of a real scan under a key built by exchangeKey (__tests__/replay/keys.ts), and the corpus
// is committed to the repository. redactUrl is what keeps the real Helius key (?api-key=) and the like out of those keys. keys.test.ts tested
// how the keys tell exchanges apart, not the redaction: it could be dropped, or miss a parameter, with the whole suite green.

import { describe, it, expect } from "vitest"
import { exchangeKey, redactUrl } from "./replay/keys"

const SECRET = "0123abcd-real-key-4567"

describe("redactUrl: no credential in a recorded key", () => {
  it.each([
    ["Helius", `https://mainnet.helius-rpc.com/?api-key=${SECRET}`],
    ["Helius REST", `https://api.helius.xyz/v0/transactions?api-key=${SECRET}&commitment=confirmed`],
    ["a ?key= (Gemini style)", `https://generativelanguage.googleapis.com/v1beta/models?key=${SECRET}`],
    ["an apikey", `https://example.com/v1?foo=1&apikey=${SECRET}`],
    ["a token", `https://example.com/v1?token=${SECRET}`],
    ["an access_token", `https://example.com/v1?access_token=${SECRET}#frag`],
    ["upper case", `https://example.com/v1?API-KEY=${SECRET}`],
  ])("%s: the value is replaced", (_name, url) => {
    const out = redactUrl(url)
    expect(out).not.toContain(SECRET)
    expect(out).toContain("REDACTED")
  })

  it("the rest of the address is kept, so two exchanges stay apart", () => {
    expect(redactUrl(`https://api.helius.xyz/v0/transactions?api-key=${SECRET}&commitment=confirmed`))
      .toBe("https://api.helius.xyz/v0/transactions?api-key=REDACTED&commitment=confirmed")
    expect(redactUrl("https://api.dexscreener.com/latest/dex/tokens/X")).toBe("https://api.dexscreener.com/latest/dex/tokens/X")
  })

  it("the key of an exchange, which the corpus stores, never holds the credential", () => {
    expect(exchangeKey("POST", `https://mainnet.helius-rpc.com/?api-key=${SECRET}`, `{"method":"getAccountInfo"}`)).not.toContain(SECRET)
  })
})
