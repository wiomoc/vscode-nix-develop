import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NixDevShellConfig } from "../src/config";
import { ensureInstalled, installedIn } from "../src/provision/extensions";
import { run as exec } from "../src/utils/run-subprocess";
import { isPortOpen, ServerManager } from "../src/remote/server";
import { patchServerNode } from "../src/remote/server-ld-patch";
import { forgetProduct, readProduct, serverDownloadUrl, serverOsArch } from "../src/remote/product";
import * as stub from "./activation-stub";
import { currentSystem } from "../src/nix";

const cfg: NixDevShellConfig = {
  flakeDirectory: ".",
  promptWhenUnset: true,
  impure: false,
  extraArgs: [],
  nixPath: "nix",
  buildTimeoutSeconds: 1800,
  profile: "persistent",
  showBuildOutput: "onFailure",
  remote: {
    serverDownloadUrl: "https://update.code.visualstudio.com/commit:${commit}/server-${platform}/stable",
    connectTimeoutSeconds: 300,
    patchServerLd: true,
  },
};

const FLAKE = `{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      system = "@SYSTEM@";
      pkgs = nixpkgs.legacyPackages.\${system};
    in {
      devShells.\${system}.default = pkgs.mkShell {
        name = "server-e2e";
        packages = [ pkgs.hello ];
        SERVER_E2E_MARKER = "present";
      };
    };
}
`;

const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(() => true).catch(() => false);

const commit = process.env.NIX_DEVSHELL_COMMIT ?? "";

/** `dist/provision.js`, from `npm run build`; checked up front so a missing build is obvious. */
const provisionScript = path.join(import.meta.dirname, "..", "dist", "provision.js");

beforeAll(async () => {
  expect(
    await exists(provisionScript),
    `${provisionScript} is missing; run 'npm run build' before the e2e suite`,
  ).toBe(true);
});

/**
 * Drives the real server lifecycle: start inside `nix develop`, check the environment
 * reached it, reuse it, stop it. NIX_DEVSHELL_SERVER_DIR (containing `bin/code-server`)
 * skips the download for NIX_DEVSHELL_COMMIT. Tests run in order and share one server.
 */
