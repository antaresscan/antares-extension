import { describe, it, expect } from "vitest";
import { nextEnabledState, toggleExtensionEnabled, EXTENSION_ENABLED_KEY } from "../shared/extension-toggle";

// A chrome.storage.local stand-in; `delayMs` makes reads slow, like a service worker that has just been started.
function fakeStorage(initial: Record<string, unknown> = {}, delayMs = 0) {
  const data: Record<string, unknown> = { ...initial };
  const wait = () => new Promise<void>((r) => setTimeout(r, delayMs));
  return {
    data,
    get: async (keys: string[]) => { await wait(); return Object.fromEntries(keys.map((k) => [k, data[k]])); },
    set: async (items: Record<string, unknown>) => { await wait(); Object.assign(data, items); },
  };
}

// Audit A-23: the toggle used to flip an in-memory variable that an asynchronous read had not filled yet.
describe("nextEnabledState", () => {
  it("flips a stored boolean", () => {
    expect(nextEnabledState(true)).toBe(false);
    expect(nextEnabledState(false)).toBe(true);
  });

  it("nothing stored (or junk) counts as enabled, so the click turns it off", () => {
    expect(nextEnabledState(undefined)).toBe(false);
    expect(nextEnabledState(null)).toBe(false);
    expect(nextEnabledState("yes")).toBe(false);
    expect(nextEnabledState(1)).toBe(false);
  });
});

describe("toggleExtensionEnabled", () => {
  it("a click on a DISABLED extension, even right after the worker started, turns it back ON", async () => {
    const storage = fakeStorage({ [EXTENSION_ENABLED_KEY]: false }, 20); // slow storage: the old startup read would not be back yet
    const enabled = await toggleExtensionEnabled(storage);
    expect(enabled).toBe(true);
    expect(storage.data[EXTENSION_ENABLED_KEY]).toBe(true);
  });

  it("a click on an enabled extension turns it OFF and stores it", async () => {
    const storage = fakeStorage({ [EXTENSION_ENABLED_KEY]: true });
    expect(await toggleExtensionEnabled(storage)).toBe(false);
    expect(storage.data[EXTENSION_ENABLED_KEY]).toBe(false);
  });

  it("first click ever (nothing stored): turns it OFF", async () => {
    const storage = fakeStorage();
    expect(await toggleExtensionEnabled(storage)).toBe(false);
  });

  it("two quick clicks flip the state twice: they do not both read the same old value", async () => {
    const storage = fakeStorage({ [EXTENSION_ENABLED_KEY]: true }, 10);
    const [first, second] = await Promise.all([toggleExtensionEnabled(storage), toggleExtensionEnabled(storage)]);
    expect([first, second]).toEqual([false, true]);
    expect(storage.data[EXTENSION_ENABLED_KEY]).toBe(true);
  });

  it("a storage failure rejects that click but does not block the next ones", async () => {
    const failing = { get: async () => { throw new Error("storage down"); }, set: async () => undefined };
    await expect(toggleExtensionEnabled(failing)).rejects.toThrow(/storage down/);
    const ok = fakeStorage({ [EXTENSION_ENABLED_KEY]: false });
    expect(await toggleExtensionEnabled(ok)).toBe(true);
  });
});
