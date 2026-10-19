// __tests__/background-scan-result.test.ts — the service worker turns a SCAN_RESULT message
// into the risk-escalation notification and the local scan history. It never touches the toolbar button.
//
// Runs the REAL background.ts against an in-memory fake of the chrome.* APIs it uses.
// Why: since 2026-04-05 nothing sent the old `SCAN` message any more, so the badge, the
// alert and the history were dead and no test noticed (audit A-13).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The worker only needs Sentry's two named imports; the real SDK takes ~10 s to load cold.
vi.mock("@sentry/browser", () => ({ init: vi.fn(), captureException: vi.fn() }));

const CA = "So11111111111111111111111111111111111111112";
const OTHER_CA = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const OWN_ID = "antares-extension-id";

interface Sender {
  id?: string;
  tab?: { id: number };
}
interface Answer {
  ok: boolean;
  error?: string;
  history?: unknown;
}
type Listener = (msg: Record<string, unknown>, sender: Sender, sendResponse: (r: unknown) => void) => boolean | undefined;

interface Fake {
  storage: Record<string, unknown>;
  setBadgeText: ReturnType<typeof vi.fn>;
  setBadgeTextColor: ReturnType<typeof vi.fn>;
  notificationsCreate: ReturnType<typeof vi.fn>;
  listener: Listener;
}

async function loadBackground(): Promise<Fake> {
  const storage: Record<string, unknown> = {};
  let listener: Listener | undefined;
  const setBadgeText = vi.fn();
  const setBadgeTextColor = vi.fn();
  const notificationsCreate = vi.fn();
  vi.stubGlobal("chrome", {
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    runtime: {
      id: OWN_ID,
      lastError: undefined,
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
      onMessage: {
        addListener: (l: Listener) => {
          listener = l;
        },
      },
      getManifest: () => ({ icons: { "128": "icon128.plasmo.abc.png" } }),
      getURL: (p: string) => `chrome-extension://${OWN_ID}/${p}`,
    },
    storage: {
      local: {
        get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in storage) out[k] = storage[k];
          cb(out);
        },
        set: (items: Record<string, unknown>) => {
          Object.assign(storage, items);
        },
      },
    },
    action: {
      setBadgeText,
      setBadgeBackgroundColor: vi.fn(),
      setBadgeTextColor,
      setTitle: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    notifications: { create: notificationsCreate },
    tabs: { query: vi.fn(), create: vi.fn() },
  });
  vi.resetModules();
  await import("../background");
  if (!listener) throw new Error("background.ts did not register a runtime.onMessage listener");
  // The worker draws the on/off dot as it starts (toolbar-dot-at-start.test.ts); forget that, these tests are about what a SCAN_RESULT does.
  await new Promise((r) => setTimeout(r, 0));
  setBadgeText.mockClear();
  setBadgeTextColor.mockClear();
  return { storage, setBadgeText, setBadgeTextColor, notificationsCreate, listener };
}

/** Deliver a message the way Chrome does. `handled` is false when no handler exists for its type. */
function send(
  fake: Fake,
  msg: Record<string, unknown>,
  sender: Sender = { id: OWN_ID, tab: { id: 7 } },
): { handled: boolean; response?: Answer } {
  let response: Answer | undefined;
  const handled = fake.listener(msg, sender, (r) => {
    response = r as Answer;
  });
  return { handled: handled === true, response };
}

const scanResult = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "SCAN_RESULT",
  ca: CA,
  risk: "SAFE",
  score: 910,
  symbol: "WIF",
  ...over,
});

