import { describe, it, expect, vi, afterEach } from "vitest";
import {
  base58encode,
  buildPayUrl,
  generateReferenceKey,
  isValidSolanaAddress,
  priceFor,
  priceUsd,
  resolveAmount,
  verifyTokenTransfer,
  verifySolTransfer,
  USDC_MINT,
} from "../api/_lib/solana-pay";

const VALID_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

// ─── base58encode ─────────────────────────────────────────────────────────────

describe("base58encode", () => {
  it("encodes empty buffer to empty string", () => {
    expect(base58encode(new Uint8Array(0))).toBe("");
  });

  it("preserves leading zero bytes as '1's", () => {
    const bytes = new Uint8Array([0, 0, 0, 1]);
    const encoded = base58encode(bytes);
    expect(encoded.startsWith("111")).toBe(true);
  });

  it("encodes a 32-byte random buffer to a 32-44 character string", () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 7 + 13) & 0xff;
    const encoded = base58encode(bytes);
    expect(encoded.length).toBeGreaterThanOrEqual(32);
    expect(encoded.length).toBeLessThanOrEqual(44);
    // No invalid base58 characters
    expect(/^[1-9A-HJ-NP-Za-km-z]+$/.test(encoded)).toBe(true);
  });
});

// ─── isValidSolanaAddress ─────────────────────────────────────────────────────

describe("isValidSolanaAddress", () => {
  it("accepts a real-world Solana wallet address", () => {
    expect(isValidSolanaAddress(VALID_RECIPIENT)).toBe(true);
  });

  it("accepts the USDC mint address", () => {
    expect(isValidSolanaAddress(USDC_MINT)).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidSolanaAddress("")).toBe(false);
  });

  it("rejects strings shorter than 32 chars", () => {
    expect(isValidSolanaAddress("tooshort")).toBe(false);
  });

  it("rejects strings with invalid base58 chars (0, O, I, l)", () => {
    expect(isValidSolanaAddress("0".repeat(40))).toBe(false);
    expect(isValidSolanaAddress("O".repeat(40))).toBe(false);
    expect(isValidSolanaAddress("I".repeat(40))).toBe(false);
    expect(isValidSolanaAddress("l".repeat(40))).toBe(false);
  });
});

// ─── generateReferenceKey ─────────────────────────────────────────────────────

describe("generateReferenceKey", () => {
  it("produces a base58 string in the Solana Pubkey shape", () => {
    const ref = generateReferenceKey();
    expect(isValidSolanaAddress(ref)).toBe(true);
  });

  it("produces a different key on every call (collision resistance)", () => {
    const refs = new Set<string>();
    for (let i = 0; i < 50; i++) refs.add(generateReferenceKey());
    expect(refs.size).toBe(50);
  });
});

// ─── buildPayUrl ──────────────────────────────────────────────────────────────

describe("buildPayUrl", () => {
  it("builds a valid Solana Pay URL with USDC SPL token", () => {
    const url = buildPayUrl({
      recipient: VALID_RECIPIENT,
      amount: 14.99,
      splTokenMint: USDC_MINT,
      reference: "ref-test-12345",
      label: "Antares",
      message: "Pro pass",
    });
    expect(url.startsWith(`solana:${VALID_RECIPIENT}?`)).toBe(true);
    expect(url).toContain("amount=14.99");
    expect(url).toContain(`spl-token=${USDC_MINT}`);
    expect(url).toContain("reference=ref-test-12345");
    expect(url).toContain("label=Antares");
    expect(url).toContain("message=Pro+pass");
  });

  it("omits spl-token when not provided (native SOL transfer)", () => {
    const url = buildPayUrl({
      recipient: VALID_RECIPIENT,
      amount: 0.1,
      reference: "ref-1",
    });
    expect(url).not.toContain("spl-token");
    expect(url).toContain("amount=0.1");
  });

  it("encodes special characters in label/message correctly", () => {
    const url = buildPayUrl({
      recipient: VALID_RECIPIENT,
      amount: 1,
      reference: "r",
      label: "Test & Demo",
      message: "Hello world!",
    });
    // URLSearchParams encodes & as %26 and space as +
    expect(url).toContain("Test+%26+Demo");
  });
});

