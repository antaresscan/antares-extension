// @vitest-environment happy-dom
// __tests__/audit-lot66.test.ts — Lot 66 of the file-by-file audit (2026-10-17): the site adapters that had no test of what they find. Fails on the previous code.
//
// Five of the nine site adapters (GMGN, GeckoTerminal, Photon, Axiom, Telemetry) had no test that they find the token of a token page, and
// GMGN / GeckoTerminal none that they leave the other pages alone: their page rules could be dropped with the whole suite green. Without the
// GMGN rule a WALLET page (gmgn.ai/sol/address/{wallet}) would be scanned as if the wallet were a token; without the GeckoTerminal or Photon
// rule their token pages would never be scanned at all.

import { describe, it, expect, afterEach } from "vitest"
import { getAdapter } from "../contents/modules/adapters"
import { GMGNAdapter } from "../contents/modules/adapters/gmgn.adapter"
import { GeckoTerminalAdapter } from "../contents/modules/adapters/geckoterminal.adapter"
import { PhotonAdapter } from "../contents/modules/adapters/photon.adapter"
import { AxiomAdapter } from "../contents/modules/adapters/axiom.adapter"
import { TelemetryAdapter } from "../contents/modules/adapters/telemetry.adapter"

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
const POOL = "5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9" // Bonk / SOL on Orca
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"

afterEach(() => { document.body.innerHTML = "" })

describe("which adapter answers which site", () => {
  it.each([
    ["gmgn.ai", "GMGN"],
    ["www.geckoterminal.com", "GeckoTerminal"],
    ["photon-sol.tinyastro.io", "Photon"],
    ["axiom.trade", "Axiom"],
    ["app.telemetry.io", "Telemetry"],
    ["some-other-site.com", "Generic"],
  ])("%s -> %s", (host, name) => {
    expect(getAdapter(host).name).toBe(name)
  })
})

describe("GMGN: the token pages only", () => {
  it("gmgn.ai/sol/token/{CA}: the token", () => {
    expect(GMGNAdapter.extractCA(new URL(`https://gmgn.ai/sol/token/${BONK}`), document)).toBe(BONK)
  })

  it("a wallet page (gmgn.ai/sol/address/{wallet}) is not a token page: nothing is scanned", () => {
    expect(GMGNAdapter.extractCA(new URL(`https://gmgn.ai/sol/address/${WALLET}`), document)).toBe("")
  })
})

describe("GeckoTerminal: a pool page holds the pool's address; the token is read from the page when it shows it", () => {
  // Measured on the live page of this pool (2026-10-17): no explorer link and no data-* address in it. The adapter then sends the pool's
  // address, which the scan resolves to its token (a scan started from a pair address, audit A-07).
  it("the real page (no explorer link): the pool's address, for the scan to resolve", () => {
    document.body.innerHTML = `<h1>Bonk/SOL</h1><p>Price on Orca</p>`
    expect(GeckoTerminalAdapter.extractCA(new URL(`https://www.geckoterminal.com/solana/pools/${POOL}`), document)).toBe(POOL)
  })

  it("geckoterminal.com/solana/pools/{pool} with the token's explorer link: the token, not the pool", () => {
    document.body.innerHTML = `<a href="https://solscan.io/token/${BONK}">BONK</a>`
    expect(GeckoTerminalAdapter.extractCA(new URL(`https://www.geckoterminal.com/solana/pools/${POOL}`), document)).toBe(BONK)
  })

  it("a list page (no /pools/) is not scanned, whatever it shows", () => {
    document.body.innerHTML = `<a href="https://solscan.io/token/${BONK}">BONK</a>`
    expect(GeckoTerminalAdapter.extractCA(new URL("https://www.geckoterminal.com/solana/pools"), document)).toBe("")
    expect(GeckoTerminalAdapter.extractCA(new URL("https://www.geckoterminal.com/solana"), document)).toBe("")
  })
})

describe("Photon: a /lp/ page holds the pool's address; the token is read from the page", () => {
  it("photon-sol.tinyastro.io/en/lp/{pool} with the token in a data attribute: the token", () => {
    document.body.innerHTML = `<div data-address="${BONK}"></div>`
    expect(PhotonAdapter.extractCA(new URL(`https://photon-sol.tinyastro.io/en/lp/${POOL}`), document)).toBe(BONK)
  })
})

describe("Axiom and Telemetry: the address in the URL", () => {
  it("axiom.trade/meme/{address}: that address (the scan resolves a pair to its token)", () => {
    expect(AxiomAdapter.extractCA(new URL(`https://axiom.trade/meme/${POOL}`), document)).toBe(POOL)
  })

  it("app.telemetry.io/token/{CA}: the token; a page with no address: nothing", () => {
    expect(TelemetryAdapter.extractCA(new URL(`https://app.telemetry.io/token/${BONK}`), document)).toBe(BONK)
    expect(TelemetryAdapter.extractCA(new URL("https://app.telemetry.io/trending"), document)).toBe("")
  })
})
