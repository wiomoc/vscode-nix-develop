import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/** Repo root: this file lives in `test/`, so its parent is the checkout. */
const ROOT = path.resolve(import.meta.dirname, "..");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Source files have to survive `grep`: a literal NUL or U+FFFD makes `grep` treat the
 * whole file as binary and silently skip it. Write them as escapes. Other non-ASCII is
 * fine.
 */
const files = [
  ...(await sourceFiles(path.join(ROOT, "src"))),
  ...(await sourceFiles(path.join(ROOT, "test"))),
];

describe("source hygiene", () => {
  it("there are source files to check", () => {
    expect(files.length > 10, `only found ${files.length} .ts files under ${ROOT}`).toBe(true);
  });

  // Spelled the same way the rule demands, so this file does not trip its own check.
  const banned = [
    { name: "NUL", code: 0x0000, escape: "\\u0000" },
    { name: "U+FFFD", code: 0xfffd, escape: "\\uFFFD" },
    // ESC is invisible in an editor, and JSON-based tools silently unescape it.
    { name: "ESC", code: 0x001b, escape: "\\u001b" },
  ];

  for (const { name, code, escape } of banned) {
    it(`no literal ${name} in source; write "${escape}" instead`, async () => {
      const ch = String.fromCharCode(code);
      const guilty: string[] = [];
      for (const file of files) {
        const text = await fs.readFile(file, "utf8");
        const at = text.indexOf(ch);
        if (at === -1) continue;
        guilty.push(`${path.relative(ROOT, file)}:${text.slice(0, at).split("\n").length}`);
      }
      expect(
        guilty.length === 0,
        `a literal ${name} does not belong in source; write "${escape}": ${guilty.join(", ")}`,
      ).toBe(true);
    });
  }
});
