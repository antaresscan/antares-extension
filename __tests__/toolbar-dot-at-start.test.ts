// __tests__/toolbar-dot-at-start.test.ts — the toolbar button shows its on/off dot from the first second, and works at once.
//
// Runs the REAL background.ts against an in-memory fake of the chrome.* APIs it uses.
// What this guards: a freshly installed (or just restarted) Antares used to show NO dot until the first click, and that first click
// switched it OFF — so the button looked broken ("it only works after a few seconds / shows no dot"). Now the dot is drawn when the
// extension is installed, updated or started.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/browser", () => ({ init: vi.fn(), captureException: vi.fn() }));

const GREEN = "#00e5b0";
const RED = "#ff5f5f";

interface Fake {
  storage: Record<string, unknown>;
  dots: { text: string; color: string }[];
  titles: string[];
  fireInstalled: () => void;
  fireStartup: () => void;
  click: () => Promise<void>;
}

/** `delayMs` makes the storage slow, like a service worker that has just been started. */
async function loadBackground(opts: { stored?: Record<string, unknown>; delayMs?: number } = {}): Promise<Fake> {
  const storage: Record<string, unknown> = { ...(opts.stored ?? {}) };
  const delayMs = opts.delayMs ?? 0;
  const wait = () => new Promise<void>((r) => setTimeout(r, delayMs));
  const dots: { text: string; color: string }[] = [];
  const titles: string[] = [];
  let pendingText = "";
  let onInstalled: (() => void) | undefined;
  let onStartup: (() => void) | undefined;
  let onClicked: ((tab: unknown) => Promise<void>) | undefined;

  vi.stubGlobal("chrome", {
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    runtime: {
      id: "antares-extension-id",
      lastError: undefined,
      onInstalled: { addListener: (l: () => void) => { onInstalled = l; } },
      onStartup: { addListener: (l: () => void) => { onStartup = l; } },
      onMessage: { addListener: vi.fn() },
      getManifest: () => ({ icons: { "128": "icon128.plasmo.abc.png" } }),
      getURL: (p: string) => `chrome-extension://antares-extension-id/${p}`,
    },
    storage: {
      local: {
        get: (keys: string[], cb?: (r: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in storage) out[k] = storage[k];
          if (cb) { cb(out); return undefined; }
          return wait().then(() => out);
        },
        set: (items: Record<string, unknown>) => wait().then(() => { Object.assign(storage, items); }),
      },
    },
    action: {
      setBadgeText: (a: { text: string }) => { pendingText = a.text; },
      setBadgeBackgroundColor: vi.fn(),
      setBadgeTextColor: (a: { color: string }) => { dots.push({ text: pendingText, color: a.color }); },
      setTitle: (a: { title: string }) => { titles.push(a.title); },
      onClicked: { addListener: (l: (tab: unknown) => Promise<void>) => { onClicked = l; } },
    },
    notifications: { create: vi.fn() },
    tabs: {
      query: (_info: unknown, cb: (t: unknown[]) => void) => { cb([]); },
      create: vi.fn(),
      sendMessage: vi.fn(() => Promise.resolve()),
    },
  });
  vi.resetModules();
  await import("../background");
  return {
    storage,
    dots,
    titles,
    fireInstalled: () => onInstalled?.(),
    fireStartup: () => onStartup?.(),
    click: async () => { await onClicked?.({}); },
  };
}

/** Let the pending promises of the fake storage settle. */
const settle = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the dot is drawn without any click", () => {
  it("a fresh install (nothing stored) shows the GREEN dot straight away, and the tooltip says ON", async () => {
    const fake = await loadBackground();
    await settle();
    expect(fake.dots).toEqual([{ text: "●", color: GREEN }]);
    expect(fake.titles[0]).toMatch(/ON/);
  });

  it("an extension that was switched off keeps showing the RED dot when the browser starts again", async () => {
    const fake = await loadBackground({ stored: { extensionEnabled: false } });
    await settle(); // let the dot drawn by the worker's own start finish first
    fake.dots.length = 0;
    fake.fireStartup();
    await settle();
    expect(fake.dots).toEqual([{ text: "●", color: RED }]);
    expect(fake.titles.at(-1)).toMatch(/OFF/);
  });

  it("installing or updating draws the dot too", async () => {
    const fake = await loadBackground({ stored: { extensionEnabled: true } });
    await settle();
    fake.dots.length = 0;
    fake.fireInstalled();
    await settle();
    expect(fake.dots).toEqual([{ text: "●", color: GREEN }]);
  });
});

describe("the click works at once, right after the worker started", () => {
  it("the first click on a fresh install turns it OFF and draws the RED dot (the dot was already green before it)", async () => {
    const fake = await loadBackground();
    await settle();
    await fake.click();
    expect(fake.storage.extensionEnabled).toBe(false);
    expect(fake.dots.at(-1)).toEqual({ text: "●", color: RED });
  });

  it("a click that arrives while the startup read is still running has the last word (slow storage)", async () => {
    const fake = await loadBackground({ stored: { extensionEnabled: false }, delayMs: 25 });
    await fake.click(); // starts at the same moment as the startup read; the stored OFF becomes ON
    await settle(120);
    expect(fake.storage.extensionEnabled).toBe(true);
    expect(fake.dots.at(-1)).toEqual({ text: "●", color: GREEN });
  });

  it("three clicks in a row end where they should: OFF, ON, OFF", async () => {
    const fake = await loadBackground({ stored: { extensionEnabled: true } });
    await settle();
    await fake.click();
    await fake.click();
    await fake.click();
    expect(fake.dots.slice(-3).map((d) => d.color)).toEqual([RED, GREEN, RED]);
  });
});
