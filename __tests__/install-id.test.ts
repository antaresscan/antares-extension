import { describe, it, expect, beforeEach, vi } from "vitest"
import { getInstallId, _resetInstallIdCacheForTests } from "../shared/install-id"

// Minimal chrome.storage.local stub. Real chrome.storage is unavailable in
// vitest, but the helper only needs `get` and `set` to behave like a tiny
// async key-value store, which is what we wire up here.
function installChromeStorageMock() {
  const store: Record<string, unknown> = {}
  const mock = {
    storage: {
      local: {
        get: vi.fn((key: string) =>
          Promise.resolve({ [key]: store[key] }),
        ),
        set: vi.fn((kv: Record<string, unknown>) => {
          Object.assign(store, kv)
          return Promise.resolve()
        }),
      },
    },
  };
  // chrome is declared globally by @types/chrome; assigning at runtime is safe.
  (globalThis as unknown as { chrome: typeof mock }).chrome = mock
  return { store, mock }
}

function uninstallChromeMock() {
  delete (globalThis as unknown as { chrome?: unknown }).chrome
}

describe("getInstallId", () => {
  beforeEach(() => {
    _resetInstallIdCacheForTests()
    uninstallChromeMock()
  })

  it("generates and persists an id on first call", async () => {
    const { store, mock } = installChromeStorageMock()

    const id = await getInstallId()

    expect(id).toBeTypeOf("string")
    expect(id).toMatch(/^[a-zA-Z0-9_-]{8,128}$/)
    expect(store.antaresInstallId).toBe(id)
    expect(mock.storage.local.set).toHaveBeenCalledTimes(1)
  })

  it("returns the same id on a second call without re-hitting chrome.storage", async () => {
    const { mock } = installChromeStorageMock()

    const first = await getInstallId()
    const second = await getInstallId()

    expect(second).toBe(first)
    // get/set called only on first call thanks to the module-level cache
    expect(mock.storage.local.get).toHaveBeenCalledTimes(1)
    expect(mock.storage.local.set).toHaveBeenCalledTimes(1)
  })

  it("returns the previously stored id on a fresh context (cache miss)", async () => {
    // Pre-seed storage as if a prior install wrote the id, then reset the
    // module cache to simulate a fresh service-worker boot.
    const { store, mock } = installChromeStorageMock()
    store.antaresInstallId = "abc12345-stored-value-xyz"

    const id = await getInstallId()

    expect(id).toBe("abc12345-stored-value-xyz")
    // No new id should be generated when a valid one is already stored.
    expect(mock.storage.local.set).not.toHaveBeenCalled()
  })

  it("regenerates when the stored value fails the install-id format", async () => {
    const { store } = installChromeStorageMock()
    store.antaresInstallId = "x"  // too short, fails INSTALL_ID_RE

    const id = await getInstallId()

    expect(id).not.toBe("x")
    expect(id).toMatch(/^[a-zA-Z0-9_-]{8,128}$/)
    expect(store.antaresInstallId).toBe(id)
  })

  it("regenerates when the stored value is the wrong type", async () => {
    const { store } = installChromeStorageMock()
    store.antaresInstallId = 12345  // wrong type entirely

    const id = await getInstallId()

    expect(typeof id).toBe("string")
    expect(store.antaresInstallId).toBe(id)
  })

  it("returns null when chrome.storage throws", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(() => Promise.reject(new Error("storage unavailable"))),
          set: vi.fn(),
        },
      },
    }

    const id = await getInstallId()

    expect(id).toBeNull()
  })

  it("caches the null failure to avoid re-hitting a broken chrome.storage", async () => {
    const get = vi.fn(() => Promise.reject(new Error("nope")));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { get, set: vi.fn() } },
    }

    const first = await getInstallId()
    const second = await getInstallId()

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("returns null when chrome global itself is missing", async () => {
    // No installChromeStorageMock — `chrome` is undefined.
    const id = await getInstallId()
    expect(id).toBeNull()
  })
})
