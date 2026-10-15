// __tests__/replay/goplus-solana-fields.test.ts — the GoPlus answers recorded for real Solana tokens never carry a field of the EVM contract.
//
// layerGoPlus used to read fifteen fields that belong to GoPlus's EVM answers (is_honeypot, cannot_sell_all, sell_tax, buy_tax, owner_percent,
// is_proxy, hidden_owner...). The Solana endpoint never returns them: across the 1,121 recorded tokens (1,424 GoPlus answers, all HTTP 200)
// not one carries any of them, at any depth. Those checks were dead, so they were removed (maintainability audit); the replay of the whole corpus
// gives the same verdicts, scores, flags and facts as before.
//
// This test is the proof, kept as a tripwire: if a FUTURE capture ever contains one of these fields, the engine ignores it silently, so this
// test fails instead and someone has to decide how to read it. (Sells that cannot happen on Solana come from the chain: facts.ts / judgeContractFacts.)
import { describe, expect, it } from "vitest";
import { loadRecording, recordedMints } from "./harness";

const EVM_ONLY_FIELDS = [
  "is_honeypot", "cannot_sell_all", "owner_percent", "creator_percent", "sell_tax", "buy_tax", "is_mintable", "slippage_modifiable",
  "is_anti_whale_modifiable", "trading_cooldown", "is_whitelisted", "is_blacklisted", "transfer_pausable", "hidden_owner", "is_proxy",
];

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) for (const v of value) collectKeys(v, into);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      collectKeys(v, into);
    }
  }
}

describe("GoPlus answers recorded for Solana tokens", () => {
  it("never carry a field of the EVM contract (honeypot, taxes, owner percent...)", () => {
    const found: Record<string, string[]> = {};
    let answers = 0;
    for (const mint of recordedMints()) {
      const recording = loadRecording(mint);
      if (!recording) continue;
      for (const exchange of recording.exchanges) {
        if (!/gopluslabs\.io/.test(exchange.k) || exchange.s !== 200) continue;
        let body: unknown;
        try {
          body = JSON.parse(exchange.t);
        } catch {
          continue;
        }
        answers++;
        const keys = new Set<string>();
        collectKeys(body, keys);
        for (const field of EVM_ONLY_FIELDS) if (keys.has(field)) (found[field] ??= []).push(mint);
      }
    }
    // not vacuous: the corpus really holds more than a thousand GoPlus answers
    expect(answers).toBeGreaterThan(1000);
    expect(found).toEqual({});
  }, 120_000);
});
