// scripts/lib/smoke-env.mjs
//
// Shared by scripts/smoke-bundle.mjs (content script) and
// scripts/smoke-options.mjs (Options page): the happy-dom globals and the
// minimal `chrome.*` shim the packaged bundles need to boot in Node.
// Kept in one place so the two smokes cannot drift apart.

// Some globals (navigator, crypto) are read-only getters in Node 22+ —
// use defineProperty to override them. The rest can take normal
// assignment.
export function setGlobal(name, value) {
  try {
    globalThis[name] = value
  } catch {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
}

// happy-dom doesn't export every global Plasmo bundles expect. Map the
// ones we know the bundles' transitive imports touch at boot time
// (verified by past bundle audits).
export function installDomGlobals(win) {
  const doc = win.document
  setGlobal('window', win)
  setGlobal('document', doc)
  setGlobal('location', win.location)
  setGlobal('history', win.history)
  setGlobal('navigator', win.navigator)
  setGlobal('HTMLElement', win.HTMLElement)
  setGlobal('HTMLDivElement', win.HTMLDivElement)
  setGlobal('Element', win.Element)
  setGlobal('Node', win.Node)
  setGlobal('MutationObserver', win.MutationObserver)
  setGlobal('localStorage', win.localStorage)
  setGlobal('sessionStorage', win.sessionStorage)
  setGlobal('AbortController', win.AbortController)
  setGlobal('fetch', win.fetch)
  setGlobal('XMLHttpRequest', win.XMLHttpRequest)
  setGlobal('performance', win.performance)
  setGlobal('PerformanceObserver', win.PerformanceObserver ?? class { observe() {} disconnect() {} })
  setGlobal('addEventListener', win.addEventListener.bind(win))
  setGlobal('removeEventListener', win.removeEventListener.bind(win))
  // Node 20+ already ships globalThis.crypto via WebCrypto; skip
  // overriding to keep crypto.randomUUID etc. available to install-id.
}

// Minimal `chrome.*` shim — just enough surface for a bundle's boot path
// to traverse without ReferenceError. We don't simulate the real APIs
// (storage doesn't persist, sendMessage doesn't dispatch), only the
// shapes the boot path probes for capability detection.
export function baseChromeShim() {
  return {
    runtime: {
      id: 'abc',
      onMessage: { addListener: () => {} },
      sendMessage: () => Promise.resolve({}),
      lastError: null,
    },
    storage: {
      local: {
        get: (_keys, cb) => cb && cb({}),
        set: (_items, cb) => cb && cb(),
      },
      onChanged: { addListener: () => {} },
    },
  }
}
