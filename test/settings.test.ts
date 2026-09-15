import * as fs from "node:fs/promises";
import * as path from "node:path";
import { eq, ok, test } from "./harness";

/** Repo root: the bundle lives in `out/`, so its parent is the checkout. */
const ROOT = path.resolve(__dirname, "..");

/** `c.get<T>("name", <default>)` in config.ts, capturing the name and the default. */
const READ = /c\.get<[^>]+>\(\s*"([^"]+)"\s*,\s*([\s\S]*?)\s*\)(?:\s*\|\||\s*,|\s*\))/g;

/**
 * Parse the default expression as far as a manifest default can be compared to it.
 *
 * `config.ts` writes defaults as TypeScript, so only the literal forms a `package.json`
 * default can also take are interesting; anything else (a call, a concatenation) is
 * reported as unknown and skipped rather than guessed at.
 */
function literal(expr: string): unknown {
  const trimmed = expr.trim().replace(/\.trim\(\)$/, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (/^-?\d+(_\d+)*$/.test(trimmed)) return Number(trimmed.replace(/_/g, ""));
  if (/^"([^"\\]*)"$/.test(trimmed)) return trimmed.slice(1, -1);
  return undefined;
}

/**
 * The manifest and `readConfig` are two independent declarations of the same settings, and
 * nothing at compile time relates them: a setting can be contributed and never read, or
 * read and never contributed, and either way it silently does nothing. That has bitten
 * this project more than once -- `respectDirenv` was read but never declared -- and it is
 * the shape a half-finished removal takes too.
 */
export async function run(): Promise<void> {
  console.log("\nsettings manifest");

  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const source = await fs.readFile(path.join(ROOT, "src", "config.ts"), "utf8");

  const contributed = new Map<string, unknown>(
    Object.entries(pkg.contributes.configuration.properties as Record<string, { default: unknown }>)
      .map(([key, value]) => [key.replace(/^nixDevelop\./, ""), value.default]),
  );

  const read = new Map<string, string>();
  for (const m of source.matchAll(READ)) read.set(m[1], m[2]);

  await test("both declarations were found", () => {
    ok(contributed.size > 5, `only ${contributed.size} settings in package.json`);
    ok(read.size > 5, `only ${read.size} c.get calls in config.ts`);
  });

  await test("every contributed setting is read by readConfig", () => {
    const orphans = [...contributed.keys()].filter((name) => !read.has(name));
    ok(orphans.length === 0, `contributed but never read: ${orphans.join(", ")}`);
  });

  await test("every setting readConfig reads is contributed", () => {
    const undeclared = [...read.keys()].filter((name) => !contributed.has(name));
    ok(undeclared.length === 0, `read but never contributed: ${undeclared.join(", ")}`);
  });

  await test("the defaults agree", () => {
    for (const [name, expr] of read) {
      if (!contributed.has(name)) continue;
      const mine = literal(expr);
      if (mine === undefined) continue; // not a literal; nothing to compare
      eq(mine, contributed.get(name), `default for nixDevelop.${name}`);
    }
  });

  await test("the removed settings are gone from both", () => {
    for (const name of ["devShell", "autoActivate", "remote.patchServerNode"]) {
      ok(!contributed.has(name), `nixDevelop.${name} is still contributed`);
      ok(!read.has(name), `nixDevelop.${name} is still read by readConfig`);
    }
  });
}
