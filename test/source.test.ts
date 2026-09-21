import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ok, test } from "./harness";

/** Repo root: the bundle lives in `out/`, so its parent is the checkout. */
const ROOT = path.resolve(__dirname, "..");

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
 * Source files have to survive `grep`.
 *
 * A single literal NUL or replacement character is enough for `file`, `grep` and `git grep`
 * to classify a whole file as binary and skip it -- returning nothing, with no error, so a
 * search for a symbol reports it as unused rather than reporting that it gave up. That cost
 * real time in this project: a review concluded `authorityId` was dead because
 * `authority.ts` contained both characters as literals and vanished from every search.
 *
 * Both characters are wanted there -- one as a field separator, one as the marker of a lossy
 * decode -- so the rule is about how they are *spelled*, not whether they may be used. An
 * escape compiles to exactly the same string and stays greppable.
 *
 * Other non-ASCII is deliberately allowed: user-facing strings use real ellipses and dashes,
 * and none of that makes a file disappear.
 */
export async function run(): Promise<void> {
  console.log("\nsource hygiene");

  const files = [
    ...(await sourceFiles(path.join(ROOT, "src"))),
    ...(await sourceFiles(path.join(ROOT, "test"))),
  ];

  await test("there are source files to check", () => {
    ok(files.length > 10, `only found ${files.length} .ts files under ${ROOT}`);
  });

  // Spelled the same way the rule demands, so this file does not trip its own check.
  const banned = [
    { name: "NUL", code: 0x0000, escape: "\\u0000" },
    { name: "U+FFFD", code: 0xfffd, escape: "\\uFFFD" },
    // ESC does not make a file look binary, but it is invisible in an editor and this
    // codebase writes plenty of it now that it renders Nix's output. A tool that takes its
    // input as JSON turns the escape into the character without anyone asking, which is
    // exactly how the three that were here got here.
    { name: "ESC", code: 0x001b, escape: "\\u001b" },
  ];

  for (const { name, code, escape } of banned) {
    await test(`no literal ${name} in source; write "${escape}" instead`, async () => {
      const ch = String.fromCharCode(code);
      const guilty: string[] = [];
      for (const file of files) {
        const text = await fs.readFile(file, "utf8");
        const at = text.indexOf(ch);
        if (at === -1) continue;
        guilty.push(`${path.relative(ROOT, file)}:${text.slice(0, at).split("\n").length}`);
      }
      ok(
        guilty.length === 0,
        `a literal ${name} does not belong in source; write "${escape}": ${guilty.join(", ")}`,
      );
    });
  }
}
