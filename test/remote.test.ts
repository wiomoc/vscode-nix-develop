import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NixDevelopConfig } from "../src/config";
import {
  authorityFor,
  authorityId,
  decodeAuthority,
  storageKeyFor,
} from "../src/remote/authority";
import {
  collectExtensions,
  extensionsDirFor,
  installedIn,
  mergedExtensions,
} from "../src/remote/extensions";
import {
  applyMachineSettings,
  collectSettings,
  machineSettingsPath,
  mergedSettings,
  parseFlakeSettings,
  parseJsonc,
} from "../src/remote/settings";
import { serverPlatform } from "../src/remote/server";
import { glibcLinkerName } from "../src/remote/server-ld-patch";
import { registerResourceLabelFormatter } from "../src/ui";
import { eq, ok, test } from "./harness";

const cfg: NixDevelopConfig = {
  flakeDirectory: ".",
  promptWhenUnset: true,
  impure: false,
  extraArgs: [],
  nixPath: "nix",
  buildTimeoutSeconds: 1800,
  remote: {
    extensions: [],
    extensionsFromFlake: true,
    settings: {},
    settingsFromFlake: true,
    serverDownloadUrl: "https://example.invalid/${commit}/${platform}",
    connectTimeoutSeconds: 180,
    patchServerLd: true,
  },
};

export async function run(): Promise<void> {
  console.log("\nremote authorities");

  const target = { folder: "/w/proj", flakeDir: "/w/proj", devShell: "default" };

  await test("an authority round-trips to the target it describes", () => {
    const decoded = decodeAuthority(authorityFor(target));
    eq(decoded, target, "the authority is the mapping; nothing else stores it");
  });

  await test("uses only characters that are unreserved in a URI authority", () => {
    const payload = authorityId(authorityFor({ ...target, folder: "/w/pro ject+odd" }));
    ok(/^[a-z2-7]+$/.test(payload), `lower-case base32 expected, got ${payload}`);
  });

  await test("survives the authority being lower-cased", () => {
    // A URI authority is case-insensitive by RFC 3986, and VS Code acts on it: an authority
    // restored from persisted state after a restart comes back lower-cased. An encoding that
    // depends on case (base64) silently stops resolving the moment the editor is restarted.
    for (const t of [
      target,
      { folder: "/w/MixedCase/Proj", flakeDir: "/w/MixedCase/Proj", devShell: "CI" },
      { folder: "/w/p", flakeDir: "/w/p/nix", devShell: "Dev-Shell" },
    ]) {
      const authority = authorityFor(t);
      eq(authority, authority.toLowerCase(), "the authority must already be lower case");
      eq(decodeAuthority(authority.toLowerCase()), t, "and must decode after folding");
      eq(decodeAuthority(authority.toUpperCase()), t, "in either direction");
    }
  });

  await test("survives paths and devShell names that need escaping", () => {
    for (const t of [
      { folder: "/w/a b/c+d", flakeDir: "/w/a b/c+d", devShell: "shell/with#chars" },
      { folder: "/w/ünïcode", flakeDir: "/w/ünïcode", devShell: "dév" },
      { folder: "/w/p", flakeDir: "/w/p/nix", devShell: "ci" },
    ]) {
      eq(decodeAuthority(authorityFor(t)), t, `round trip failed for ${JSON.stringify(t)}`);
    }
  });

  await test("carries flakeDir only when it differs from the folder", () => {
    const same = authorityFor(target).length;
    const differs = authorityFor({ ...target, flakeDir: "/w/proj/nix" }).length;
    ok(differs > same, "a separate flakeDir has to be encoded");
    eq(decodeAuthority(authorityFor(target))!.flakeDir, "/w/proj", "and defaults to the folder");
  });

  await test("different devShells in one folder get different authorities", () => {
    const a = authorityFor(target);
    const b = authorityFor({ ...target, devShell: "ci" });
    ok(a !== b, "each devShell needs its own authority, or they share a server");
  });

  await test("rejects anything that is not one of ours", () => {
    // The previous scheme's opaque digest decodes as base64 but means nothing.
    eq(decodeAuthority("nix-develop+44f5ce469662698e"), undefined, "an old digest");
    eq(decodeAuthority("nix-develop+"), undefined, "an empty payload");
    eq(decodeAuthority("nix-develop+not/base64url"), undefined, "illegal characters");
    eq(decodeAuthority("nix-develop+" + Buffer.from("relative/path\u0000dev").toString("base64url")),
       undefined, "a folder that is not absolute");
    eq(decodeAuthority("nix-develop+" + Buffer.from("/w/proj").toString("base64url")),
       undefined, "a payload with no devShell");
  });

  await test("storage keys stay short whatever the path length", () => {
    const deep = "/home/u/" + "nested/".repeat(40) + "project";
    const authority = authorityFor({ folder: deep, flakeDir: deep, devShell: "default" });
    ok(authority.length > 255, `expected a long authority, got ${authority.length}`);
    const key = storageKeyFor(authority);
    eq(key.length, 16, "a directory name must not grow with the path");
    ok(/^[0-9a-f]+$/.test(key), "and must be filesystem-safe");
    eq(storageKeyFor(authority), key, "and stable");
  });

  console.log("\nworkspace label");

  const stub = await import("./activation-stub");

  type LabelFormatter = {
    scheme: string;
    authority?: string;
    formatting: { workspaceSuffix?: string; workspaceTooltip?: string };
  };

  /**
   * The formatters the extension registers, in registration order, for a window sitting
   * in `authority`. The devShell is read back out of the authority rather than passed in,
   * so these go through `authorityFor`.
   */
  const formattersIn = (authority: string | undefined): LabelFormatter[] => {
    const captured: LabelFormatter[] = [];
    const previous = stub.env.remoteAuthority;
    stub.env.remoteAuthority = authority;
    try {
      registerResourceLabelFormatter({
        registerResourceLabelFormatter: (f) => {
          captured.push(f);
          return { dispose() {} };
        },
      });
    } finally {
      stub.env.remoteAuthority = previous;
    }
    return captured;
  };

  await test("names the devShell in the workspace suffix", () => {
    const [, exact] = formattersIn(
      authorityFor({ folder: "/w/p", flakeDir: "/w/p", devShell: "ci" }),
    );
    eq(exact.formatting.workspaceSuffix, "devShell: ci");
    ok(exact.formatting.workspaceTooltip!.includes("ci"), "the tooltip should name it too");
  });

  await test("leaves `default` unnamed", () => {
    // A bare `nix develop` picks it, so spelling it out distinguishes nothing.
    const [, exact] = formattersIn(
      authorityFor({ folder: "/w/p", flakeDir: "/w/p", devShell: "default" }),
    );
    eq(exact.formatting.workspaceSuffix, "devShell");
  });

  await test("binds to the exact authority so it outranks the wildcard", () => {
    // findFormatting prefers the longest matching authority pattern.
    const authority = authorityFor({ folder: "/w/p", flakeDir: "/w/p", devShell: "ci" });
    const [wildcard, exact] = formattersIn(authority);
    eq(exact.authority, authority);
    ok(
      exact.authority!.length > wildcard.authority!.length,
      "an exact authority must be longer than the wildcard to win",
    );
  });

  await test("registers only the wildcard outside a devShell", () => {
    // A local window has no devShell to name, and so nothing to outrank the wildcard.
    const formatters = formattersIn(undefined);
    eq(formatters.length, 1, "a local window should get one formatter");
    eq(formatters[0].authority, "nix-develop+*");
  });

  console.log("\nper-devShell extensions");

  await test("reads extension ids the flake declares via a list attribute", () => {
    // `mkShell { vscodeExtensions = [ "a.b" "c.d" ]; }` arrives space-separated.
    const s = collectExtensions(cfg, { vscodeExtensions: "rust-lang.rust-analyzer tamasfe.even-better-toml" });
    eq(s.fromFlake, ["rust-lang.rust-analyzer", "tamasfe.even-better-toml"]);
  });

  await test("accepts comma separation and a pinned version", () => {
    const s = collectExtensions(cfg, { vscodeExtensions: "golang.go, ms-python.python@2024.1.0" });
    eq(s.fromFlake, ["golang.go", "ms-python.python@2024.1.0"]);
  });

  await test("rejects values that are not publisher.name ids", () => {
    const s = collectExtensions(cfg, { vscodeExtensions: "not-an-id ok.good ../../evil" });
    eq(s.fromFlake, ["ok.good"], "malformed entries must not reach --install-extension");
  });

  await test("ignores flake-declared extensions when the setting is off", () => {
    const s = collectExtensions({ ...cfg, remote: { ...cfg.remote, extensionsFromFlake: false } }, {
      vscodeExtensions: "a.b",
    });
    eq(s.fromFlake, []);
  });

  await test("merges settings and flake sources without duplicates", () => {
    const s = collectExtensions({ ...cfg, remote: { ...cfg.remote, extensions: ["a.b", "x.y"] } }, {
      vscodeExtensions: "a.b c.d",
    });
    eq(mergedExtensions(s), ["a.b", "c.d", "x.y"]);
  });

  await test("each devShell gets its own extensions directory", () => {
    // This is what makes a devShell's extension set actually be that devShell's.
    ok(
      extensionsDirFor("/root", "aaa") !== extensionsDirFor("/root", "bbb"),
      "two devShells must not share a directory",
    );
    eq(extensionsDirFor("/root", "aaa"), extensionsDirFor("/root", "aaa"), "and it must be stable");
  });

  await test("lists installed extensions, stripping version suffixes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-ext-"));
    await fs.mkdir(path.join(dir, "rust-lang.rust-analyzer-0.3.2000"), { recursive: true });
    await fs.mkdir(path.join(dir, "golang.go-0.41.4"), { recursive: true });
    await fs.writeFile(path.join(dir, "extensions.json"), "[]");
    eq(await installedIn(dir), ["golang.go", "rust-lang.rust-analyzer"]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("a missing extensions directory lists as empty", async () => {
    eq(await installedIn("/definitely/not/here"), []);
  });

  console.log("\nserver platform");

  await test("maps this machine to a server distribution", () => {
    const p = serverPlatform();
    ok(/^(linux|darwin|win32)-(x64|arm64|armhf)$/.test(p), `unexpected platform: ${p}`);
  });

  console.log("\nglibc linker");

  // Taken from nixpkgs' own `stdenv.cc.bintools.dynamicLinker` for each system, so this
  // pins the aarch64 answer on an x86_64 machine, where nothing else would exercise it.
  await test("names the ELF interpreter per architecture", () => {
    eq(glibcLinkerName("x64"), "ld-linux-x86-64.so.2");
    eq(glibcLinkerName("arm64"), "ld-linux-aarch64.so.1");
  });

  await test("refuses an architecture it has no linker for", () => {
    // nixpkgs spells armv7l's as the unresolved glob `ld-linux*.so.3`, so there is no
    // single name to hardcode; a loud failure beats patching against a path that is not
    // there, which only shows up when the server fails to exec its own node.
    let message = "";
    try {
      glibcLinkerName("arm");
    } catch (err) {
      message = (err as Error).message;
    }
    ok(message.includes("arm"), `expected the architecture to be named, got: ${message}`);
  });

  await test("this machine is one of them", () => {
    ok(glibcLinkerName().startsWith("ld-linux-"), "the running arch must resolve");
  });
}

