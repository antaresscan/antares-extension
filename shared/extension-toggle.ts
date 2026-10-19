// shared/extension-toggle.ts — the on/off button of the toolbar icon.
//
// The state lives in chrome.storage.local (key below), never in a variable of the service worker: a Manifest V3 service worker
// is stopped when idle and started again by the very click that needs it, with all its variables back at their defaults.

export const EXTENSION_ENABLED_KEY = "extensionEnabled"

/** The state after a click, given what is stored: anything but a stored boolean means "enabled" (the default), so the click turns it off. */
export function nextEnabledState(stored: unknown): boolean {
  return typeof stored === "boolean" ? !stored : false
}

/** What the toolbar dot must show, given what is stored: only an explicit `false` means OFF. Nothing stored = a fresh install = ON. */
export function enabledFromStored(stored: unknown): boolean {
  return stored !== false
}

type Storage = {
  get: (keys: string[]) => Promise<Record<string, unknown>>
  set: (items: Record<string, unknown>) => Promise<void>
}

// Clicks run one after the other: two quick clicks must flip the state twice, not both read the same old value.
let queue: Promise<unknown> = Promise.resolve()

/**
 * Flip the stored on/off state and return the new one. The current state is READ FROM THE STORAGE at click time. It used to be
 * a variable filled by an asynchronous read at startup: a click that woke the service worker ran before that read finished,
 * saw the default (enabled) and flipped from there, so a click meant to turn a disabled extension back ON switched it off again.
 */
export function toggleExtensionEnabled(storage: Storage): Promise<boolean> {
  const run = queue.then(async () => {
    const stored = await storage.get([EXTENSION_ENABLED_KEY])
    const enabled = nextEnabledState(stored?.[EXTENSION_ENABLED_KEY])
    await storage.set({ [EXTENSION_ENABLED_KEY]: enabled })
    return enabled
  })
  queue = run.catch(() => undefined)
  return run
}
