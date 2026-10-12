import { describe, it, expect } from "vitest";
import { canonicalKey, exchangeKey } from "./keys";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana/pools/POOL/ohlcv/hour?aggregate=4&limit=";

describe("replay exchange keys", () => {
  it("the number of 4-hour candles asked for is not part of the key: a recording made with 182 answers the request for 1000", () => {
    expect(exchangeKey("GET", `${GT}1000`, null)).toBe(exchangeKey("GET", `${GT}182`, null));
    expect(canonicalKey(`GET ${GT}182 `)).toBe(canonicalKey(`GET ${GT}1000 `));
  });

  it("everything else still tells exchanges apart: another pool, another aggregate, another host", () => {
    expect(exchangeKey("GET", `${GT}1000`, null)).not.toBe(exchangeKey("GET", `${GT}1000`.replace("POOL", "OTHER"), null));
    expect(exchangeKey("GET", `${GT}1000`, null)).not.toBe(exchangeKey("GET", `${GT}1000`.replace("aggregate=4", "aggregate=1"), null));
    expect(exchangeKey("GET", "https://api.dexscreener.com/latest/dex/tokens/X", null)).toBe("GET https://api.dexscreener.com/latest/dex/tokens/X ");
  });

  it("the 5-minute candle request keeps its own number", () => {
    const five = "https://api.geckoterminal.com/api/v2/networks/solana/pools/POOL/ohlcv/minute?aggregate=5&limit=40";
    expect(exchangeKey("GET", five, null)).toContain("limit=40");
  });
});