export async function runFlakeRefs(): Promise<void> {
  const { flakeRefFor, markPathRefRequired, isUntrackedFlakeError, toInstallable } = await import(
    "../src/nix"
  );

  console.log("\nflake refs");

  await test("addresses a local directory bare, so Nix can use the Git source", () => {
    eq(flakeRefFor("/w/proj"), "/w/proj");
    ok(!flakeRefFor("/w/proj").startsWith("path:"), "a path: ref hashes the whole directory");
  });

  await test("installables use the bare ref too, so nix develop does not copy the tree", () => {
    eq(toInstallable("default", "/w/proj", "x86_64-linux"), "/w/proj#devShells.x86_64-linux.default");
  });

  await test("switches a directory to path: once Git refuses its flake", () => {
    markPathRefRequired("/w/untracked");
    eq(flakeRefFor("/w/untracked"), "path:/w/untracked");
    eq(flakeRefFor("/w/proj"), "/w/proj", "other directories are unaffected");
  });

  await test("recognises the untracked-flake failure", () => {
    ok(
      isUntrackedFlakeError({ stderr: 'error: path ... is not tracked by Git\nTo make it visible to Nix, run:\n  git add "flake.nix"' }),
      "the git-add hint must trigger the path: fallback",
    );
    ok(!isUntrackedFlakeError({ stderr: "error: attribute 'devShells' missing" }), "unrelated errors must not");
  });

  await test("a full installable is passed through untouched", () => {
    eq(toInstallable("github:owner/repo#dev", "/w/proj", "x86_64-linux"), "github:owner/repo#dev");
  });
}

