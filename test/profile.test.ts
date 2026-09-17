import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NixDevelopConfig } from "../src/config";
import { ensureProfile, profileDirName, profileRoot } from "../src/profile";
import { eq, ok, test } from "./harness";

const cfg = { profile: "persistent" } as NixDevelopConfig;

const exists = (p: string) =>
  fs.stat(p).then(() => true).catch(() => false);

/**
 * Where a devShell's GC root goes, and what gets written beside it.
 *
 * These roots live in the user's checkout, so the two things that matter are that a name
 * is always a usable path component and that nothing here can end up committed.
 */
export async function run(): Promise<void> {
  console.log("\ndevShell profiles");

  await test("a plain attribute name is kept as it is", () => {
    eq(profileDirName("default"), "default");
    eq(profileDirName("ci"), "ci");
    eq(profileDirName("rust-nightly_1.0"), "rust-nightly_1.0");
  });

  await test("a devShell that is not a path component is rewritten and pinned to a digest", () => {
    const name = profileDirName(".#ci");
    ok(/^ci-[0-9a-f]{8}$/.test(name), `expected a digest suffix, got ${name}`);
    ok(!name.includes("/") && !name.includes("#"), "a directory name cannot carry separators");
  });

  await test("names that sanitise alike still get separate profiles", () => {
    // Without the digest these would share one directory, and so one GC root for two
    // different shells -- entering either would silently roll the other's root over.
    ok(
      profileDirName("github:a/b#ci") !== profileDirName("github:a-b#ci"),
      "distinct devShells must not collide",
    );
  });

  await test("a name too long for a path component is shortened", () => {
    const name = profileDirName("x".repeat(300));
    ok(name.length <= 73, `expected a bounded name, got ${name.length} characters`);
    ok(name.startsWith("x"), "the readable part is kept");
  });

  await test("a name made only of separators still yields a directory", () => {
    const name = profileDirName("../..");
    ok(!name.startsWith("."), `a relative path is not a name: ${name}`);
    ok(name.length > 0, "a devShell always needs somewhere to put its root");
  });

  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "nd-profile-dir-"));

  await test("persistent puts the profile beside the project, under .vscode", async () => {
    const profile = await ensureProfile(cfg, folder, "default");
    eq(profile, path.join(folder, ".vscode", "nix-develop", "default", "devshell"));
    ok(await exists(path.dirname(profile!)), "Nix will not create the directory itself");
  });

  await test("the directory ignores itself, so nothing here can be committed", async () => {
    const ignore = await fs.readFile(path.join(profileRoot(folder), ".gitignore"), "utf8");
    ok(
      ignore.split("\n").includes("*"),
      `store paths must never be committed; got:\n${ignore}`,
    );
  });

  await test("an ignore file the user has edited is left alone", async () => {
    const file = path.join(profileRoot(folder), ".gitignore");
    await fs.writeFile(file, "# mine\n*\n");
    await ensureProfile(cfg, folder, "default");
    eq(await fs.readFile(file, "utf8"), "# mine\n*\n");
  });

  await test("none writes nothing into the project", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "nd-profile-none-"));
    eq(await ensureProfile({ ...cfg, profile: "none" }, bare, "default"), undefined);
    eq(await exists(path.join(bare, ".vscode")), false, "not even the directory");
    await fs.rm(bare, { recursive: true, force: true });
  });

  await test("a folder that cannot be written to opens the window anyway", async () => {
    // A read-only checkout costs the GC root, not the devShell: this is `none`, arrived at
    // by accident rather than by setting.
    const blocked = path.join(folder, "a-file");
    await fs.writeFile(blocked, "");
    eq(await ensureProfile(cfg, blocked, "default"), undefined);
  });

  await fs.rm(folder, { recursive: true, force: true });
}
