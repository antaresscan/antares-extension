// __tests__/e2e-needed.test.ts
//
// The CI e2e job runs only when a run can change what is deployed (or the e2e
// itself). The decision lives in .github/scripts/e2e-needed.mjs. A wrong "skip"
// lets a deployment-level break through unseen; a wrong "run" brings back the
// minutes and the unrelated reds this exists to remove. So the rules are pinned.
import { describe, it, expect } from "vitest";

interface Decision { needed: boolean; reasons: string[] }
interface Pkg { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: Record<string, string>; scripts?: Record<string, string> }
interface Lock { packages: Record<string, { version?: string; dev?: boolean }> }
interface Api {
  decide(input: { files: string[] | null; base?: { pkg: Pkg | null; lock: Lock | null }; head?: { pkg: Pkg | null; lock: Lock | null } }): Decision;
  classifyFiles(files: string[]): { deployed: string[]; infra: string[] };
  productionFingerprint(pkg: Pkg | null, lock: Lock | null): string | null;
  toolingFingerprint(pkg: Pkg | null, lock: Lock | null): string | null;
}

// .mjs is not type-checked in this repo: load it dynamically.
const api = (await import(/* @vite-ignore */ new URL("../.github/scripts/e2e-needed.mjs", import.meta.url).href)) as unknown as Api;

// A minimal project: one production dependency, one dev dependency, and the e2e runner.
const pkg = (over: Partial<Pkg> = {}): Pkg => ({
  dependencies: { "@sentry/node": "10.66.0", ...over.dependencies },
  devDependencies: { tsx: "4.23.1", "@playwright/test": "1.62.1", ...over.devDependencies },
  engines: over.engines,
  scripts: { build: "plasmo build", ...over.scripts },
});
const lock = (over: Record<string, { version?: string; dev?: boolean }> = {}): Lock => ({
  packages: {
    "": {},
    "node_modules/@sentry/node": { version: "10.66.0" },
    "node_modules/tsx": { version: "4.23.1", dev: true },
    "node_modules/@playwright/test": { version: "1.62.1", dev: true },
    "node_modules/playwright": { version: "1.62.1", dev: true },
    ...over,
  },
});
const same = () => ({ pkg: pkg(), lock: lock() });

describe("files that put the e2e to work", () => {
  it.each([
    "api/scan.ts",
    "api/_lib/layers.ts",
    "shared/constants.ts",
    "js/token-app.js",
    "token.html",
    "privacy.html",
    "vercel.json",
    "tsconfig.json",
  ])("deployed file %s → run", (f) => {
    const d = api.decide({ files: [f] });
    expect(d.needed).toBe(true);
    expect(d.reasons[0]).toContain(f);
  });

  it.each([
    "e2e/api-scan.spec.ts",
    "playwright.config.ts",
    ".github/workflows/ci.yml",
    ".github/scripts/resolve-deployment.sh",
    ".github/scripts/e2e-needed.mjs",
  ])("the e2e or its wiring %s → run (a change to it must be tested)", (f) => {
    expect(api.decide({ files: [f] }).needed).toBe(true);
  });
});