/**
 * `nix develop` is invoked from two places that run it very differently. These pin the one
 * builder both go through, so a flag can only ever be added or dropped in one place.
 */
export async function runNixCommands(): Promise<void> {
  const { developCommand, nixCommand } = await import("../src/nix");

  console.log("\nnix invocation");

  const features = ["--extra-experimental-features", "nix-command flakes"];

  await test("every invocation carries the experimental-features flag", () => {
    eq(nixCommand(cfg, ["eval"], ["--raw"]).args, [...features, "eval", "--raw"]);
    eq(nixCommand(cfg, ["eval"], []).exe, "nix");
  });

  await test("nixPath chooses the executable", () => {
    eq(nixCommand({ ...cfg, nixPath: "/run/current-system/sw/bin/nix" }, ["eval"], []).exe,
      "/run/current-system/sw/bin/nix");
  });

  await test("--impure goes after the subcommand, where Nix will accept it", () => {
    // `nix --impure eval` is rejected outright with `unrecognised flag '--impure'`.
    eq(nixCommand({ ...cfg, impure: true }, ["flake", "show"], ["--json"]).args,
      [...features, "flake", "show", "--impure", "--json"]);
  });

  await test("--impure follows the setting, and an explicit choice overrides it", () => {
    eq(nixCommand(cfg, ["eval"], []).args, [...features, "eval"], "off by default");
    eq(nixCommand({ ...cfg, impure: true }, ["build"], [], { impure: false }).args,
      [...features, "build"], "a caller that knows better wins");
    eq(nixCommand(cfg, ["eval"], [], { impure: true }).args, [...features, "eval", "--impure"]);
  });

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-profile-"));
  const profile = path.join(dir, "profiles", "abc", "devshell");

  await test("entering a devShell always roots it in a profile", async () => {
    const { args } = await developCommand(cfg, {
      installable: "/w/proj#devShells.x86_64-linux.default",
      profile,
      command: ["bash", "-c", "true"],
    });
    eq(args, [
      ...features,
      "develop",
      "/w/proj#devShells.x86_64-linux.default",
      "--profile",
      profile,
      "--command",
      "bash",
      "-c",
      "true",
    ]);
  });

  await test("the directory holding the profile is created, since Nix will not", async () => {
    ok(
      await fs.stat(path.dirname(profile)).then((st) => st.isDirectory()).catch(() => false),
      "nix develop --profile fails if the parent directory is missing",
    );
  });

  await test("extraArgs and impure reach nix develop, ahead of the inner command", async () => {
    const { args } = await developCommand(
      { ...cfg, impure: true, extraArgs: ["--offline", "-L"] },
      { installable: "/w#dev", profile, command: ["bash", "-c", "true"] },
    );
    eq(args, [
      ...features,
      "develop",
      "--impure",
      "/w#dev",
      "--profile",
      profile,
      "--offline",
      "-L",
      "--command",
      "bash",
      "-c",
      "true",
    ]);
  });

  await fs.rm(dir, { recursive: true, force: true });
}