// ─── priceFor ─────────────────────────────────────────────────────────────────

describe("priceFor", () => {
  it("returns 24.99 for monthly by default", () => {
    delete process.env.SOLANA_PRICE_PRO_USDC;
    expect(priceFor("monthly")).toBe(24.99);
  });

  it("returns 149.99 for yearly by default (legacy SOLANA_PRICE_LIFETIME_USDC fallback)", () => {
    delete process.env.SOLANA_PRICE_YEARLY_USDC;
    delete process.env.SOLANA_PRICE_LIFETIME_USDC;
    expect(priceFor("yearly")).toBe(149.99);
  });

  it("honours SOLANA_PRICE_PRO_USDC env override", () => {
    process.env.SOLANA_PRICE_PRO_USDC = "19.99";
    expect(priceFor("monthly")).toBe(19.99);
    delete process.env.SOLANA_PRICE_PRO_USDC;
  });

  it("falls back to default when env value is invalid", () => {
    process.env.SOLANA_PRICE_PRO_USDC = "not-a-number";
    expect(priceFor("monthly")).toBe(24.99);
    delete process.env.SOLANA_PRICE_PRO_USDC;
  });

  it("falls back to default when env value is negative", () => {
    process.env.SOLANA_PRICE_PRO_USDC = "-5";
    expect(priceFor("monthly")).toBe(24.99);
    delete process.env.SOLANA_PRICE_PRO_USDC;
  });
});

// ─── verifyTokenTransfer ──────────────────────────────────────────────────────

describe("verifyTokenTransfer", () => {
  function txWithBalances(
    pre: Array<{ owner: string; mint: string; uiAmount: number }>,
    post: Array<{ owner: string; mint: string; uiAmount: number }>,
    err: unknown = null,
  ) {
    return {
      meta: {
        err,
        preTokenBalances: pre.map((b) => ({
          owner: b.owner,
          mint: b.mint,
          uiTokenAmount: { uiAmount: b.uiAmount },
        })),
        postTokenBalances: post.map((b) => ({
          owner: b.owner,
          mint: b.mint,
          uiTokenAmount: { uiAmount: b.uiAmount },
        })),
      },
    };
  }

  it("returns true when recipient's token balance increased by the expected amount", () => {
    const tx = txWithBalances(
      [{ owner: VALID_RECIPIENT, mint: USDC_MINT, uiAmount: 100 }],
      [{ owner: VALID_RECIPIENT, mint: USDC_MINT, uiAmount: 114.99 }],
    );
    expect(
      verifyTokenTransfer(tx, {
        recipient: VALID_RECIPIENT,
        mint: USDC_MINT,
        minAmount: 14.99,
      }),
    ).toBe(true);
  });

  it("returns true even if recipient's ATA didn't exist before (no preTokenBalance)", () => {
    const tx = txWithBalances(
      [],
      [{ owner: VALID_RECIPIENT, mint: USDC_MINT, uiAmount: 14.99 }],
    );
    expect(
      verifyTokenTransfer(tx, {
        recipient: VALID_RECIPIENT,
        mint: USDC_MINT,
        minAmount: 14.99,
      }),
    ).toBe(true);
  });

  it("returns false when the recipient didn't receive the expected mint", () => {
    const otherMint = "So11111111111111111111111111111111111111112";
    const tx = txWithBalances(
      [],
      [{ owner: VALID_RECIPIENT, mint: otherMint, uiAmount: 14.99 }],
    );
    expect(
      verifyTokenTransfer(tx, {
        recipient: VALID_RECIPIENT,
        mint: USDC_MINT,
        minAmount: 14.99,
      }),
    ).toBe(false);
  });

  it("returns false when recipient is wrong", () => {
    const otherRecipient = "So11111111111111111111111111111111111111112";
    const tx = txWithBalances(
      [],
      [{ owner: otherRecipient, mint: USDC_MINT, uiAmount: 14.99 }],
    );
    expect(
      verifyTokenTransfer(tx, {
        recipient: VALID_RECIPIENT,
        mint: USDC_MINT,
        minAmount: 14.99,
      }),
    ).toBe(false);
  });

  it("returns false when amount is less than expected", () => {
    const tx = txWithBalances(
      [{ owner: VALID_RECIPIENT, mint: USDC_MINT, uiAmount: 100 }],
      [{ owner: VALID_RECIPIENT, mint: USDC_MINT, uiAmount: 105 }],
    );
    expect(
      verifyTokenTransfer(tx, {
        recipient: VALID_RECIPIENT,
        mint: USDC_MINT,
        minAmount: 14.99,
      }),
    ).toBe(false);
  });

  it("returns false when transaction failed (err is not null)", () => {
    const tx = txWithBalances(
      [],
      [{ owner: VALID_RECIPIENT, mint: USDC_MINT, uiAmount: 14.99 }],
      { InstructionError: [0, "Custom"] },
    );
    expect(
      verifyTokenTransfer(tx, {
        recipient: VALID_RECIPIENT,
        mint: USDC_MINT,
        minAmount: 14.99,
      }),
    ).toBe(false);
  });

  it("returns false when meta is missing entirely", () => {
    expect(
      verifyTokenTransfer(
        {},
        {
          recipient: VALID_RECIPIENT,
          mint: USDC_MINT,
          minAmount: 14.99,
        },
      ),
    ).toBe(false);
  });

  it("accepts a payment that's 1% under target (rounding tolerance)", () => {
    const tx = txWithBalances(
      [],
      [{ owner: VALID_RECIPIENT, mint: USDC_MINT, uiAmount: 14.85 }],
    );
    expect(
      verifyTokenTransfer(tx, {
        recipient: VALID_RECIPIENT,
        mint: USDC_MINT,
        minAmount: 14.99,
      }),
    ).toBe(true);
  });

  it("rejects a payment 5% under target", () => {
    const tx = txWithBalances(
      [],
      [{ owner: VALID_RECIPIENT, mint: USDC_MINT, uiAmount: 14.24 }],
    );
    expect(
      verifyTokenTransfer(tx, {
        recipient: VALID_RECIPIENT,
        mint: USDC_MINT,
        minAmount: 14.99,
      }),
    ).toBe(false);
  });
});