describe("files that cannot change an HTTP response", () => {
  it.each([
    "contents/modules/cache.ts", // extension overlay
    "background.ts",
    "options.tsx",
    "popup.tsx",
    "assets/icon.png",
    "__tests__/scan.test.ts",
    "scripts/load-test.mjs",
    "README.md",
    "OPERATIONS.md",
    "docs/cws/listing.md",
    ".github/workflows/secret-scan.yml", // not the CI workflow
    ".github/dependabot.yml",
    "eslint.config.mjs",
    ".gitignore",
  ])("%s → skip", (f) => {
    const d = api.decide({ files: [f] });
    expect(d.needed).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it("a mixed change runs as soon as ONE file matters, and lists only those", () => {
    const d = api.decide({ files: ["README.md", "contents/x.ts", "api/health.ts", "__tests__/a.test.ts"] });
    expect(d.needed).toBe(true);
    expect(d.reasons).toEqual(["deployed file changed: api/health.ts"]);
  });

  it("an empty change set skips", () => {
    expect(api.decide({ files: [] }).needed).toBe(false);
  });

  it("does not mistake look-alike paths for deployed ones", () => {
    for (const f of ["docs/api/guide.md", "scripts/api/x.ts", "contents/shared/x.ts", "e2e-notes.md", "myvercel.json", "docs/token.html"]) {
      expect(api.decide({ files: [f] }).needed, f).toBe(false);
    }
  });
});

describe("dependency changes: only what reaches production counts", () => {
  const withPkgFiles = ["package.json", "package-lock.json"];

  it("a dev-only bump (typescript-eslint, tsx, @types/*) → skip", () => {
    const head = { pkg: pkg({ devDependencies: { tsx: "4.23.15", "@playwright/test": "1.62.1" } }), lock: lock({ "node_modules/tsx": { version: "4.23.15", dev: true } }) };
    const d = api.decide({ files: withPkgFiles, base: same(), head });
    expect(d.needed).toBe(false);
  });

  it("a production dependency bump (@sentry/node) → run", () => {
    const head = { pkg: pkg({ dependencies: { "@sentry/node": "10.76.1" } }), lock: lock({ "node_modules/@sentry/node": { version: "10.76.1" } }) };
    const d = api.decide({ files: withPkgFiles, base: same(), head });
    expect(d.needed).toBe(true);
    expect(d.reasons).toContain("a production dependency, engine or build script changed");
  });

  it("a TRANSITIVE production package moving in the lockfile alone → run", () => {
    const head = { pkg: pkg(), lock: lock({ "node_modules/some-transitive": { version: "2.0.1" } }) };
    expect(api.decide({ files: ["package-lock.json"], base: same(), head }).needed).toBe(true);
  });

  it("a dev-only transitive package in the lockfile → skip", () => {
    const head = { pkg: pkg(), lock: lock({ "node_modules/some-dev-thing": { version: "1.2.3", dev: true } }) };
    expect(api.decide({ files: ["package-lock.json"], base: same(), head }).needed).toBe(false);
  });

  it("the build script or the Node engine changing → run", () => {
    const changes: Array<Partial<Pkg>> = [
      { scripts: { build: "plasmo build --tag=x" } },
      { engines: { node: ">=22" } },
      { scripts: { "vercel-build": "tsc" } },
    ];
    for (const over of changes) {
      const head = { pkg: pkg(over), lock: lock() };
      expect(api.decide({ files: ["package.json"], base: same(), head }).needed, JSON.stringify(over)).toBe(true);
    }
  });

  it("the e2e runner (@playwright/test) changing → run, even though it is a devDependency", () => {
    const head = { pkg: pkg({ devDependencies: { tsx: "4.23.1", "@playwright/test": "1.63.0" } }), lock: lock({ "node_modules/@playwright/test": { version: "1.63.0", dev: true } }) };
    const d = api.decide({ files: withPkgFiles, base: same(), head });
    expect(d.needed).toBe(true);
    expect(d.reasons).toContain("the e2e runner (@playwright/test) changed");
  });

  it("package files touched but nothing that matters changed (formatting, reorder) → skip", () => {
    const reordered = { pkg: { ...pkg(), devDependencies: { "@playwright/test": "1.62.1", tsx: "4.23.1" } }, lock: lock() };
    expect(api.decide({ files: withPkgFiles, base: same(), head: reordered }).needed).toBe(false);
  });

  it("when the package files cannot be read or compared → run (never skip on doubt)", () => {
    expect(api.decide({ files: ["package.json"], base: { pkg: null, lock: null }, head: same() }).needed).toBe(true);
    expect(api.decide({ files: ["package.json"], base: same(), head: { pkg: pkg(), lock: null } }).needed).toBe(true);
    expect(api.decide({ files: ["package-lock.json"], base: same(), head: { pkg: pkg(), lock: { packages: undefined } as unknown as Lock } }).needed).toBe(true);
  });

  it("package files are ignored entirely when neither was changed", () => {
    const head = { pkg: pkg({ dependencies: { "@sentry/node": "99.0.0" } }), lock: lock() };
    expect(api.decide({ files: ["README.md"], base: same(), head }).needed).toBe(false);
  });
});

describe("fail-safe", () => {
  it("an unknown file list (API error, truncated diff) → run", () => {
    const d = api.decide({ files: null });
    expect(d.needed).toBe(true);
    expect(d.reasons[0]).toMatch(/could not list/);
  });
});

describe("fingerprints", () => {
  it("are stable for identical input and null when the lockfile is unusable", () => {
    expect(api.productionFingerprint(pkg(), lock())).toBe(api.productionFingerprint(pkg(), lock()));
    expect(api.productionFingerprint(pkg(), null)).toBeNull();
    expect(api.toolingFingerprint(null, lock())).toBeNull();
  });

  it("ignore dev packages for production and include the runner for tooling", () => {
    const withDev = lock({ "node_modules/extra-dev": { version: "1.0.0", dev: true } });
    expect(api.productionFingerprint(pkg(), withDev)).toBe(api.productionFingerprint(pkg(), lock()));
    const newRunner = lock({ "node_modules/@playwright/test": { version: "9.9.9", dev: true } });
    expect(api.toolingFingerprint(pkg(), newRunner)).not.toBe(api.toolingFingerprint(pkg(), lock()));
  });
});
