// __tests__/package-hygiene.test.ts — guards on package.json / package-lock.json
// and on how CI installs them.
//
// Why: twice in two days (#828, #839) two Dependabot PRs merged one after the
// other left a DUPLICATED key in package.json's devDependencies. JSON.parse
// keeps the last one silently, but the lockfile had been written for the
// first one, so `npm ci` refused to install ("lock file's @types/chrome@0.3.4
// does not satisfy @types/chrome@0.2.2") and CI had been papering over it
// with `npm install`. These tests fail the moment that happens again.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(resolve(root, rel), "utf8");

interface PackageJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
interface PackageLock {
  packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
}

/** Keys repeated inside the same JSON object, as `parentKey.key`. JSON.parse hides them. */
function findDuplicateKeys(json: string): string[] {
  const dups: string[] = [];
  const stack: Array<{ keys: Set<string> | null; name: string }> = [];
  let lastKey = "";
  let i = 0;
  while (i < json.length) {
    const c = json[i];
    if (c === "{") {
      stack.push({ keys: new Set(), name: lastKey });
      i++;
    } else if (c === "[") {
      stack.push({ keys: null, name: lastKey });
      i++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      const str = json.slice(i + 1, j);
      i = j + 1;
      let k = i;
      while (k < json.length && /\s/.test(json[k])) k++;
      const top = stack[stack.length - 1];
      if (json[k] === ":" && top?.keys) {
        if (top.keys.has(str)) dups.push(`${top.name || "(root)"}.${str}`);
        else top.keys.add(str);
        lastKey = str;
        i = k + 1;
      }
    } else {
      i++;
    }
  }
  return dups;
}

describe("findDuplicateKeys (the detector itself)", () => {
  it("finds a key repeated in the same object, whatever the nesting", () => {
    expect(findDuplicateKeys('{"devDependencies":{"a":"1","b":"2","a":"3"}}')).toEqual(["devDependencies.a"]);
  });
  it("ignores the same key in different objects, strings and arrays", () => {
    expect(findDuplicateKeys('{"x":{"a":"1"},"y":{"a":"1"},"z":["a","a",{"a":"a"}],"a":"a"}')).toEqual([]);
  });
});

describe("package.json / package-lock.json", () => {
  it("package.json has no duplicated key", () => {
    expect(findDuplicateKeys(read("package.json"))).toEqual([]);
  });

  it("package-lock.json has no duplicated key", () => {
    expect(findDuplicateKeys(read("package-lock.json"))).toEqual([]);
  });

  it("the lockfile root entry lists exactly the dependencies of package.json (what `npm ci` checks)", () => {
    const pkg = JSON.parse(read("package.json")) as PackageJson;
    const lock = JSON.parse(read("package-lock.json")) as PackageLock;
    const rootEntry = lock.packages[""];
    expect(rootEntry?.dependencies).toEqual(pkg.dependencies);
    expect(rootEntry?.devDependencies).toEqual(pkg.devDependencies);
  });

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

  it("every workflow that installs does it through the shared action", () => {
    for (const f of workflows) {
      const text = read(`.github/workflows/${f}`);
      if (/actions\/setup-node/.test(text)) expect(text, f).toContain("./.github/actions/install-deps");
    }
  });
});