// ─── verifySolTransfer ────────────────────────────────────────────────────────

describe("verifySolTransfer", () => {
  function solTx(
    accountKeys: string[],
    pre: number[],
    post: number[],
    err: unknown = null,
  ) {
    return {
      meta: { err, preBalances: pre, postBalances: post },
      transaction: { message: { accountKeys } },
    };
  }

  const SENDER = "11111111111111111111111111111112";
  const LAMPORTS_PER_SOL = 1_000_000_000;

  it("returns true when recipient's SOL balance increased by the expected amount", () => {
    const accountKeys = [SENDER, VALID_RECIPIENT];
    const tx = solTx(
      accountKeys,
      [10 * LAMPORTS_PER_SOL, 5 * LAMPORTS_PER_SOL],
      [10 * LAMPORTS_PER_SOL - 0.2 * LAMPORTS_PER_SOL, 5 * LAMPORTS_PER_SOL + 0.2 * LAMPORTS_PER_SOL],
    );
    expect(
      verifySolTransfer(tx, { recipient: VALID_RECIPIENT, minAmount: 0.2 }),
    ).toBe(true);
  });

  it("returns false when the recipient is not in the account keys", () => {
    const accountKeys = [SENDER, "OtherWallet1234567890123456789012345678901"];
    const tx = solTx(accountKeys, [0, 0], [0, 0.2 * LAMPORTS_PER_SOL]);
    expect(
      verifySolTransfer(tx, { recipient: VALID_RECIPIENT, minAmount: 0.2 }),
    ).toBe(false);
  });

  it("returns false when the SOL delta is below target", () => {
    const accountKeys = [SENDER, VALID_RECIPIENT];
    const tx = solTx(accountKeys, [0, 0], [0, 0.05 * LAMPORTS_PER_SOL]);
    expect(
      verifySolTransfer(tx, { recipient: VALID_RECIPIENT, minAmount: 0.2 }),
    ).toBe(false);
  });

  it("returns false when transaction failed", () => {
    const accountKeys = [SENDER, VALID_RECIPIENT];
    const tx = solTx(
      accountKeys,
      [0, 0],
      [0, 0.2 * LAMPORTS_PER_SOL],
      { InstructionError: [0, "Custom"] },
    );
    expect(
      verifySolTransfer(tx, { recipient: VALID_RECIPIENT, minAmount: 0.2 }),
    ).toBe(false);
  });

  it("accepts a payment 1% under target (rounding tolerance)", () => {
    const accountKeys = [SENDER, VALID_RECIPIENT];
    const tx = solTx(
      accountKeys,
      [0, 0],
      [0, 0.198 * LAMPORTS_PER_SOL], // 0.198 ≥ 0.2 * 0.99 = 0.198
    );
    expect(
      verifySolTransfer(tx, { recipient: VALID_RECIPIENT, minAmount: 0.2 }),
    ).toBe(true);
  });

  it("supports parsed-account-key shape ({ pubkey, signer, writable })", () => {
    const accountKeys = [
      { pubkey: SENDER, signer: true, writable: true },
      { pubkey: VALID_RECIPIENT, signer: false, writable: true },
    ];
    const tx = solTx(
      accountKeys as unknown as string[], // helper signature uses string[]
      [0, 0],
      [0, 0.5 * LAMPORTS_PER_SOL],
    );
    expect(
      verifySolTransfer(tx, { recipient: VALID_RECIPIENT, minAmount: 0.5 }),
    ).toBe(true);
  });
});

