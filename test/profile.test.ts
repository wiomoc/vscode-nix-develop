import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NixDevShellConfig } from "../src/config";
import { ensureProfile, profileDirName, profileRoot } from "../src/profile";
import { afterAll, describe, expect, it } from "vitest";

const cfg = { profile: "persistent" } as NixDevShellConfig;

const exists = (p: string) =>
  fs.stat(p).then(() => true).catch(() => false);

/** A devShell's GC root: always a usable path component, and never committed. */
const folder = await fs.mkdtemp(path.join(os.tmpdir(), "nd-profile-dir-"));

describe("devShell profiles", () => {
  it("a plain attribute name is kept as it is", () => {
    expect(profileDirName("default")).toEqual("default");
    expect(profileDirName("ci")).toEqual("ci");
    expect(profileDirName("rust-nightly_1.0")).toEqual("rust-nightly_1.0");
  });

  it("a devShell that is not a path component is rewritten and pinned to a digest", () => {
    const name = profileDirName(".#ci");
    expect(/^ci-[0-9a-f]{8}$/.test(name), `expected a digest suffix, got ${name}`).toBe(true);
    expect(name.includes("/") && !name.includes("#"), "a directory name cannot carry separators").toBe(false);
  });

  it("names that sanitise alike still get separate profiles", () => {
    // Without the digest these would share one directory, and so one GC root for two
    // different shells -- entering either would silently roll the other's root over.
    expect(
      profileDirName("github:a/b#ci") !== profileDirName("github:a-b#ci"),
      "distinct devShells must not collide",
    ).toBe(true);
  });

  it("a name too long for a path component is shortened", () => {
    const name = profileDirName("x".repeat(300));
    expect(name.length <= 73, `expected a bounded name, got ${name.length} characters`).toBe(true);
    expect(name.startsWith("x"), "the readable part is kept").toBe(true);
  });

  it("a name made only of separators still yields a directory", () => {
    const name = profileDirName("../..");
    expect(name.startsWith("."), `a relative path is not a name: ${name}`).toBe(false);
    expect(name.length > 0, "a devShell always needs somewhere to put its root").toBe(true);
  });

  it("persistent puts the profile beside the project, under .vscode", async () => {
    const profile = await ensureProfile(cfg, folder, "default");
    expect(profile).toEqual(path.join(folder, ".vscode", "nix-devshell", "default", "devshell"));
    expect(await exists(path.dirname(profile!)), "Nix will not create the directory itself").toBe(true);
  });

  it("the directory ignores itself, so nothing here can be committed", async () => {
    const ignore = await fs.readFile(path.join(profileRoot(folder), ".gitignore"), "utf8");
    expect(
      ignore.split("\n").includes("*"),
      `store paths must never be committed; got:\n${ignore}`,
    ).toBe(true);
  });

  it("an ignore file the user has edited is left alone", async () => {
    const file = path.join(profileRoot(folder), ".gitignore");
    await fs.writeFile(file, "# mine\n*\n");
    await ensureProfile(cfg, folder, "default");
    expect(await fs.readFile(file, "utf8")).toEqual("# mine\n*\n");
  });

  it("none writes nothing into the project", async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), "nd-profile-none-"));
    expect(await ensureProfile({ ...cfg, profile: "none" }, bare, "default")).toEqual(undefined);
    expect(await exists(path.join(bare, ".vscode")), "not even the directory").toEqual(false);
    await fs.rm(bare, { recursive: true, force: true });
  });

  it("a folder that cannot be written to opens the window anyway", async () => {
    // A read-only checkout costs the GC root, not the devShell: this is `none`, arrived at
    // by accident rather than by setting.
    const blocked = path.join(folder, "a-file");
    await fs.writeFile(blocked, "");
    expect(await ensureProfile(cfg, blocked, "default")).toEqual(undefined);
  });

  afterAll(async () => {
    await fs.rm(folder, { recursive: true, force: true });
  });
});