describe.skipIf(commit === "")("server (end-to-end)", { tags: ["e2e"] }, () => {
  const key = "testkey";
  let storage = "";
  let work = "";
  let manager: ServerManager;
  let installable = "";
  let extensionsDir = "";
  let serverDataDir = "";
  let profile = "";
  let launcher = "";
  let port = 0;

  beforeAll(async () => {
    storage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-server-"));
    work = await fs.mkdtemp(path.join(os.tmpdir(), "nd-work-"));
    manager = new ServerManager({ fsPath: storage } as never, cfg);

    // Seed the managed location from a pre-extracted distribution when one is provided.
    const preset = process.env.NIX_DEVSHELL_SERVER_DIR;
    if (preset) {
      const dest = path.join(storage, "server", commit);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.symlink(preset, dest);
    }

    const sys = await currentSystem(cfg, work);
    await fs.writeFile(path.join(work, "flake.nix"), FLAKE.replace("@SYSTEM@", sys));
    installable = `path:${work}#devShells.${sys}.default`;

    extensionsDir = path.join(storage, "ext");
    serverDataDir = path.join(storage, "data");
    profile = path.join(work, ".vscode", "nix-devshell", "default", "devshell");
  });

  afterAll(async () => {
    await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  });

  it("acquires a server distribution for the running commit", async () => {
    launcher = await manager.ensureServer(commit);
    expect(launcher, `unexpected launcher: ${launcher}`).toMatch(/bin\/code-server$/);
    await fs.access(launcher);
  });

  it("reuses a server another VS Code feature already downloaded", async () => {
    // The CLI behind `code tunnel` keeps servers at
    // <cli data>/servers/<quality>-<commit>/server/bin/code-server.
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "nd-home-"));
    const cliServer = path.join(fakeHome, ".vscode", "cli", "servers", `Stable-${commit}`, "server", "bin");
    await fs.mkdir(cliServer, { recursive: true });
    await fs.writeFile(path.join(cliServer, "code-server"), "#!/bin/sh\n", { mode: 0o755 });
    // A web build for the same commit must not be mistaken for a remote server.
    const webServer = path.join(fakeHome, ".vscode", "cli", "servers", `Stable-${commit}-web`, "server", "bin");
    await fs.mkdir(webServer, { recursive: true });
    await fs.writeFile(path.join(webServer, "code-server"), "#!/bin/sh\n", { mode: 0o755 });

    const emptyStorage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-empty-"));
    const isolated = new ServerManager({ fsPath: emptyStorage } as never, cfg);
    const saved = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const found = await isolated.ensureServer(commit);
      expect(found, "should reuse the CLI's copy, not download").toEqual(
        path.join(cliServer, "code-server"),
      );
      expect(found, "the web build is not a remote server").not.toContain("-web");
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      await fs.rm(fakeHome, { recursive: true, force: true });
      await fs.rm(emptyStorage, { recursive: true, force: true });
    }
  });

  it("patches the server's node against a nixpkgs glibc", async () => {
    // The fixture above leaves `patchServerLd` on, so the extension does the two patchelf
    // calls itself and a missing patch here is a bug rather than a setting.
    const patched = await patchServerNode(cfg, launcher, work);
    const { linker = "", rpath = "" } = patched;
    expect(linker !== "" && rpath !== "", "patching reports what it wrote").toBe(true);

    for (const entry of [linker, ...rpath.split(":")]) {
      expect(entry, `expected a store path, got ${entry}`).toMatch(/^\/nix\/store\//);
      expect(await exists(entry), `${entry} does not exist; the patched node will not start`).toBe(true);
    }
    const libs = rpath.split(":");
    expect(libs.length >= 2, "the rpath replaces node's own, so it needs libstdc++ too").toBe(true);
    expect(
      await exists(path.join(libs[1], "libstdc++.so.6")),
      `no libstdc++.so.6 under ${libs[1]}; patched node will not start`,
    ).toBe(true);

    // The point of the patch: this binary runs on a host with no /lib64/ld-linux.
    const node = path.join(path.dirname(path.dirname(await fs.realpath(launcher))), "node");
    const { stdout } = await exec(node, ["-p", "process.versions.node"], {
      cwd: work,
      timeoutMs: 60_000,
    });
    expect(stdout.trim().length > 0, "the patched node did not report a version").toBe(true);

    // Patching is idempotent, so a warm resolve does not rewrite the binary at all.
    const again = await patchServerNode(cfg, launcher, work);
    expect(again.linker).toEqual(linker);
  });

  it("patches a node that another server is already running", async (ctx) => {
    // Patching must work while the binary is running (`Text file busy`). Uses a throwaway
    // copy of the distribution.
    const patchelf = await exec("patchelf", ["--version"], { cwd: work, timeoutMs: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!patchelf) ctx.skip("no patchelf on PATH");

    const dist = await fs.mkdtemp(path.join(os.tmpdir(), "nd-dist-"));
    const child = { proc: undefined as ReturnType<typeof spawn> | undefined };
    try {
      const node = path.join(dist, "node");
      const fakeLauncher = path.join(dist, "bin", "code-server");
      await fs.mkdir(path.dirname(fakeLauncher), { recursive: true });
      await fs.writeFile(fakeLauncher, "#!/bin/sh\n", { mode: 0o755 });
      await fs.copyFile(
        path.join(path.dirname(path.dirname(await fs.realpath(launcher))), "node"),
        node,
      );
      await fs.chmod(node, 0o755);

      // Patch it once so the copy runs here at all, then make it stale so the next patch
      // has real work to do.
      const { rpath = "" } = await patchServerNode(cfg, fakeLauncher, work);
      await exec("patchelf", ["--set-rpath", `${rpath}:/nonexistent`, node], {
        cwd: work,
        timeoutMs: 60_000,
      });

      child.proc = spawn(node, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 1_000));
      expect(child.proc.exitCode, "the child should still be running the copied node").toBeNull();

      await patchServerNode(cfg, fakeLauncher, work);
      const { stdout } = await exec("patchelf", ["--print-rpath", node], {
        cwd: work,
        timeoutMs: 60_000,
      });
      expect(stdout.trim(), "the busy node was not repatched").toEqual(rpath);
      expect(child.proc.exitCode, "the running child must survive the swap").toBeNull();
    } finally {
      child.proc?.kill("SIGKILL");
      await fs.rm(dist, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // `patchServerLd` is honoured in `resolver.ts`; testing it needs a full resolve.
  it.todo("patchServerLd turned off touches neither the binary nor the environment");

  it("nothing is running before we start", async () => {
    expect(await manager.findRunning(key, commit)).toBeUndefined();
  });

  it("starts a server inside nix develop and reports a port", async () => {
    const handle = await manager.start({
      key,
      commit,
      launcher,
      installable,
      flakeDir: work,
      profile,
      extensionsDir,
      serverDataDir,
      provisionScript,
    });
    port = handle.port;
    expect(handle.port > 0, "a listening port is required").toBe(true);
    expect(handle.connectionToken.length > 0, "a connection token is required").toBe(true);
    expect(handle.pid > 0, "a pid is required to reuse or stop the server").toBe(true);
  });

  it("the running server's devShell is a GC root", async () => {
    // Without --profile there is nothing holding the shell's store paths, so
    // `nix store gc` may collect them out from under a server that is still serving.
    const target = await fs.readlink(profile);
    expect(target.length > 0, "nix develop --profile should have written the profile symlink").toBe(true);
  });

  it("the server process really has the devShell environment", async () => {
    const pids = await serverPids(storage);
    expect(pids.length > 0, "no server process found").toBe(true);
    let marked = 0;
    let withHello = 0;
    for (const pid of pids) {
      const env = await readProcEnv(pid);
      if (env.SERVER_E2E_MARKER === "present") marked++;
      if ((env.PATH ?? "").split(":").some((p) => p.includes("hello"))) withHello++;
    }
    expect(marked > 0, "no server process carried the devShell's SERVER_E2E_MARKER").toBe(true);
    expect(withHello > 0, "the devShell's packages are not on the server's PATH").toBe(true);
  });

  it("the server is not told it is running on an unsupported OS", async () => {
    // VSCODE_SERVER_CUSTOM_GLIBC_LINKER in the server's environment triggers the
    // "unsupported OS" warning; see `patchServerNode`.
    const pids = await serverPids(storage);
    expect(pids.length > 0, "no server process found").toBe(true);
    for (const pid of pids) {
      const env = await readProcEnv(pid);
      expect(env.VSCODE_SERVER_CUSTOM_GLIBC_LINKER, `pid ${pid} carries the glibc hook`).toBeUndefined();
      expect(env.VSCODE_SERVER_CUSTOM_GLIBC_PATH, `pid ${pid} carries the glibc hook`).toBeUndefined();
      expect(env.VSCODE_SERVER_PATCHELF_PATH, `pid ${pid} carries the glibc hook`).toBeUndefined();
    }
  });

  it("a second resolve reuses the running server instead of starting another", async () => {
    const found = await manager.findRunning(key, commit);
    expect(found, "the lock file should let another window attach").toBeTruthy();
    expect(found!.port, "reuse must return the same port").toEqual(port);
  });

  it("installs a declared extension into the devShell's own directory", async (ctx) => {
    const vsix = process.env.NIX_DEVSHELL_TEST_VSIX;
    if (!vsix) ctx.skip("no NIX_DEVSHELL_TEST_VSIX");
    const res = await ensureInstalled({
      launcher,
      extensionsDir,
      serverDataDir,
      flakeDir: work,
      wanted: [vsix!],
    });
    expect(res.failed, "the install should succeed").toEqual([]);
    const installed = await installedIn(extensionsDir);
    expect(installed.length > 0, `expected an extension in ${extensionsDir}, found none`).toBe(true);
  });

  it("stops the server for real, not just its lock file", async () => {
    const before = await serverPids(storage);
    expect(await manager.stop(key)).toBe(true);
    expect(await manager.findRunning(key, commit)).toBeUndefined();

    // The port must close immediately; processes get a grace period to exit.
    expect(await isPortOpen(port), "the server is still accepting connections").toBe(false);

    const deadline = Date.now() + 15_000;
    let survivors = before;
    while (Date.now() < deadline && survivors.length > 0) {
      const after = await serverPids(storage);
      survivors = before.filter((p) => after.includes(p));
      if (survivors.length > 0) await new Promise((r) => setTimeout(r, 250));
    }
    const detail = await Promise.all(
      survivors.map(async (p) => `${p}: ${(await cmdlineOf(p)).slice(0, 160)}`),
    );
    expect(survivors, `a server process outlived stop():\n    ${detail.join("\n    ")}`).toEqual([]);
  });

  it("stopping leaves the devShell's GC root in place", async () => {
    // The profile is the project's, not the stopped server's: it is what keeps the shell
    // out of the next `nix store gc`, so the folder reopens without a rebuild.
    expect(await exists(profile), "the profile should survive the server it was built for").toBe(true);
  });
});

/**
 * The same lifecycle for the editor at `NIX_DEVSHELL_APP_ROOT` (VSCodium in CI), with
 * everything read from its `product.json`. Skipped for Microsoft's build.
 */
const appRoot = process.env.NIX_DEVSHELL_APP_ROOT ?? "";
// Read here, not in a hook, because `skipIf` is evaluated first. A skipped suite's body
// still runs, hence the defaults below.
const editor = appRoot !== "" ? await readProduct(appRoot) : undefined;
const productCommit = editor?.commit ?? "";

describe.skipIf(!editor?.serverDownloadUrlTemplate || productCommit === "")(
  "server, product-declared (end-to-end)",
  { tags: ["e2e"] },
  () => {
    // No `serverDownloadUrl` override: the editor's product decides. `clientProduct()`
    // memoises, hence the forget on both sides.
    const productCfg: NixDevShellConfig = {
      ...cfg,
      remote: { ...cfg.remote, serverDownloadUrl: "" },
    };
    // The rest patches against a glibc nixpkgs only has on Linux, and reads /proc.
    const linuxOnly = process.platform !== "linux";
    const key = "productkey";

    let storage = "";
    let work = "";
    let manager: ServerManager;
    let savedAppRoot: string | undefined;
    let launcher = "";
    let port = 0;

    beforeAll(async () => {
      storage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-product-"));
      work = await fs.mkdtemp(path.join(os.tmpdir(), "nd-product-work-"));
      manager = new ServerManager({ fsPath: storage } as never, productCfg);
      savedAppRoot = stub.env.appRoot;
      stub.env.appRoot = appRoot;
      forgetProduct();
    });

    afterAll(async () => {
      await manager?.stop(key).catch(() => undefined);
      stub.env.appRoot = savedAppRoot;
      forgetProduct();
      await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    });

    it("asks the editor where its server comes from", async () => {
      const product = editor!;
      const url = await serverDownloadUrl(productCommit, productCfg.remote.serverDownloadUrl);
      expect(
        url.includes("update.code.visualstudio.com"),
        `fell back to Microsoft's update server for ${product.nameLong}: ${url}`,
      ).toBe(false);
      expect(url, `the release tag is not resolved: ${url}`).toContain(product.version);
      const { os: osName, arch } = serverOsArch();
      expect(url, `not a server for this platform: ${url}`).toContain(`${osName}-${arch}`);
    });

    it("acquires one, and finds the launcher the product names", async () => {
      launcher = await manager.ensureServer(productCommit);
      // Launcher name and tarball layout both come from the distribution.
      expect(path.basename(launcher)).toEqual(editor!.serverApplicationName);
      await fs.access(launcher);
    });

    it.skipIf(linuxOnly)("patches its node the same way as Microsoft's", async () => {
      // Checks the patch's layout assumption for a differently laid-out tarball.
      const { linker, rpath } = await patchServerNode(productCfg, launcher, work);
      expect(linker, `expected a store path, got ${linker}`).toMatch(/^\/nix\/store\//);
      expect(
        rpath.split(":").length >= 2,
        "the rpath replaces node's own, so it needs libstdc++ too",
      ).toBe(true);

      const node = path.join(path.dirname(path.dirname(await fs.realpath(launcher))), "node");
      const { stdout } = await exec(node, ["-p", "process.versions.node"], {
        cwd: work,
        timeoutMs: 60_000,
      });
      expect(stdout.trim().length > 0, "the patched node did not report a version").toBe(true);
    });

    it.skipIf(linuxOnly)("starts inside nix develop, with the devShell environment", async () => {
      const sys = await currentSystem(productCfg, work);
      await fs.writeFile(path.join(work, "flake.nix"), FLAKE.replace("@SYSTEM@", sys));

      const handle = await manager.start({
        key,
        commit: productCommit,
        launcher,
        installable: `path:${work}#devShells.${sys}.default`,
        flakeDir: work,
        profile: path.join(work, ".vscode", "nix-devshell", "default", "devshell"),
        extensionsDir: path.join(storage, "ext"),
        serverDataDir: path.join(storage, "data"),
        provisionScript,
      });
      port = handle.port;
      expect(handle.port > 0, "a listening port is required").toBe(true);

      const pids = await serverPids(storage);
      expect(pids.length > 0, "no server process found").toBe(true);
      const envs = await Promise.all(pids.map(readProcEnv));
      expect(
        envs.some((e) => e.SERVER_E2E_MARKER === "present"),
        "no server process carried the devShell's SERVER_E2E_MARKER",
      ).toBe(true);
    });

    it.skipIf(linuxOnly)("stops for real, like any other product's server", async () => {
      expect(await manager.stop(key)).toBe(true);
      expect(await isPortOpen(port), "the server is still accepting connections").toBe(false);
    });
  },
);

/**
 * VS Code server processes, matched on split `/proc/<pid>/cmdline` arguments so shells
 * merely mentioning the path do not match.
 */
async function serverPids(marker?: string): Promise<number[]> {
  const out: number[] = [];
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = (await fs.readFile(`/proc/${entry}/cmdline`, "utf8")).split("\u0000").filter(Boolean);
      if (args.length < 2) continue;
      if (!args[0].endsWith("/node")) continue;
      if (!args.some((a) => a.endsWith("out/server-main.js"))) continue;
      // Other VS Code servers may be running on this machine -- the user's own devShell
      // windows, for instance. Only ever consider the one this test started.
      if (marker && !args.some((a) => a.includes(marker))) continue;
      out.push(Number(entry));
    } catch {
      /* the process went away between readdir and read */
    }
  }
  return out;
}

async function readProcEnv(pid: number): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  try {
    const raw = await fs.readFile(`/proc/${pid}/environ`, "utf8");
    for (const entry of raw.split("\u0000")) {
      const at = entry.indexOf("=");
      if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
    }
  } catch {
    /* not readable */
  }
  return env;
}

async function cmdlineOf(pid: number): Promise<string> {
  try {
    return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\u0000/g, " ").trim();
  } catch {
    return "(gone)";
  }
}
/**
 * An unused server exits on its own. Uses its own server, and is opt-in because the
 * grace period is a fixed five minutes.
 */
