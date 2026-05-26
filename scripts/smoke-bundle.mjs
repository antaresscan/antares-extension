// scripts/smoke-bundle.mjs
//
// CI smoke test for the packaged content-script bundle.
//
// Loads `build/chrome-mv3-prod/antares-inject.*.js` into happy-dom +
// a minimal `chrome.*` shim and evaluates it. Catches the class of
// crash that breaks the overlay silently — Sentry.init throwing at
// init, a Zod schema import that throws on the user's Chrome (the
// 2026-05-19 → 2026-05-20 incident), an undefined global, a top-
// level await hanging — without needing a headed Chrome and without
// waiting for Playwright + extension load (~1s vs 10-15s).
//
// Wired into .github/workflows/ci.yml after `npm run build` so the
// CI fails the moment the bundle won't evaluate. The historical
// failure mode of incident PR #510 was that the bundle imported the
// Zod schema at module top level, throwing on the user's Chrome;
// nothing in the CI exercised the actual packaged bundle so the bug
// shipped. This smoke prevents that re-occurring.
//
// What "passes" means:
//   1. The bundle script body evaluates without throwing.
//   2. The GUARD attribute (`<html data-antares-init="1">`) gets set
//      — proves antares-inject.ts's top-level init ran to completion.
//      If GUARD is missing, an early exception killed the script.
//
// Usage: `npm run smoke` (after `npm run build`).
//
// IMPORTANT: this is happy-dom, not real Chrome. Some Chrome-specific
// behaviour (extension service workers, web_accessible_resources)
// won't be exercised — that's fine, this catches the BOOT-TIME
// crash class which is where regressions hide. Real-Chrome E2E
// (e2e/extension-overlay-mount.spec.ts) covers the rest, but is
// skipped in CI until xvfb wiring lands.

import { Window } from 'happy-dom'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const BUILD_DIR = 'build/chrome-mv3-prod'

// Plasmo emits a content-hash in the bundle filename
// (`antares-inject.4d00d23c.js`) that changes on every build —
// hardcoding the hash would silently rot. Pick the first match;
// there's only ever one `antares-inject.*` bundle per build.
let entries
try {
  entries = readdirSync(BUILD_DIR)
} catch (e) {
  console.error(`FAIL: cannot read ${BUILD_DIR} — did you run \`npm run build\`?`)
  console.error(`       (${e.message})`)
  process.exit(1)
}

const bundleName = entries.find((f) => /^antares-inject\..*\.js$/.test(f))
if (!bundleName) {
  console.error(`FAIL: no antares-inject.*.js bundle found in ${BUILD_DIR}`)
  console.error(`       files: ${entries.join(', ')}`)
  process.exit(1)
}
const bundlePath = join(BUILD_DIR, bundleName)

const win = new Window({ url: 'https://dexscreener.com/solana/abc' })
const doc = win.document

// happy-dom doesn't export every global Plasmo bundles expect. Map
// the ones we know antares-inject's transitive imports touch at boot
// time (verified by past bundle audits).
// Some globals (navigator, crypto) are read-only getters in Node 22+
// — use defineProperty to override them. The rest can take normal
// assignment.
function setGlobal(name, value) {
  try {
    globalThis[name] = value
  } catch {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
}
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

// Minimal `chrome.*` shim — just enough surface for antares-inject.ts
// boot to traverse without ReferenceError. We don't simulate the
// real APIs (storage doesn't persist, sendMessage doesn't dispatch),
// only the shapes the boot path probes for capability detection.
globalThis.chrome = {
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

const code = readFileSync(bundlePath, 'utf8')

try {
  // eslint-disable-next-line no-new-func
  const fn = new Function(code)
  fn()
} catch (e) {
  console.error(`FAIL: content-script bundle threw on evaluation`)
  console.error(`       bundle: ${bundlePath}`)
  console.error(`       error : ${e.message}`)
  console.error(e.stack?.split('\n').slice(0, 10).join('\n'))
  process.exit(1)
}

// Validate GUARD attribute is set — proves antares-inject.ts ran past
// its top-level init without throwing. If this is missing, something
// in the boot chain (Sentry.init, Zod validation, module imports,
// scrubEvent, etc.) silently killed the script.
const guard = doc.documentElement.getAttribute('data-antares-init')
if (guard !== '1') {
  console.error(`FAIL: GUARD attribute "data-antares-init" was not set`)
  console.error(`       this means content-script boot never reached the end`)
  console.error(`       of its top-level init block — probably an early throw`)
  console.error(`       swallowed by a try/catch or Sentry.init.`)
  process.exit(1)
}

console.log(`OK: content-script bundle evaluated cleanly`)
console.log(`    bundle      : ${bundleName}`)
console.log(`    GUARD attr  : ${guard}`)
console.log(`    DOM nodes   : ${doc.querySelectorAll('*').length}`)