// ─── resolveAmount (token-aware pricing) ──────────────────────────────────────

describe("resolveAmount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SOLANA_PRICE_PRO_USDC;
    delete process.env.SOLANA_PRICE_LIFETIME_USDC;
  });

  it("returns the USD price as USDC amount with USDC mint", async () => {
    const result = await resolveAmount("monthly", "usdc");
    expect(result.amount).toBe(24.99);
    expect(result.amountUsd).toBe(24.99);
    expect(result.splTokenMint).toBe(USDC_MINT);
  });

  it("converts USD to SOL using the live Jupiter rate, returns null mint", async () => {
    // Jupiter lite-api v3 shape: keyed by mint address, usdPrice field.
    const WSOL_MINT = "So11111111111111111111111111111111111111112";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ [WSOL_MINT]: { usdPrice: 100 } }),
      })),
    );
    const result = await resolveAmount("monthly", "sol");
    // 24.99 / 100 = 0.2499, rounded UP to 4 decimals = 0.2499
    expect(result.amount).toBe(0.2499);
    expect(result.amountUsd).toBe(24.99);
    expect(result.splTokenMint).toBeNull();
  });

  it("rounds UP to 4 decimals so the user never under-pays from rounding", async () => {
    const WSOL_MINT = "So11111111111111111111111111111111111111112";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ [WSOL_MINT]: { usdPrice: 142.857142 } }),
      })),
    );
    const result = await resolveAmount("yearly", "sol");
    // 149.99 / 142.857142 = 1.04993... → ceil to 4 decimals = 1.0500
    expect(result.amount).toBeGreaterThanOrEqual(149.99 / 142.857142);
    expect(result.amount).toBeLessThan(149.99 / 142.857142 + 0.001);
  });

  it("falls back to CoinGecko when Jupiter v3 is unreachable", async () => {
    // First fetch (Jupiter) fails, second fetch (CoinGecko) returns a price.
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) return { ok: false, json: async () => ({}) };
        return {
          ok: true,
          json: async () => ({ solana: { usd: 100 } }),
        };
      }),
    );
    const result = await resolveAmount("monthly", "sol");
    expect(result.amount).toBe(0.2499);
    expect(callCount).toBe(2);
  });

  it("throws when both SOL price sources fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({}),
      })),
    );
    await expect(resolveAmount("monthly", "sol")).rejects.toThrow(/SOL\/USD/i);
  });

  it("priceUsd matches priceFor (back-compat alias)", () => {
    expect(priceUsd("monthly")).toBe(priceFor("monthly"));
    expect(priceUsd("yearly")).toBe(priceFor("yearly"));
  });
});