export async function runShellRestore(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const cp = await import("node:child_process");
  const { SERVER_WRAPPER } = await import("../src/remote/server");

  console.log("\nsession shell restore");

  const dir = await fs.mkdtemp(pathMod.join(os.tmpdir(), "nd-shell-"));
  // Stand-ins for the two bash builds: `compgen` succeeds for the interactive one and
  // fails for nixpkgs' readline-less build. Each lives in its own directory so PATH
  // lookup can be steered.
  const goodDir = pathMod.join(dir, "good");
  const badDir = pathMod.join(dir, "bad");
  await fs.mkdir(goodDir, { recursive: true });
  await fs.mkdir(badDir, { recursive: true });
  const good = pathMod.join(goodDir, "bash");
  const bad = pathMod.join(badDir, "bash");
  const hostShell = pathMod.join(dir, "host-bash");
  const zsh = pathMod.join(dir, "zsh");
  await fs.writeFile(good, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(bad, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await fs.writeFile(hostShell, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(zsh, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  // The harness itself must keep working even when PATH is pointed at the fakes.
  const realBash = cp.execSync("command -v bash", { encoding: "utf8" }).trim();

  const resolve = (opts: { shell: string; host?: string; path: string }): string => {
    const env: Record<string, string> = { SHELL: opts.shell, PATH: opts.path };
    if (opts.host) env.NIX_DEVELOP_HOST_SHELL = opts.host;
    const r = cp.spawnSync(
      realBash,
      ["-c", SERVER_WRAPPER, "x", "/bin/sh", "-c", 'printf %s "$SHELL"'],
      { env, encoding: "utf8" },
    );
    return r.stdout ?? "";
  };

  await test("replaces a bash that cannot act as an interactive shell", () => {
    eq(
      resolve({ shell: bad, host: hostShell, path: badDir }),
      hostShell,
      "the readline-less bash must not be used for terminals",
    );
  });

  await test("keeps a bash the devShell deliberately provides", () => {
    eq(
      resolve({ shell: good, host: hostShell, path: goodDir }),
      good,
      "a shellHook that sets SHELL must win over the host shell",
    );
  });

  await test("never second-guesses a non-bash shell", () => {
    eq(resolve({ shell: zsh, host: hostShell, path: goodDir }), zsh, "only bash is probed");
  });

  await test("falls back to a usable bash when no host shell is known", () => {
    // `packages = [ pkgs.bashInteractive ]` with no shellHook lands here: there is no host
    // shell to borrow, so a usable bash from PATH is taken. The exact path depends on the
    // PATH the server is launched with, so what is asserted is the guarantee -- the shell
    // that cannot act as an interactive shell is not the one left behind.
    const chosen = resolve({ shell: bad, path: `${goodDir}:${process.env.PATH ?? ""}` });
    ok(chosen !== bad, "an unusable bash must not survive as SHELL");
    ok(chosen.length > 0, "some shell must be chosen");
    const probe = cp.spawnSync(chosen, ["-c", "compgen -e >/dev/null"], { encoding: "utf8" });
    eq(probe.status, 0, `the chosen shell ${chosen} must support programmable completion`);
  });

  await fs.rm(dir, { recursive: true, force: true });
}

export async function runNixExtensions(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const { collectNixExtensions, syncNixExtensions } = await import("../src/remote/extensions");

  console.log("\nnix-supplied extensions");

  /** A stand-in for `$out/share` of a nix-vscode-extensions package. */
  async function share(root: string, name: string, ids: string[]): Promise<string> {
    const base = pathMod.join(root, name, "share", "vscode", "extensions");
    for (const id of ids) {
      await fs.mkdir(pathMod.join(base, id), { recursive: true });
      await fs.writeFile(pathMod.join(base, id, "package.json"), "{}");
    }
    return pathMod.join(root, name, "share");
  }

  const root = await fs.mkdtemp(pathMod.join(os.tmpdir(), "nd-nixext-"));
  const a = await share(root, "pkg-a", ["jnoortheen.nix-ide"]);
  const b = await share(root, "pkg-b", ["tamasfe.even-better-toml"]);
  const hostShare = await share(root, "host", ["someone.preinstalled"]);

  await test("finds extensions the devShell added to XDG_DATA_DIRS", async () => {
    const found = await collectNixExtensions({
      inside: { XDG_DATA_DIRS: `${a}:${b}:${hostShare}` },
      baseline: { XDG_DATA_DIRS: hostShare },
    });
    eq(
      found.map((e) => e.id),
      ["jnoortheen.nix-ide", "tamasfe.even-better-toml"],
    );
  });

  await test("ignores extensions that were already on the host's XDG_DATA_DIRS", async () => {
    const found = await collectNixExtensions({
      inside: { XDG_DATA_DIRS: hostShare },
      baseline: { XDG_DATA_DIRS: hostShare },
    });
    eq(found, [], "the host's own VS Code install is not what the flake declared");
  });

  await test("skips directories without a package.json", async () => {
    const stray = pathMod.join(root, "stray", "share", "vscode", "extensions", "not-an-extension");
    await fs.mkdir(stray, { recursive: true });
    const found = await collectNixExtensions({
      inside: { XDG_DATA_DIRS: pathMod.join(root, "stray", "share") },
      baseline: {},
    });
    eq(found, []);
  });

  await test("tolerates XDG_DATA_DIRS entries that do not exist", async () => {
    const found = await collectNixExtensions({
      inside: { XDG_DATA_DIRS: `/definitely/not/here:${a}` },
      baseline: {},
    });
    eq(found.map((e) => e.id), ["jnoortheen.nix-ide"]);
  });

  console.log("\nlinking nix extensions");

  await test("links them into the extension directory", async () => {
    const dir = pathMod.join(root, "ext1");
    const wanted = await collectNixExtensions({ inside: { XDG_DATA_DIRS: `${a}:${b}` }, baseline: {} });
    const res = await syncNixExtensions(dir, wanted);
    eq(res.linked, ["jnoortheen.nix-ide", "tamasfe.even-better-toml"]);
    eq((await fs.readdir(dir)).sort(), ["jnoortheen.nix-ide", "tamasfe.even-better-toml"]);
  });

  await test("is idempotent", async () => {
    const dir = pathMod.join(root, "ext2");
    const wanted = await collectNixExtensions({ inside: { XDG_DATA_DIRS: a }, baseline: {} });
    await syncNixExtensions(dir, wanted);
    const again = await syncNixExtensions(dir, wanted);
    eq(again.linked, [], "an unchanged extension must not be relinked");
    eq(again.removed, []);
  });

  await test("drops links the devShell no longer declares", async () => {
    const dir = pathMod.join(root, "ext3");
    const both = await collectNixExtensions({ inside: { XDG_DATA_DIRS: `${a}:${b}` }, baseline: {} });
    const justA = await collectNixExtensions({ inside: { XDG_DATA_DIRS: a }, baseline: {} });
    await syncNixExtensions(dir, both);
    const res = await syncNixExtensions(dir, justA);
    eq(res.removed, ["tamasfe.even-better-toml"]);
    eq(await fs.readdir(dir), ["jnoortheen.nix-ide"]);
  });

  await test("a version bump retargets the link rather than dropping it", async () => {
    // Retargeting is safe: the extension never ends up without files.
    const dir = pathMod.join(root, "ext3c");
    const v1 = await share(root, "pkg-v1", ["acme.tool"]);
    const v2 = await share(root, "pkg-v2", ["acme.tool"]);
    await syncNixExtensions(dir, await collectNixExtensions({ inside: { XDG_DATA_DIRS: v1 }, baseline: {} }));
    const res = await syncNixExtensions(dir, await collectNixExtensions({ inside: { XDG_DATA_DIRS: v2 }, baseline: {} }));
    eq(res.linked, ["acme.tool"]);
    eq(res.removed, [], "a retarget is not a removal");
    const link = await fs.readlink(pathMod.join(dir, "acme.tool"));
    ok(link.startsWith(pathMod.join(root, "pkg-v2")), `expected the v2 path, got ${link}`);
  });

  await test("never removes a Marketplace-installed extension", async () => {
    const dir = pathMod.join(root, "ext4");
    await fs.mkdir(pathMod.join(dir, "esbenp.prettier-vscode"), { recursive: true });
    const res = await syncNixExtensions(dir, []);
    eq(res.removed, [], "a real directory is not ours to delete");
    ok((await fs.readdir(dir)).includes("esbenp.prettier-vscode"), "it must still be there");
  });

  await fs.rm(root, { recursive: true, force: true });
}

/**
 * What happens to a lock and its profile when the server behind them is gone.
 *
 * Servers now retire themselves once idle, so nothing local runs at the moment one exits.
 * The next window is what notices, and these cover that handover without needing a real
 * server: a hand-written lock and a hand-built profile are all the state involved.
 */
export async function runServerLifecycle(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const net = await import("node:net");
  const { ServerManager } = await import("../src/remote/server");

  console.log("\nserver lock and profile release");

  const storage = await fs.mkdtemp(pathMod.join(os.tmpdir(), "nd-lifecycle-"));
  const manager = new ServerManager({ fsPath: storage } as never, cfg);
  const commit = "1e3c50d64110be466c0b4a45222e81d2c9352888";

  const lockPath = (key: string) =>
    pathMod.join(storage, "server", "instances", `${key}.json`);

  /** The symlinks `nix develop --profile` leaves behind, plus a bystander. */
  const buildProfile = async (key: string): Promise<string> => {
    const dir = pathMod.join(storage, "remote", "profiles", key);
    await fs.mkdir(dir, { recursive: true });
    const profile = pathMod.join(dir, "devshell");
    await fs.symlink("/nix/store/aaaa-devshell", `${profile}-1-link`);
    await fs.symlink("/nix/store/bbbb-devshell", `${profile}-2-link`);
    await fs.symlink("devshell-2-link", profile);
    await fs.writeFile(pathMod.join(dir, "unrelated"), "not Nix's");
    return profile;
  };

  const writeLock = async (key: string, port: number, profile: string, at = commit) => {
    await fs.mkdir(pathMod.dirname(lockPath(key)), { recursive: true });
    await fs.writeFile(
      lockPath(key),
      JSON.stringify({
        port,
        connectionToken: "token",
        pid: 999_999,
        installable: "/w#devShells.x86_64-linux.default",
        commit: at,
        startedAt: Date.now(),
        profile,
      }),
    );
  };

  const listen = (): Promise<{ port: number; close: () => Promise<void> }> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () =>
        resolve({
          port: (server.address() as { port: number }).port,
          close: () => new Promise<void>((done) => server.close(() => done())),
        }),
      );
    });

  /** A port nothing is on: take one, then give it straight back. */
  const deadPort = async (): Promise<number> => {
    const { port, close } = await listen();
    await close();
    return port;
  };

  const exists = (p: string) =>
    fs.lstat(p).then(() => true).catch(() => false);

  await test("a lock whose server has gone releases the lock and the profile", async () => {
    const key = "gone";
    const profile = await buildProfile(key);
    await writeLock(key, await deadPort(), profile);

    eq(await manager.findRunning(key, commit), undefined, "a dead port is not attachable");
    eq(await exists(lockPath(key)), false, "the lock should be gone");
    eq(await exists(profile), false, "the profile symlink should be gone");
    eq(await exists(`${profile}-1-link`), false, "generation 1 should be gone");
    eq(await exists(`${profile}-2-link`), false, "generation 2 should be gone");
  });

  await test("releasing a profile touches only what Nix wrote", async () => {
    ok(
      await exists(pathMod.join(storage, "remote", "profiles", "gone", "unrelated")),
      "a file that is not a profile generation should survive",
    );
  });

  await test("a live server from another commit keeps its lock and its profile", async () => {
    const key = "othercommit";
    const profile = await buildProfile(key);
    const { port, close } = await listen();
    await writeLock(key, port, profile, "0000000000000000000000000000000000000000");

    eq(await manager.findRunning(key, commit), undefined, "a mismatched commit is unusable");
    ok(await exists(lockPath(key)), "something is still serving, so the lock stays");
    ok(await exists(profile), "and it still needs the shell the profile pins");
    await close();
  });

  await test("a live server at the right commit is handed back", async () => {
    const key = "live";
    const profile = await buildProfile(key);
    const { port, close } = await listen();
    await writeLock(key, port, profile);

    eq(await manager.findRunning(key, commit), { port, connectionToken: "token", pid: 999_999 });
    ok(await exists(lockPath(key)), "attaching must not disturb the lock");
    await close();
  });

  await test("no lock at all is not an error", async () => {
    eq(await manager.findRunning("never-started", commit), undefined);
  });

  await fs.rm(storage, { recursive: true, force: true });
}

/**
 * The half of `SERVER_WRAPPER` that runs after the server exits.
 *
 * This is the only cleanup that happens when a server retires itself in the background, so
 * it is worth driving through a real bash rather than trusting it by inspection.
 */
export async function runServerRelease(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const cp = await import("node:child_process");
  const { SERVER_WRAPPER } = await import("../src/remote/server");

  console.log("\nserver wrapper release");

  const realBash = cp.execSync("command -v bash", { encoding: "utf8" }).trim();
  const root = await fs.mkdtemp(pathMod.join(os.tmpdir(), "nd-release-"));
  const token = "6f1c1d2e-token";

  /** A lock and a profile as `start()` would have left them, in their own directory. */
  const scene = async (name: string, lockToken = token) => {
    const dir = pathMod.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    const lock = pathMod.join(dir, "key.json");
    const profile = pathMod.join(dir, "devshell");
    // Pretty-printed, as `start()` writes it: the token match has to hold across newlines.
    await fs.writeFile(lock, JSON.stringify({ port: 1, connectionToken: lockToken }, null, 2));
    await fs.symlink("/nix/store/aaaa", `${profile}-1-link`);
    await fs.symlink("/nix/store/bbbb", `${profile}-2-link`);
    await fs.symlink("devshell-2-link", profile);
    await fs.writeFile(pathMod.join(dir, "unrelated"), "not Nix's");
    return { dir, lock, profile };
  };

  const gone = async (p: string) => !(await fs.lstat(p).then(() => true).catch(() => false));

  /** Run the wrapper with the release environment set, around `command`. */
  const wrap = (
    s: { lock: string; profile: string },
    command: string[],
    signal?: NodeJS.Signals,
  ) => {
    const child = cp.spawn(realBash, ["-c", SERVER_WRAPPER, "nix-develop", ...command], {
      env: {
        ...process.env,
        NIX_DEVELOP_LOCK: s.lock,
        NIX_DEVELOP_PROFILE: s.profile,
        NIX_DEVELOP_LOCK_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    return new Promise<string>((resolve) => {
      if (signal) setTimeout(() => child.kill(signal), 400);
      child.on("exit", () => resolve(out));
    });
  };

  await test("releases the lock and every profile generation once the server exits", async () => {
    const s = await scene("exits");
    await wrap(s, ["true"]);
    ok(await gone(s.lock), "the lock should be gone");
    ok(await gone(s.profile), "the profile symlink should be gone");
    ok(await gone(`${s.profile}-1-link`), "generation 1 should be gone");
    ok(await gone(`${s.profile}-2-link`), "generation 2 should be gone");
    ok(!(await gone(pathMod.join(s.dir, "unrelated"))), "only Nix's symlinks may be removed");
  });

  await test("a SIGTERM to the wrapper still runs the release", async () => {
    // Without the TERM trap, bash dies on the signal and the EXIT trap never fires --
    // which is exactly what `Stop devShell server` sends.
    const s = await scene("signalled");
    await wrap(s, ["sleep", "30"], "SIGTERM");
    ok(await gone(s.lock), "a signalled wrapper must still release the lock");
    ok(await gone(s.profile), "a signalled wrapper must still release the profile");
  });

  await test("a successor's lock and profile are left alone", async () => {
    // The profile is shared by every server for this devShell. A server exiting while its
    // replacement is already running must not pull the new one's GC root out from under it.
    const s = await scene("successor", "a-different-server");
    await wrap(s, ["true"]);
    ok(!(await gone(s.lock)), "the successor's lock must survive");
    ok(!(await gone(s.profile)), "the successor's profile must survive");
    ok(!(await gone(`${s.profile}-1-link`)), "its generations must survive too");
  });

  await test("a lock that is already gone is not an error", async () => {
    const s = await scene("nolock");
    await fs.rm(s.lock);
    await wrap(s, ["true"]);
    ok(!(await gone(s.profile)), "with no lock to match against, nothing is released");
  });

  await test("the release environment never reaches the server", async () => {
    // These would otherwise be inherited by every terminal, task and debugger in the window.
    const s = await scene("leak");
    const out = await wrap(s, [
      "bash",
      "-c",
      'printf "[%s][%s][%s]" "${NIX_DEVELOP_LOCK-}" "${NIX_DEVELOP_PROFILE-}" "${NIX_DEVELOP_LOCK_TOKEN-}"',
    ]);
    eq(out, "[][][]", "the wrapper must unset its own variables before running the server");
  });

  await fs.rm(root, { recursive: true, force: true });
}

/**
 * Detecting which editor is running, and therefore which server matches it.
 *
 * The VSCodium values here are copied verbatim out of the `product.json` in
 * `vscodium-reh-linux-x64-1.135.06055.tar.gz`, so what is asserted is the real shape of a
 * real release rather than a guess at one.
 */
export async function runProductDetection(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const stub = await import("./activation-stub");
  const { readProduct, serverDownloadUrl, clientProduct, forgetProduct } = await import(
    "../src/remote/product"
  );

  console.log("\nproduct detection");

  const VSCODIUM = {
    nameLong: "VSCodium",
    applicationName: "codium",
    commit: "1a46a584725d5dd330e0bcd7f5510f24990efcf2",
    quality: "stable",
    serverApplicationName: "codium-server",
    serverDataFolderName: ".vscodium-server",
    dataFolderName: ".vscode-oss",
    serverDownloadUrlTemplate:
      "https://github.com/VSCodium/vscodium/releases/download/1.135.06055/" +
      "vscodium-reh-${os}-${arch}-1.135.06055.tar.gz",
  };

  // Microsoft's desktop build, as shipped: note the absence of a download template.
  const MICROSOFT = {
    nameLong: "Visual Studio Code",
    applicationName: "code",
    commit: "1e3c50d64110be466c0b4a45222e81d2c9352888",
    quality: "stable",
    version: "1.106.2",
    serverApplicationName: "code-server",
    serverDataFolderName: ".vscode-server",
    dataFolderName: ".vscode",
  };

  const root = await fs.mkdtemp(pathMod.join(os.tmpdir(), "nd-product-"));
  const appRoot = async (name: string, product?: unknown): Promise<string> => {
    const dir = pathMod.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    if (product) await fs.writeFile(pathMod.join(dir, "product.json"), JSON.stringify(product));
    return dir;
  };

  await test("reads VSCodium's own description of itself", async () => {
    const p = await readProduct(await appRoot("codium", VSCODIUM));
    eq(p.serverApplicationName, "codium-server", "the launcher is not called code-server");
    eq(p.serverDataFolderName, ".vscodium-server");
    eq(p.dataFolderName, ".vscode-oss");
    eq(p.nameLong, "VSCodium");
    ok(!!p.serverDownloadUrlTemplate, "VSCodium points at its own release");
  });

  await test("reads a Microsoft build, which declares no download URL", async () => {
    const p = await readProduct(await appRoot("ms", MICROSOFT));
    eq(p.serverApplicationName, "code-server");
    eq(p.serverDataFolderName, ".vscode-server");
    eq(p.serverDownloadUrlTemplate, undefined, "Microsoft keeps this in the CLI, not here");
  });

  await test("a product.json that cannot be read means a Microsoft build", async () => {
    // Being wrong about the product beats refusing to open a devShell window.
    const p = await readProduct(await appRoot("empty"));
    eq(p.serverApplicationName, "code-server");
    eq(p.serverDataFolderName, ".vscode-server");
  });

  const previousAppRoot = stub.env.appRoot;
  try {
    // `serverDownloadUrl` asks `clientProduct()` for the running editor rather than taking a
    // product, so these tests put the product in place the way the extension finds it.
    const running = async (name: string, product: unknown): Promise<void> => {
      stub.env.appRoot = await appRoot(name, product);
      forgetProduct();
    };

    await test("VSCodium is fetched from the release its product.json names", async () => {
      await running("codium2", VSCODIUM);
      const url = await serverDownloadUrl(VSCODIUM.commit);
      // The release tag is already baked into the template; only os and arch are placeholders.
      ok(
        /^https:\/\/github\.com\/VSCodium\/vscodium\/releases\/download\/1\.135\.06055\/vscodium-reh-[a-z0-9]+-[a-z0-9]+-1\.135\.06055\.tar\.gz$/.test(
          url,
        ),
        `unexpected URL: ${url}`,
      );
      ok(!url.includes("${"), "every placeholder must be substituted");
    });

    await test("a product with no template falls back to Microsoft's update server", async () => {
      await running("ms2", MICROSOFT);
      const url = await serverDownloadUrl("abc123");
      ok(url.startsWith("https://update.code.visualstudio.com/commit:abc123/server-"), url);
      ok(url.endsWith("/stable"), url);
      ok(!url.includes("${"), "every placeholder must be substituted");
    });

    await test("the setting overrides what the product declares", async () => {
      // Otherwise there would be no way to point VSCodium at a mirror.
      await running("codium3", VSCODIUM);
      const url = await serverDownloadUrl("c0ffee", "https://mirror.invalid/${commit}/${os}-${arch}");
      ok(/^https:\/\/mirror\.invalid\/c0ffee\/[a-z0-9]+-[a-z0-9]+$/.test(url), url);
    });

    await test("an existing ${platform} override keeps working", async () => {
      // This spelling is what the setting has always used; it must not break on upgrade.
      await running("ms3", MICROSOFT);
      const url = await serverDownloadUrl("c0ffee", "https://example.invalid/${commit}/${platform}");
      ok(/^https:\/\/example\.invalid\/c0ffee\/[a-z0-9]+-[a-z0-9]+$/.test(url), url);
    });

    await test("a blank setting is not treated as an override", async () => {
      // The setting's default is empty, and empty has to mean "detect it".
      await running("codium4", VSCODIUM);
      const url = await serverDownloadUrl("x", "   ");
      ok(url.includes("github.com/VSCodium"), "whitespace is not a URL");
    });

    await test("callers racing the first read share it instead of repeating it", async () => {
      // The memo holds the promise, not the result. Caching only the result would let every
      // caller that arrives before the first read finishes start a read of its own; they
      // would agree on the answer but each pay for it. Same object means one read.
      stub.env.appRoot = await appRoot("racing", VSCODIUM);
      forgetProduct();
      const [a, b, c] = await Promise.all([clientProduct(), clientProduct(), clientProduct()]);
      ok(a === b && b === c, "concurrent callers got separate reads");
      eq(a.serverApplicationName, "codium-server");
    });

    await test("the memo survives later calls", async () => {
      const first = await clientProduct();
      stub.env.appRoot = await appRoot("changed", MICROSOFT);
      eq(await clientProduct(), first, "the running editor cannot change under us");
    });

    await test("forgetting the memo reads again", async () => {
      forgetProduct();
      eq((await clientProduct()).serverApplicationName, "code-server");
    });

    await test("an editor with no appRoot is assumed to be a Microsoft build", async () => {
      stub.env.appRoot = undefined;
      forgetProduct();
      eq((await clientProduct()).serverApplicationName, "code-server");
    });
  } finally {
    stub.env.appRoot = previousAppRoot;
    forgetProduct();
  }

  await fs.rm(root, { recursive: true, force: true });
}

/**
 * Where an unpacked distribution begins.
 *
 * Microsoft wraps everything in a single `vscode-server-<platform>` directory; VSCodium's
 * REH tarball has no wrapper. Getting this wrong leaves a directory that looks extracted
 * and contains nothing usable, so both shapes are worth pinning.
 */
export async function runDistributionLayout(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const { findDistributionRoot } = await import("../src/remote/server");

  console.log("\ndistribution layout");

  const root = await fs.mkdtemp(pathMod.join(os.tmpdir(), "nd-layout-"));
  const build = async (name: string, inner?: string): Promise<string> => {
    const dir = pathMod.join(root, name);
    const at = inner ? pathMod.join(dir, inner) : dir;
    await fs.mkdir(pathMod.join(at, "bin"), { recursive: true });
    await fs.writeFile(pathMod.join(at, "product.json"), "{}");
    return dir;
  };

  await test("a flat distribution is its own root, as VSCodium ships it", async () => {
    const dir = await build("flat");
    eq(await findDistributionRoot(dir), dir);
  });

  await test("a wrapped distribution is found inside, as Microsoft ships it", async () => {
    const dir = await build("wrapped", "vscode-server-linux-x64");
    eq(await findDistributionRoot(dir), pathMod.join(dir, "vscode-server-linux-x64"));
  });

  await test("an archive with nothing recognisable in it is rejected", async () => {
    // Better a clear failure than a directory that looks extracted and is not.
    const dir = pathMod.join(root, "junk");
    await fs.mkdir(pathMod.join(dir, "a"), { recursive: true });
    await fs.mkdir(pathMod.join(dir, "b"), { recursive: true });
    eq(await findDistributionRoot(dir), undefined);
  });

  await fs.rm(root, { recursive: true, force: true });
}

/**
 * Settings a devShell declares for the editor.
 *
 * The parsing is where the risk is: a derivation attribute is always a string, so the same
 * `vscodeSettings` may arrive as JSON, as a list flattened onto one line, or as a here-doc
 * of `key=value` lines, and a store path must survive all three untouched.
 */
export async function runFlakeSettings(): Promise<void> {
  console.log("\nper-devShell settings");

  await test("reads a JSON object, as builtins.toJSON renders it", () => {
    const s = parseFlakeSettings('{"nix.serverPath":"/nix/store/abc-nil/bin/nil","nix.enableLanguageServer":true}');
    eq(s, { "nix.serverPath": "/nix/store/abc-nil/bin/nil", "nix.enableLanguageServer": true });
  });

  await test("keeps nested values, so an object setting survives", () => {
    const s = parseFlakeSettings('{"[nix]":{"editor.tabSize":2},"files.exclude":{"**/result":true}}');
    eq(s, { "[nix]": { "editor.tabSize": 2 }, "files.exclude": { "**/result": true } });
  });

  await test("reads key=value lines, as a multi-line string yields them", () => {
    const s = parseFlakeSettings("nix.serverPath=/nix/store/abc-nil/bin/nil\nnix.enableLanguageServer=true\n");
    eq(s, { "nix.serverPath": "/nix/store/abc-nil/bin/nil", "nix.enableLanguageServer": true });
  });

  await test("reads a Nix list, which arrives space-separated on one line", () => {
    const s = parseFlakeSettings("editor.tabSize=2 editor.formatOnSave=true");
    eq(s, { "editor.tabSize": 2, "editor.formatOnSave": true });
  });

  await test("a value with spaces stays one setting", () => {
    // Only a line whose every word is a pair can be several pairs; this one is not.
    const s = parseFlakeSettings("terminal.integrated.defaultProfile.linux=my shell");
    eq(s, { "terminal.integrated.defaultProfile.linux": "my shell" });
  });

  await test("a path that is not JSON stays the string it looks like", () => {
    const s = parseFlakeSettings("python.defaultInterpreterPath=/nix/store/xyz/bin/python3");
    eq(s, { "python.defaultInterpreterPath": "/nix/store/xyz/bin/python3" });
  });

  await test("rejects keys that are not settings keys", () => {
    eq(parseFlakeSettings('{"notasetting":1,"ok.key":2}'), { "ok.key": 2 });
  });

  await test("malformed JSON costs the settings, not the devShell", () => {
    eq(parseFlakeSettings("{ this is not json"), {});
    eq(parseFlakeSettings("[1,2]"), {}, "an array is not a settings object either");
  });

  await test("ignores flake-declared settings when the setting is off", () => {
    const s = collectSettings({ ...cfg, remote: { ...cfg.remote, settingsFromFlake: false } }, {
      vscodeSettings: '{"a.b":1}',
    });
    eq(s.fromFlake, {});
  });

  await test("workspace settings win over the flake", () => {
    const s = collectSettings({ ...cfg, remote: { ...cfg.remote, settings: { "a.b": "mine" } } }, {
      vscodeSettings: '{"a.b":"flake","c.d":"flake"}',
    });
    eq(mergedSettings(s), { "a.b": "mine", "c.d": "flake" });
  });

  console.log("\nmachine settings file");

  await test("writes into the devShell server's own machine settings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-set-"));
    const result = await applyMachineSettings(dir, { "nix.serverPath": "/nix/store/a/bin/nil" });
    eq(result.written, ["nix.serverPath"]);
    const file = machineSettingsPath(dir);
    eq(JSON.parse(await fs.readFile(file, "utf8")), { "nix.serverPath": "/nix/store/a/bin/nil" });
    ok(file.includes(path.join("data", "Machine")), `unexpected location: ${file}`);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("leaves settings it did not write alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-set-"));
    const file = machineSettingsPath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ "editor.fontSize": 15 }');
    await applyMachineSettings(dir, { "nix.serverPath": "/a" });
    eq(JSON.parse(await fs.readFile(file, "utf8")), {
      "editor.fontSize": 15,
      "nix.serverPath": "/a",
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("drops a key the flake has stopped declaring", async () => {
    // Otherwise deleting a line from the flake would leave its value behind forever.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-set-"));
    await applyMachineSettings(dir, { "nix.serverPath": "/a", "nix.formatterPath": "/b" });
    const result = await applyMachineSettings(dir, { "nix.serverPath": "/a" });
    eq(result.removed, ["nix.formatterPath"]);
    eq(JSON.parse(await fs.readFile(machineSettingsPath(dir), "utf8")), { "nix.serverPath": "/a" });
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("an unchanged run does not rewrite the file", async () => {
    // Which is what keeps a user's own comments in it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-set-"));
    await applyMachineSettings(dir, { "nix.serverPath": "/a" });
    const file = machineSettingsPath(dir);
    await fs.writeFile(file, '// mine\n{\n  "nix.serverPath": "/a",\n}\n');
    await applyMachineSettings(dir, { "nix.serverPath": "/a" });
    ok((await fs.readFile(file, "utf8")).startsWith("// mine"), "the comment must survive");
    await fs.rm(dir, { recursive: true, force: true });
  });

  await test("a comment does not truncate a path containing //", () => {
    const parsed = parseJsonc('{\n  // ours\n  "a.b": "https://example.invalid/x" /* end */\n}');
    eq(parsed, { "a.b": "https://example.invalid/x" });
  });

  await test("tolerates a trailing comma, which settings.json allows", () => {
    eq(parseJsonc('{ "a.b": 1, }'), { "a.b": 1 });
  });
}

/**
 * Acquiring a server end to end, against a local HTTP server standing in for a release.
 *
 * The unit tests above check what URL a product produces; this checks that `ensureServer`
 * actually asks for that URL and can use what comes back. Worth its own test because
 * `serverDownloadUrl(commit, configured)` takes two strings in a row -- swapping them would
 * typecheck perfectly and only show up as a 404 in the wild.
 */
export async function runServerAcquisition(): Promise<void> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const http = await import("node:http");
  const cp = await import("node:child_process");
  const stub = await import("./activation-stub");
  const { ServerManager, serverPlatform } = await import("../src/remote/server");
  const { forgetProduct } = await import("../src/remote/product");

  console.log("\nserver acquisition");

  const root = await fs.mkdtemp(pathMod.join(os.tmpdir(), "nd-acquire-"));
  const commit = "1a46a584725d5dd330e0bcd7f5510f24990efcf2";

  // A distribution shaped the way VSCodium ships one: no wrapper directory, and a launcher
  // named after the product rather than `code-server`.
  const dist = pathMod.join(root, "dist");
  await fs.mkdir(pathMod.join(dist, "bin"), { recursive: true });
  await fs.writeFile(
    pathMod.join(dist, "product.json"),
    JSON.stringify({ serverApplicationName: "codium-server", commit }),
  );
  await fs.writeFile(pathMod.join(dist, "bin", "codium-server"), "#!/bin/sh\n", { mode: 0o755 });
  const tarball = pathMod.join(root, "dist.tar.gz");
  cp.execFileSync("tar", ["-czf", tarball, "-C", dist, "."]);
  const bytes = await fs.readFile(tarball);

  // The editor that is running, as far as the extension can tell.
  const appRoot = pathMod.join(root, "app");
  await fs.mkdir(appRoot, { recursive: true });
  await fs.writeFile(
    pathMod.join(appRoot, "product.json"),
    JSON.stringify({
      nameLong: "VSCodium",
      quality: "stable",
      serverApplicationName: "codium-server",
      serverDataFolderName: ".vscodium-server",
      dataFolderName: ".vscode-oss",
    }),
  );

  let asked = "";
  const server = http.createServer((req, res) => {
    asked = req.url ?? "";
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(bytes);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

  const previousAppRoot = stub.env.appRoot;
  stub.env.appRoot = appRoot;
  forgetProduct();

  try {
    const storage = pathMod.join(root, "storage");
    const acquireCfg: NixDevelopConfig = {
      ...cfg,
      remote: {
        ...cfg.remote,
        serverDownloadUrl: `http://127.0.0.1:${port}/\${commit}/server-\${platform}.tar.gz`,
      },
    };
    const manager = new ServerManager({ fsPath: storage } as never, acquireCfg);
    let launcher = "";

    await test("downloads from the URL the commit and platform belong in", async () => {
      launcher = await manager.ensureServer(commit);
      eq(asked, `/${commit}/server-${serverPlatform()}.tar.gz`, "the request went somewhere else");
    });

    await test("finds a launcher named after the product, not code-server", async () => {
      eq(pathMod.basename(launcher), "codium-server");
      ok(await fs.lstat(launcher).then(() => true).catch(() => false), `${launcher} is missing`);
    });

    await test("unwraps a flat archive without losing the distribution", async () => {
      const dir = pathMod.dirname(pathMod.dirname(launcher));
      const entries = (await fs.readdir(dir)).sort();
      eq(entries, ["bin", "product.json"], "the distribution should sit at the top of the dir");
    });

    await test("a second acquisition reuses what is on disk", async () => {
      asked = "";
      eq(await manager.ensureServer(commit), launcher);
      eq(asked, "", "nothing should have been downloaded again");
    });
  } finally {
    stub.env.appRoot = previousAppRoot;
    forgetProduct();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}
