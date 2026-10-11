// scripts/smoke-options.mjs
//
// CI smoke test for the packaged Options page (options.html + options.*.js).
//
// Companion of scripts/smoke-bundle.mjs (which covers the content script).
// Why it exists: on 2026-10-09 Dependabot bumped react without react-dom,
// the lockfile ended up with react 19.3.0 + react-dom 19.2.7, and the built
// Options page crashed on load ("Minified React error #527"). Nothing in CI
// evaluated options.*.js, so the broken bundle looked fine. This smoke does:
// it loads the REAL built options.html into happy-dom + the chrome.* shim,
// evaluates options.*.js, fires DOMContentLoaded (that is when Plasmo calls
// createRoot().render()) and asserts the page really rendered.
//
// What "passes" means:
//   1. options.html exists and references the options.*.js bundle.
//   2. The bundle evaluates without throwing (this is where React's
//      react/react-dom version check fires).
//   3. No uncaught error, unhandled rejection or console.error happens
//      while it mounts.
//   4. #__plasmo ends up non-empty — the settings UI is on screen.
//
// Usage: `npm run smoke` (after `npx plasmo build`).
//
// IMPORTANT: happy-dom, not real Chrome — it catches the BOOT/RENDER crash
// class (version mismatch, missing global, throw in the first render), not
// extension-runtime behaviour.

import { Window } from 'happy-dom'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { baseChromeShim, installDomGlobals, setGlobal } from './lib/smoke-env.mjs'

const BUILD_DIR = 'build/chrome-mv3-prod'
const RENDER_TIMEOUT_MS = 5000

function fail(msg, ...details) {
  console.error(`FAIL: ${msg}`)
  for (const d of details) console.error(`       ${d}`)
  process.exit(1)
}

let entries
try {
  entries = readdirSync(BUILD_DIR)
} catch (e) {
  fail(`cannot read ${BUILD_DIR} — did you run \`npx plasmo build\`?`, `(${e.message})`)
}

// Plasmo content-hashes the bundle name (`options.95eda3f3.js`); don't
// hardcode it.
const bundleName = entries.find((f) => /^options\..*\.js$/.test(f))
if (!bundleName) fail(`no options.*.js bundle found in ${BUILD_DIR}`, `files: ${entries.join(', ')}`)
if (!entries.includes('options.html')) fail(`no options.html found in ${BUILD_DIR}`)

const html = readFileSync(join(BUILD_DIR, 'options.html'), 'utf8')
if (!html.includes(bundleName)) {
  fail('options.html does not reference the options bundle', `bundle: ${bundleName}`)
}
if (!html.includes('id="__plasmo"')) fail('options.html has no #__plasmo mount point')

const win = new Window({ url: 'chrome-extension://abc/options.html' })
const doc = win.document
doc.body.innerHTML = '<div id="__plasmo"></div>'

installDomGlobals(win)
// The Options page uses more of the DOM and of chrome.* than the content
// script's boot path does.
for (const k of [
  'Event',
  'CustomEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'MessageChannel',
]) {
  if (win[k] !== undefined) setGlobal(k, win[k])
}
const noopEvent = { addListener() {}, removeListener() {}, hasListener: () => false }
const chromeShim = baseChromeShim()
Object.assign(chromeShim.runtime, {
  onMessage: noopEvent,
  getManifest: () => ({ version: '0.0.0', icons: {} }),
  getURL: (p) => `chrome-extension://abc/${p}`,
})
chromeShim.storage.local.get = (_keys, cb) => (cb ? cb({}) : Promise.resolve({}))
chromeShim.storage.local.set = (_items, cb) => (cb ? cb() : Promise.resolve())
chromeShim.storage.local.remove = (_keys, cb) => (cb ? cb() : Promise.resolve())
chromeShim.storage.onChanged = noopEvent
chromeShim.permissions = {
  contains: (_p, cb) => (cb ? cb(true) : Promise.resolve(true)),
  request: (_p, cb) => (cb ? cb(true) : Promise.resolve(true)),
}
chromeShim.notifications = { create: () => {}, onClicked: noopEvent }
chromeShim.alarms = { create() {}, onAlarm: noopEvent }
chromeShim.tabs = { query: () => Promise.resolve([]) }
globalThis.chrome = chromeShim

// Everything that goes wrong while the page mounts ends up here.
const problems = []
win.addEventListener('error', (e) => problems.push(`window error: ${e.error?.message ?? e.message}`))
process.on('uncaughtException', (e) => problems.push(`uncaught exception: ${e?.message ?? e}`))
process.on('unhandledRejection', (e) => problems.push(`unhandled rejection: ${e?.message ?? e}`))
const realConsoleError = console.error
console.error = (...args) => {
  problems.push(`console.error: ${args.map(String).join(' ').slice(0, 300)}`)
  realConsoleError(...args)
}

const code = readFileSync(join(BUILD_DIR, bundleName), 'utf8')
try {
  // eslint-disable-next-line no-new-func
  new Function(code)()
} catch (e) {
  fail('Options bundle threw on evaluation', `bundle: ${bundleName}`, `error : ${e.message}`)
}

// Plasmo mounts React on DOMContentLoaded (createRoot().render()).
doc.dispatchEvent(new win.Event('DOMContentLoaded'))

const root = doc.getElementById('__plasmo')
const deadline = Date.now() + RENDER_TIMEOUT_MS
while (Date.now() < deadline && !(root && root.children.length > 0)) {
  await new Promise((r) => setTimeout(r, 50))
}
// Let any error thrown right after the first commit surface.
await new Promise((r) => setTimeout(r, 300))
console.error = realConsoleError

if (problems.length > 0) {
  fail('Options page raised errors while mounting', `bundle: ${bundleName}`, ...problems)
}
if (!root || root.children.length === 0 || !root.textContent.trim()) {
  fail(
    `Options page rendered nothing into #__plasmo within ${RENDER_TIMEOUT_MS} ms`,
    `bundle: ${bundleName}`,
    'the bundle evaluated but React never produced any UI',
  )
}

console.log('OK: Options page bundle evaluated and rendered')
console.log(`    bundle      : ${bundleName}`)
console.log(`    #__plasmo   : ${root.children.length} child(ren), ${root.textContent.trim().length} chars of text`)
process.exit(0)
