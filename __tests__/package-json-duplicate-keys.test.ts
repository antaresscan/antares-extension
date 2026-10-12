// __tests__/package-json-duplicate-keys.test.ts — package.json and package-lock.json must never
// list the same key twice in one object, and the lock's root entry must list the same
// dependencies as package.json.
//
// Why: Dependabot squash-merges were stacking their lines on top of lines that were already
// there (#793 on top of #792, then #830 on top of #832), which left "@playwright/test",
// "@types/chrome", "@types/react-dom" and "@vercel/node" twice in the devDependencies. JSON.parse
// keeps the LAST duplicate without a word, so tools quietly read the stale version while the
// lockfile resolved another one, and `npm ci` refused to install (EUSAGE, lock file does not
// satisfy package.json). CI runs `npm install`, which papers over the mismatch, so nothing went
// red. This test fails on the first duplicate, whoever introduced it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Paths of the keys that appear more than once in one JSON object ("devDependencies > a").
 * JSON.parse cannot tell: it keeps the last one. A small scanner is enough for well-formed JSON.
 */
function findDuplicateKeys(text: string): string[] {
  const duplicates: string[] = [];
  let i = 0;

  const skipSpaces = (): void => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const readString = (): string => {
    let out = "";
    i++; // opening quote
    while (text[i] !== '"') {
      if (text[i] === "\\") {
        out += text[i] + text[i + 1];
        i += 2;
      } else {
        out += text[i++];
      }
    }
    i++; // closing quote
    return out;
  };
  const readValue = (path: string): void => {
    skipSpaces();
    const c = text[i];
    if (c === "{") {
      i++;
      const seen = new Set<string>();
      skipSpaces();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        skipSpaces();
        const key = readString();
        const keyPath = path ? `${path} > ${key}` : key;
        if (seen.has(key)) duplicates.push(keyPath);
        seen.add(key);
        skipSpaces();
        i++; // colon
        readValue(keyPath);
        skipSpaces();
        if (text[i++] === ",") continue;
        return; // closing brace
      }
    } else if (c === "[") {
      i++;
      skipSpaces();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        readValue(path);
        skipSpaces();
        if (text[i++] === ",") continue;
        return; // closing bracket
      }
    } else if (c === '"') {
      readString();
    } else {
      while (i < text.length && !/[\s,\]}]/.test(text[i])) i++; // number, true, false, null
    }
  };

  readValue("");
  return duplicates;
}

describe("findDuplicateKeys (the detector itself)", () => {
  it("reports a key repeated in the same object, with its path", () => {
    const text = '{ "devDependencies": { "a": "1", "b": "1", "a": "2" } }';
    expect(findDuplicateKeys(text)).toEqual(["devDependencies > a"]);
  });

  it("does not report the same key in two different objects", () => {
    expect(findDuplicateKeys('{ "x": { "a": 1 }, "y": { "a": 2 } }')).toEqual([]);
  });

  it("is not fooled by braces, quotes and commas inside strings, nor by arrays and literals", () => {
    const text = '{ "a": "}\\"{,", "b": [1, true, null, { "c": 1 }, { "c": 2 }], "d": {} , "e": [] }';
    expect(findDuplicateKeys(text)).toEqual([]);
  });
});

describe("package.json / package-lock.json", () => {
  const root = resolve(__dirname, "..");
  const read = (file: string): string => readFileSync(resolve(root, file), "utf8");

  it("package.json lists no key twice", () => {
    expect(findDuplicateKeys(read("package.json"))).toEqual([]);
  });

  it("package-lock.json lists no key twice", () => {
    expect(findDuplicateKeys(read("package-lock.json"))).toEqual([]);
  });

  it("the root entry of package-lock.json lists the same dependencies as package.json", () => {
    // This is what `npm ci` checks first; CI runs `npm install`, which would hide a difference.
    type Deps = Record<string, string>;
    interface Manifest {
      dependencies?: Deps;
      devDependencies?: Deps;
      optionalDependencies?: Deps;
      peerDependencies?: Deps;
    }
    const pkg = JSON.parse(read("package.json")) as Manifest;
    const lockRoot = (JSON.parse(read("package-lock.json")) as { packages: Record<string, Manifest> })
      .packages[""];
    for (const block of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
      expect(lockRoot[block] ?? {}, `${block}: package-lock.json root entry differs from package.json`).toEqual(
        pkg[block] ?? {},
      );
    }
  });
});
