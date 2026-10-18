// __tests__/audit-lot68.test.ts — Lot 68 of the file-by-file audit (2026-10-17): every text of a Critical Actors card is escaped. Fails on the previous code.
//
// renderCriticalActorCard (js/views.js) prints five texts that come from the API. The test of token-cluster-cards checks two of them (the tag and
// the address); the label and the description could be printed raw with the whole suite green. They are built by the server today, but the card
// is the page's last line of defence: a description is HTML-escaped with only <b> kept, and the label is plain text.

import { describe, it, expect } from "vitest"
import { renderCriticalActorCard } from "../js/views.js"

const card = (over: Record<string, unknown>) =>
  renderCriticalActorCard({ type: "insider", tag: "Holder #1", pct: 4, addr: "Aa11…Zz11", repLbl: "", repWidth: 30, repWarn: false, desc: "", ...over }) as string

describe("a Critical Actors card prints what the API says as text", () => {
  it("the label is never HTML", () => {
    const html = card({ repLbl: `<img src=x onerror="alert(1)">` })
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
  })

  it("the description keeps its <b> and nothing else", () => {
    const html = card({ desc: `Holds <b>4.0%</b> of supply <script>alert(1)</script><img src=x onerror=alert(1)>` })
    expect(html).toContain("<b>4.0%</b>")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img")
  })

  it("the width of the bar is a number between 0 and 100, whatever it is sent as", () => {
    expect(card({ repWidth: `50%" onmouseover="alert(1)` })).not.toContain("onmouseover")
    expect(card({ repWidth: 250 })).toContain("width:100%")
    expect(card({ repWidth: -5 })).toContain("width:0%")
  })
})
