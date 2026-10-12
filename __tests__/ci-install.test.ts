// __tests__/ci-install.test.ts — how the project's dependencies are classified, and how CI
// installs them.
//
// Duplicated keys in package.json / package-lock.json and a lockfile that drifts from
// package.json are guarded by __tests__/package-json-duplicate-keys.test.ts. This file guards the
// rest of audit A-27:
//   - plasmo only BUILDS the extension (two `import type` in content scripts, never shipped), but
//     sitting in `dependencies` it made `npm audit --omit=dev` report 88 "production"
//     vulnerabilities, all in the build toolchain;
//   - CI used `npm install` for months because the strict `npm ci` rejected the lockfile. That
//     workaround silently ignores a package.json / lockfile mismatch, so it must not come back.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

interface PackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

describe("dependency classification", () => {
  it("build-only tools stay in devDependencies (they are not shipped, and made `npm audit` cry wolf)", () => {
    const pkg = JSON.parse(read("package.json")) as PackageJson;
    expect(Object.keys(pkg.dependencies)).not.toContain("plasmo");
    expect(Object.keys(pkg.devDependencies)).toContain("plasmo");
  });
});

describe("CI installs dependencies with `npm ci`", () => {
  const workflows = readdirSync(resolve(root, ".github/workflows")).filter((f) => f.endsWith(".yml"));

  it("no workflow runs `npm install` (it silently ignores a lockfile that is out of sync)", () => {
    expect(workflows.length).toBeGreaterThan(0);
    for (const f of workflows) {
      expect(read(`.github/workflows/${f}`), f).not.toMatch(/npm install/);
    }
  });

  it("the shared install action runs `npm ci`", () => {
    expect(read(".github/actions/install-deps/action.yml")).toMatch(/retry npm ci /);
  });

  it("every workflow that sets up Node installs through the shared action", () => {
    for (const f of workflows) {
      const text = read(`.github/workflows/${f}`);
      if (/actions\/setup-node/.test(text)) expect(text, f).toContain("./.github/actions/install-deps");
    }
  });
});
