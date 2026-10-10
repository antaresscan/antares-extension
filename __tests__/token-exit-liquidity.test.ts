// __tests__/token-exit-liquidity.test.ts
//
// The Exit Liquidity tab of token.html. Its "Total LP available" amount used to sit in a <b>: with Bebas Neue (a font that
// has a single weight) the browser fakes a bold, which looked heavy next to the rest of the page. The amount keeps its
// colour and letter spacing, in regular weight.
import { describe, it, expect } from "vitest";
import { buildExitLiquidityTab } from "../js/views.js";

/** The "Total LP available: <amount>" line of the tab, as HTML. */
const totalLpLine = (liq: number | null) => {
  const html = buildExitLiquidityTab(liq);
  const start = html.indexOf("Total LP available:");
  expect(start, "the Total LP available line is missing").toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</div>", start));
};

describe("Exit Liquidity: Total LP available", () => {
  it("shows the amount", () => {
    expect(totalLpLine(5_990_000)).toContain("$5.99M");
  });

  it("does not put the amount in bold (no <b> / <strong>, no bold font-weight)", () => {
    const line = totalLpLine(5_990_000);
    expect(line).not.toMatch(/<(b|strong)\b/i);
    expect(line).not.toMatch(/font-weight\s*:\s*(bold|bolder|[5-9]00)/i);
  });

  it("keeps the amount lighter than the label's grey: its colour and letter spacing are unchanged", () => {
    const line = totalLpLine(5_990_000);
    expect(line).toMatch(/<span style="color:#eee;letter-spacing:\.08em">\$5\.99M<\/span>/);
  });

  it("escapes what it prints", () => {
    expect(totalLpLine(5_990_000)).not.toContain("<script");
  });

  it("without a liquidity figure the tab says so, as before", () => {
    const html = buildExitLiquidityTab(null);
    expect(html).toContain("Exit liquidity unavailable");
    expect(html).not.toContain("Total LP available");
  });
});
