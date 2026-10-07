// __tests__/ai-summary-gemini.test.ts
//
// How the AI summary talks to Gemini, and what it does when Gemini does not
// answer. Before: the request left no room for a 2.5 model's thinking tokens
// (400 max_tokens), a failed call returned the template as if it were Gemini's
// answer, retries could run 28 s against a 24 s scan budget, and nothing stopped
// every scan from paying for a dead key.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateAISummary,
  generateAISummaryWithSource,
  _resetAiStateForTests,
} from "../api/_lib/ai-summary";
import type { AISummaryInput } from "../api/_lib/ai-summary";

const input: AISummaryInput = {
  score: 880,
  risk: "SAFE",
  flags: [],
  tokenSymbol: "TEST",
  holders: 5000,
  marketCap: 1_000_000,
  liquidity: 400_000,
  lpBurned: true,
  lpLocked: false,
  mintAuthority: false,
  freezeAuthority: false,
  honeypot: false,
  tokenAgeHours: 900,
  sourcesUsed: ["dexscreener", "rugcheck", "goplus", "helius"],
  topHolderPct: 4,
  volume24h: 90_000,
  priceChange1h: 0.5,
};

/** A summary in the contract: 3 paragraphs, enough words. */
const VALID =
  "TEST shows a SAFE profile with locked liquidity and 30d+ established trading on Solana.\n\n" +
  "RugCheck and GoPlus cross-validate the safe verdict across independent layers.\n\n" +
  "Strong holder distribution.";
const ONE_PARAGRAPH = "This token appears safe with strong liquidity, burned LP and a long trading history overall.";

function reply(content: string, status = 200): Response {
  const body = { choices: [{ message: { content } }] };
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body } as Response;
}
function failure(status: number): Response {
  return { ok: false, status, text: async () => "{}", json: async () => ({}) } as Response;
}

/** The JSON body of the n-th request. */
function sent(fetchMock: ReturnType<typeof vi.fn>, n: number): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[n][1] as { body: string }).body) as Record<string, unknown>;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetAiStateForTests();
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.stubEnv("AI_MODEL", "");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the request", () => {
  it("asks Gemini 2.5 Flash not to think, and leaves room for the answer", async () => {
    fetchMock.mockResolvedValue(reply(VALID));

    await generateAISummaryWithSource(input);

    const body = sent(fetchMock, 0);
    expect(body.model).toBe("gemini-2.5-flash");
    expect(body.reasoning_effort).toBe("none");
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.25);
  });

  it.each([
    ["gemini-2.5-flash", true],
    ["gemini-2.5-flash-preview-09-2025", true],
    ["gemini-2.5-flash-lite", false], // does not think by default
    ["gemini-2.5-pro", false], // cannot stop thinking: the endpoint would refuse
    ["gemini-3-flash-preview", false],
  ])("%s: reasoning_effort sent = %s", async (model, expected) => {
    vi.stubEnv("AI_MODEL", model);
    fetchMock.mockResolvedValue(reply(VALID));

    await generateAISummaryWithSource(input);

    expect(sent(fetchMock, 0).model).toBe(model);
    expect("reasoning_effort" in sent(fetchMock, 0)).toBe(expected);
  });

  it("an HTTP 400 is tried again without reasoning_effort, and the parameter is dropped from then on", async () => {
    fetchMock.mockResolvedValueOnce(failure(400)).mockResolvedValue(reply(VALID));

    const first = await generateAISummaryWithSource(input);
    const second = await generateAISummaryWithSource(input);

    expect(first?.source).toBe("gemini");
    expect(second?.source).toBe("gemini");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sent(fetchMock, 0).reasoning_effort).toBe("none");
    expect("reasoning_effort" in sent(fetchMock, 1)).toBe(false);
    expect("reasoning_effort" in sent(fetchMock, 2)).toBe(false);
  });

  it("a request refused either way is not blamed on reasoning_effort", async () => {
    fetchMock.mockResolvedValue(failure(400));

    const first = await generateAISummaryWithSource(input);
    await generateAISummaryWithSource(input);

    expect(first?.source).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(4); // with and without, twice
    expect(sent(fetchMock, 2).reasoning_effort).toBe("none"); // still tried with it on the next scan
  });
});