describe.skipIf(commit === "" || process.env.NIX_DEVSHELL_E2E_IDLE !== "1")(
  "idle shutdown (end-to-end)",
  { tags: ["e2e"] },
  () => {
  const key = "idlekey";
  let storage = "";
  let work = "";
  let manager: ServerManager;
  let profile = "";
  let lock = "";
  let port = 0;

  beforeAll(async () => {
    storage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-idle-"));
    work = await fs.mkdtemp(path.join(os.tmpdir(), "nd-idle-work-"));
    manager = new ServerManager({ fsPath: storage } as never, cfg);

    const preset = process.env.NIX_DEVSHELL_SERVER_DIR;
    if (preset) {
      const dest = path.join(storage, "server", commit);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.symlink(preset, dest);
    }

    profile = path.join(work, ".vscode", "nix-devshell", "default", "devshell");
    lock = path.join(storage, "server", "instances", `${key}.json`);

    const sys = await currentSystem(cfg, work);
    await fs.writeFile(path.join(work, "flake.nix"), FLAKE.replace("@SYSTEM@", sys));
    const launcher = await manager.ensureServer(commit);

    const handle = await manager.start({
      key,
      commit,
      launcher,
      installable: `${work}#devShells.${sys}.default`,
      flakeDir: work,
      profile,
      extensionsDir: path.join(storage, "ext"),
      serverDataDir: path.join(storage, "data"),
      provisionScript,
    });
    port = handle.port;
  });

  afterAll(async () => {
    await manager.stop(key).catch(() => undefined);
    await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  });

  it("starts a server that nothing ever connects to", async () => {
    expect(await exists(lock), "the lock should exist while the server runs").toBe(true);
    expect(await exists(profile), "the profile should pin the devShell while the server runs").toBe(true);
  });

  it("the server shuts itself down once it has been idle", async () => {
    const deadline = Date.now() + 8 * 60_000;
    while (Date.now() < deadline && (await isPortOpen(port))) {
      await new Promise((r) => setTimeout(r, 5_000));
    }
    expect(await isPortOpen(port), "an idle server must not run forever").toBe(false);
  });

  it("the lock outlives the server, and a sweep is what clears it", async () => {
    // The lock stays until the next sweep at activation.
    expect(await exists(lock), "a retired server leaves its lock behind").toBe(true);
    expect(await manager.sweep(), "the sweep should release exactly this lock").toEqual(1);
    expect(await exists(lock), "and the lock should be gone afterwards").toBe(false);
    expect(await exists(profile), "the devShell's GC root is not the sweep's to release").toBe(true);
  });
});