describe("background SCAN_RESULT", () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await loadBackground();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The toolbar button is the on/off dot (green = ON, red = OFF) and nothing else. Audit A-13 had brought back a verdict badge ("✓" / "!"
  // / "✗" next to the icon); it was removed again at the owner's request.
  describe("toolbar button", () => {
    it.each(["SAFE", "CAUTION", "DANGER", "RUG"])("a %s verdict is accepted but never written on the toolbar button", (risk) => {
      expect(send(fake, scanResult({ risk })).response).toEqual({ ok: true });
      expect(fake.setBadgeText).not.toHaveBeenCalled();
      expect(fake.setBadgeTextColor).not.toHaveBeenCalled();
    });

    it("an invalid verdict is still refused, and touches nothing either", () => {
      expect(send(fake, scanResult({ risk: "constructor" })).response).toEqual({ ok: false, error: "Invalid scan result" });
      expect(fake.setBadgeText).not.toHaveBeenCalled();
    });
  });

  describe("risk-escalation notification", () => {
    it("stays quiet the first time a token is seen", () => {
      send(fake, scanResult({ risk: "DANGER" }));
      expect(fake.notificationsCreate).not.toHaveBeenCalled();
    });

    it("fires when the risk of a token seen before gets worse", () => {
      send(fake, scanResult({ risk: "SAFE" }));
      send(fake, scanResult({ risk: "DANGER" }));
      expect(fake.notificationsCreate).toHaveBeenCalledTimes(1);
      const [id, options] = fake.notificationsCreate.mock.calls[0] as [string, Record<string, string>];
      expect(id).toBe(`antares_alert_${CA}`);
      expect(options.message).toBe("WIF risk changed: SAFE → DANGER");
      expect(options.iconUrl).toBe(`chrome-extension://${OWN_ID}/icon128.plasmo.abc.png`);
    });

    it("stays quiet when the verdict is the same again (the overlay reports cached results too)", () => {
      send(fake, scanResult({ risk: "CAUTION" }));
      send(fake, scanResult({ risk: "CAUTION" }));
      send(fake, scanResult({ risk: "CAUTION" }));
      expect(fake.notificationsCreate).not.toHaveBeenCalled();
    });

    it("stays quiet when the risk improves", () => {
      send(fake, scanResult({ risk: "RUG" }));
      send(fake, scanResult({ risk: "SAFE" }));
      expect(fake.notificationsCreate).not.toHaveBeenCalled();
    });

    it("tracks each token on its own", () => {
      send(fake, scanResult({ ca: CA, risk: "SAFE" }));
      send(fake, scanResult({ ca: OTHER_CA, risk: "DANGER" }));
      expect(fake.notificationsCreate).not.toHaveBeenCalled();
    });

    it("names the token by the start of its address when there is no symbol", () => {
      send(fake, scanResult({ risk: "SAFE", symbol: "" }));
      send(fake, scanResult({ risk: "RUG", symbol: "" }));
      const options = fake.notificationsCreate.mock.calls[0]?.[1] as Record<string, string>;
      expect(options.message).toBe(`${CA.slice(0, 8)} risk changed: SAFE → RUG`);
    });
  });

  describe("local scan history", () => {
    const history = (): Array<Record<string, unknown>> =>
      fake.storage["antares_scan_history"] as Array<Record<string, unknown>>;

    it("records the scan, newest first", () => {
      send(fake, scanResult({ ca: CA, risk: "SAFE", score: 910, symbol: "WIF" }));
      send(fake, scanResult({ ca: OTHER_CA, risk: "DANGER", score: 120, symbol: "BONK" }));
      expect(history().map((h) => [h.ca, h.symbol, h.risk, h.score])).toEqual([
        [OTHER_CA, "BONK", "DANGER", 120],
        [CA, "WIF", "SAFE", 910],
      ]);
      expect(typeof history()[0]?.ts).toBe("number");
    });

    it("keeps one row per token (the latest verdict)", () => {
      send(fake, scanResult({ risk: "SAFE" }));
      send(fake, scanResult({ risk: "DANGER" }));
      expect(history()).toHaveLength(1);
      expect(history()[0]?.risk).toBe("DANGER");
    });

    it("keeps the 10 most recent tokens", () => {
      for (let i = 0; i < 12; i++) {
        send(fake, scanResult({ ca: `${"1".repeat(31)}${"123456789ABC"[i]}`, symbol: `T${i}` }));
      }
      expect(history()).toHaveLength(10);
      expect(history()[0]?.symbol).toBe("T11");
    });

    it("GET_HISTORY returns what was recorded", () => {
      send(fake, scanResult());
      const { response } = send(fake, { type: "GET_HISTORY" });
      expect(response).toMatchObject({ ok: true, history: [{ ca: CA, symbol: "WIF", risk: "SAFE" }] });
    });
  });

  describe("refuses what it should not act on", () => {
    it("a message that does not come from this extension", () => {
      const { response } = send(fake, scanResult(), { id: "some-other-extension", tab: { id: 7 } });
      expect(response).toEqual({ ok: false, error: "Unauthorized sender" });
      expect(fake.setBadgeText).not.toHaveBeenCalled();
      expect(Object.keys(fake.storage)).toEqual([]);
    });

    it.each([
      ["a contract address that is not one", { ca: "not-a-contract" }],
      ["no contract address", { ca: undefined }],
      ["an unknown verdict", { risk: "WONDERFUL" }],
      ["no verdict", { risk: undefined }],
      ["a verdict named like an object property", { risk: "constructor" }],
      ["a verdict named like the prototype", { risk: "__proto__" }],
    ])("%s", (_label, over) => {
      const { response } = send(fake, scanResult(over));
      expect(response).toEqual({ ok: false, error: "Invalid scan result" });
      expect(fake.setBadgeText).not.toHaveBeenCalled();
      expect(fake.notificationsCreate).not.toHaveBeenCalled();
      expect(Object.keys(fake.storage)).toEqual([]);
    });

    it("keeps a hostile symbol short and a hostile score numeric", () => {
      send(fake, scanResult({ symbol: "S".repeat(1000), score: "999999" }));
      const row = (fake.storage["antares_scan_history"] as Array<Record<string, unknown>>)[0];
      expect(String(row?.symbol).length).toBe(24);
      expect(row?.score).toBe(0);
    });
  });

  describe("the old SCAN message", () => {
    it("is gone: the worker no longer fetches scans, so it cannot double the API call", () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const { handled } = send(fake, { type: "SCAN", ca: CA });
      expect(handled).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