describe("what the summary says about itself", () => {
  it("a Gemini answer is labelled as Gemini's", async () => {
    fetchMock.mockResolvedValue(reply(VALID));

    const out = await generateAISummaryWithSource(input);

    expect(out).toEqual({ text: VALID, source: "gemini" });
  });

  it("the wrapper still returns the text only", async () => {
    fetchMock.mockResolvedValue(reply(VALID));

    expect(await generateAISummary(input)).toBe(VALID);
  });

  it("the template after a failed call is labelled fallback, not Gemini", async () => {
    fetchMock.mockResolvedValue(failure(500));

    const out = await generateAISummaryWithSource(input);

    expect(out?.source).toBe("fallback");
    expect(out?.text.split(/\n\s*\n/)).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1); // a server error is not asked again
  });

  it("no key at all is labelled local, and nothing is called", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");

    const out = await generateAISummaryWithSource(input);

    expect(out?.source).toBe("local");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an off-format answer is asked for again once, at once", async () => {
    fetchMock.mockResolvedValueOnce(reply(ONE_PARAGRAPH)).mockResolvedValueOnce(reply(VALID));

    const out = await generateAISummaryWithSource(input);

    expect(out).toEqual({ text: VALID, source: "gemini" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an off-format answer twice in a row is the template, after exactly two calls", async () => {
    fetchMock.mockResolvedValue(reply(ONE_PARAGRAPH));

    const out = await generateAISummaryWithSource(input);

    expect(out?.source).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an empty answer (a 2.5 model's thinking ate the token budget) counts as off-format, not as a success", async () => {
    fetchMock.mockResolvedValueOnce(reply("")).mockResolvedValueOnce(reply(VALID));

    const out = await generateAISummaryWithSource(input);

    expect(out?.source).toBe("gemini");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("against a deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("does not call Gemini when there is no time left to wait for it", async () => {
    const out = await generateAISummaryWithSource(input, { deadlineAt: Date.now() + 1000 });

    expect(out?.source).toBe("fallback");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cuts a call that hangs at the deadline, not at its own 8 s", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const start = Date.now();
    let finishedAt = 0;
    const done = generateAISummaryWithSource(input, { deadlineAt: start + 4000 }).then((r) => {
      finishedAt = Date.now() - start;
      return r;
    });

    await vi.advanceTimersByTimeAsync(4000);
    const out = await done;

    expect(out?.source).toBe("fallback");
    expect(fetchMock).toHaveBeenCalledTimes(1); // no time for a second attempt
    expect(finishedAt).toBeLessThanOrEqual(3700); // deadline less the margin kept for answering
  });

  it("does not sit out a pause that leaves too little time for the next attempt", async () => {
    fetchMock.mockResolvedValue(failure(429));
    const start = Date.now();

    const done = generateAISummaryWithSource(input, { deadlineAt: start + 5000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const out = await done;

    // 1.5 s pause then a second call (3.5 s left); the next pause (3 s) would leave 0.5 s.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out?.source).toBe("fallback");
  });

  it("with all the time it needs, keeps its three attempts on a rate limit", async () => {
    fetchMock.mockResolvedValue(failure(429));

    const done = generateAISummaryWithSource(input, { deadlineAt: Date.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await done;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("a Gemini that keeps failing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const scan = () => generateAISummaryWithSource(input);

  it("is left alone for a minute after three scans in a row got no usable answer, then tried again", async () => {
    fetchMock.mockResolvedValue(failure(500));

    for (let i = 0; i < 3; i++) await scan();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const skipped = await scan();
    expect(skipped?.source).toBe("fallback"); // still a summary, and still honest about its source
    expect(fetchMock).toHaveBeenCalledTimes(3); // but no call

    await vi.advanceTimersByTimeAsync(59_000);
    await scan();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(2_000);
    await scan();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("is let back in for good by one answer", async () => {
    fetchMock.mockResolvedValue(failure(500));
    for (let i = 0; i < 3; i++) await scan();
    await vi.advanceTimersByTimeAsync(61_000);

    fetchMock.mockResolvedValue(reply(VALID));
    expect((await scan())?.source).toBe("gemini");

    fetchMock.mockResolvedValue(failure(500));
    await scan();
    await scan();
    await scan(); // the count started again from zero: this is the third failure, not the fourth
    expect(fetchMock).toHaveBeenCalledTimes(3 + 1 + 3);
  });

  it("an answer in between starts the count over", async () => {
    fetchMock.mockResolvedValueOnce(failure(500)).mockResolvedValueOnce(failure(500)).mockResolvedValueOnce(reply(VALID));
    await scan();
    await scan();
    await scan();

    fetchMock.mockResolvedValue(failure(500));
    await scan();
    await scan();
    await scan(); // only two failures since the answer: still called

    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("scans that never reached Gemini (no time) do not count as its failures", async () => {
    for (let i = 0; i < 6; i++) await generateAISummaryWithSource(input, { deadlineAt: Date.now() + 100 });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(reply(VALID));
    expect((await scan())?.source).toBe("gemini");
  });
});
