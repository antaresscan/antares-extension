/* @vitest-environment happy-dom */
// __tests__/audit-lot30.test.ts — Lot 30 of the file-by-file audit (2026-10-17): the overlay's cache, panels and drag. Fails on the
// previous code.

import { describe, it, expect, beforeEach } from "vitest"

const { __testing__ } = await import("../contents/modules/critical-flags")
const { initDrag } = await import("../contents/modules/drag")
const { state } = await import("../contents/modules/state")
const { POS_KEY } = await import("../contents/modules/constants")

describe("Critical Flags panel — the description of the flag the engine really emits", () => {
  it("\"Transfer fee can be changed — …\" (api/_lib/layers.ts) is explained as a possible honeypot, not as a plain fee", () => {
    const desc = __testing__.getFlagDescription("Transfer fee can be changed — an authority can raise it to 100%")
    expect(desc).toContain("honeypot")
  })

  it("a plain fee keeps the plain-fee text (non-regression)", () => {
    expect(__testing__.getFlagDescription("Transfer fee 5% on every transfer")).toContain("takes a cut of every transfer")
  })
})

describe("drag — the box is always drawn inside the window", () => {
  beforeEach(() => {
    document.getElementById("antares-host")?.remove()
    const host = document.createElement("div")
    host.id = "antares-host"
    document.documentElement.appendChild(host)
    state.host = host
    state.shadow = host.attachShadow({ mode: "closed" })
    localStorage.removeItem(POS_KEY)
  })

  it("a spot saved in a larger window is drawn inside this one (it stayed off-screen until a resize), and the saved spot is kept", () => {
    localStorage.setItem(POS_KEY, JSON.stringify({ x: 3000, y: 2000 }))
    initDrag()
    // happy-dom: a 1024 x 768 window, and a host of no size (the clamp then counts the box as 280 x 360).
    expect(state.host!.style.transform).toBe(`translate(${window.innerWidth - 280}px,${window.innerHeight - 360}px)`)
    expect(JSON.parse(localStorage.getItem(POS_KEY)!)).toEqual({ x: 3000, y: 2000 })
  })

  it("a saved value that is not two numbers counts as none: the default spot", () => {
    localStorage.setItem(POS_KEY, JSON.stringify({ x: "oops" }))
    initDrag()
    expect(state.host!.style.transform).toBe(`translate(${window.innerWidth - 310}px,${window.innerHeight - 400}px)`)
  })

  it("a spot inside the window is kept as it is (non-regression)", () => {
    localStorage.setItem(POS_KEY, JSON.stringify({ x: 60, y: 30 }))
    initDrag()
    expect(state.host!.style.transform).toBe("translate(60px,30px)")
  })
})
