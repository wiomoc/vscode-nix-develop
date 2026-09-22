import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/** Repo root: this file lives in `test/`, so its parent is the checkout. */
const ROOT = path.resolve(import.meta.dirname, "..");

/** `c.get<T>("name", <default>)` in config.ts, capturing the name and the default. */
const READ = /c\.get<[^>]+>\(\s*"([^"]+)"\s*,\s*([\s\S]*?)\s*\)(?:\s*\|\||\s*,|\s*\))/g;

/** Parse a literal default from `config.ts`; anything else is `undefined` and skipped. */
function literal(expr: string): unknown {
  const trimmed = expr.trim().replace(/\.trim\(\)$/, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (/^-?\d+(_\d+)*$/.test(trimmed)) return Number(trimmed.replace(/_/g, ""));
  if (/^"([^"\\]*)"$/.test(trimmed)) return trimmed.slice(1, -1);
  return undefined;
}

/** package.json and `readConfig` must declare the same settings with the same defaults. */
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
const source = await fs.readFile(path.join(ROOT, "src", "config.ts"), "utf8");

const contributed = new Map<string, unknown>(
  Object.entries(pkg.contributes.configuration.properties as Record<string, { default: unknown }>)
    .map(([key, value]) => [key.replace(/^nixDevShell\./, ""), value.default]),
);

const read = new Map<string, string>();
for (const m of source.matchAll(READ)) read.set(m[1], m[2]);

describe("settings manifest", () => {
  it("both declarations were found", () => {
    expect(contributed.size > 5, `only ${contributed.size} settings in package.json`).toBe(true);
    expect(read.size > 5, `only ${read.size} c.get calls in config.ts`).toBe(true);
  });

  it("every contributed setting is read by readConfig", () => {
    const orphans = [...contributed.keys()].filter((name) => !read.has(name));
    expect(orphans.length === 0, `contributed but never read: ${orphans.join(", ")}`).toBe(true);
  });

  it("every setting readConfig reads is contributed", () => {
    const undeclared = [...read.keys()].filter((name) => !contributed.has(name));
    expect(undeclared.length === 0, `read but never contributed: ${undeclared.join(", ")}`).toBe(true);
  });

  it("the defaults agree", () => {
    for (const [name, expr] of read) {
      if (!contributed.has(name)) continue;
      const mine = literal(expr);
      if (mine === undefined) continue; // not a literal; nothing to compare
      expect(mine, `default for nixDevShell.${name}`).toEqual(contributed.get(name));
    }
  });

  it("the removed settings are gone from both", () => {
    for (const name of ["devShell", "autoActivate", "remote.patchServerNode"]) {
      expect(contributed.has(name), `nixDevShell.${name} is still contributed`).toBe(false);
      expect(read.has(name), `nixDevShell.${name} is still read by readConfig`).toBe(false);
    }
  });
});
