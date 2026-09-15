import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectDirenv } from "../src/direnv";
import { eq, ok, test } from "./harness";

async function withEnvrc(content: string | null, extra?: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-direnv-"));
  if (content !== null) await fs.writeFile(path.join(dir, ".envrc"), content);
  for (const d of extra ?? []) await fs.mkdir(path.join(dir, d), { recursive: true });
  return dir;
}

export async function run(): Promise<void> {
  console.log("\ndirenv co-existence");

  await test("no .envrc means direnv is not involved", async () => {
    const dir = await withEnvrc(null);
    const s = await detectDirenv(dir);
    eq(s.present, false);
    eq(s.usesFlake, false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("a stale .direnv without .envrc is not treated as active", async () => {
    // HyRAIL had exactly this: a leftover cache from an .envrc that no longer exists.
    const dir = await withEnvrc(null, [".direnv"]);
    const s = await detectDirenv(dir);
    eq(s.present, false, "a cache directory alone does not mean direnv runs here");
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("recognises `use flake`", async () => {
    const dir = await withEnvrc("use flake\n", [".direnv"]);
    const s = await detectDirenv(dir);
    ok(s.present && s.usesFlake, "use flake should be detected");
    eq(s.allowed, true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("recognises `use nix` too", async () => {
    const dir = await withEnvrc("use nix\n");
    eq((await detectDirenv(dir)).usesFlake, true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("an .envrc that does not use a flake is left alone", async () => {
    const dir = await withEnvrc("export FOO=bar\ndotenv\n");
    const s = await detectDirenv(dir);
    eq(s.present, true);
    eq(s.usesFlake, false, "only a flake-based .envrc names a devShell");
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("extracts the devShell an .envrc names", async () => {
    for (const [line, expected] of [
      ["use flake .#ci\n", "ci"],
      ["use flake .#devShells.x86_64-linux.docs\n", "docs"],
      ['use flake "path:.#ci"\n', "ci"],
      ["use flake\n", undefined],
    ] as [string, string | undefined][]) {
      const dir = await withEnvrc(line);
      eq((await detectDirenv(dir)).devShell, expected, `for ${JSON.stringify(line)}`);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  await test("ignores a commented-out use flake", async () => {
    const dir = await withEnvrc("# use flake .#ci\nexport FOO=1\n");
    eq((await detectDirenv(dir)).usesFlake, false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("a devShell name is what the picker offers as its default", async () => {
    // There is no setting to compare against any more, so a conflict is not a thing that
    // can be detected. What the name is now for is seeding the picker, which only needs
    // it extracted -- covered above -- and absent when .envrc names none.
    const named = await withEnvrc("use flake .#ci\n");
    const unnamed = await withEnvrc("use flake\n");
    eq((await detectDirenv(named)).devShell, "ci");
    eq((await detectDirenv(unnamed)).devShell, undefined, "no name, so no default to offer");
    await fs.rm(named, { recursive: true, force: true });
    await fs.rm(unnamed, { recursive: true, force: true });
  });
}
