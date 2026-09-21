import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { NixDevelopConfig } from "../src/config";
import { ensureInstalled, installedIn } from "../src/remote/extensions";
import { run as exec } from "../src/utils/run-subprocess";
import { isPortOpen, ServerManager } from "../src/remote/server";
import { eq, ok, test } from "./harness";

const cfg: NixDevelopConfig = {
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

/**
 * Drives the real VS Code server lifecycle: start it inside `nix develop`, confirm the
 * devShell environment actually reached the server process, reuse it, then stop it.
 *
 * Needs NIX_DEVELOP_E2E=1 and a VS Code server. Set NIX_DEVELOP_SERVER_DIR to an already
 * extracted distribution (the directory containing `bin/code-server`) to skip the ~70MB
 * download; otherwise the test downloads one for NIX_DEVELOP_COMMIT.
 */
const exists = (p: string): Promise<boolean> =>
  fs.lstat(p).then(() => true).catch(() => false);

export async function run(): Promise<void> {
  if (process.env.NIX_DEVELOP_E2E !== "1" || !process.env.NIX_DEVELOP_COMMIT) {
    console.log("\nserver (end-to-end)  [skipped: needs NIX_DEVELOP_E2E=1 and NIX_DEVELOP_COMMIT]");
    return;
  }
  console.log("\nserver (end-to-end)");

  const commit = process.env.NIX_DEVELOP_COMMIT;
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-server-"));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "nd-work-"));
  const manager = new ServerManager({ fsPath: storage } as never, cfg);

  // Seed the managed location from a pre-extracted distribution when one is provided.
  const preset = process.env.NIX_DEVELOP_SERVER_DIR;
  if (preset) {
    const dest = path.join(storage, "server", commit);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.symlink(preset, dest);
  }

  const system = (await import("../src/nix")).currentSystem;
  const sys = await system(cfg, work);
  await fs.writeFile(path.join(work, "flake.nix"), FLAKE.replace("@SYSTEM@", sys));
  const installable = `path:${work}#devShells.${sys}.default`;

  let launcher = "";
  await test("acquires a server distribution for the running commit", async () => {
    launcher = await manager.ensureServer(commit);
    ok(launcher.endsWith("bin/code-server"), `unexpected launcher: ${launcher}`);
    await fs.access(launcher);
  });

  await test("reuses a server another VS Code feature already downloaded", async () => {
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
      eq(found, path.join(cliServer, "code-server"), "should reuse the CLI's copy, not download");
      ok(!found.includes("-web"), "the web build is not a remote server");
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
      await fs.rm(fakeHome, { recursive: true, force: true });
      await fs.rm(emptyStorage, { recursive: true, force: true });
    }
  });

  const extensionsDir = path.join(storage, "ext");
  const serverDataDir = path.join(storage, "data");
  const profile = path.join(work, ".vscode", "nix-develop", "default", "devshell");
  const key = "testkey";

  await test("patches the server's node against a nixpkgs glibc", async () => {
    // The fixture above leaves `patchServerLd` on, so the extension does the two patchelf
    // calls itself and a missing patch here is a bug rather than a setting.
    const patched = await manager.patchServerNode(launcher, work);
    const { linker = "", rpath = "" } = patched;
    ok(linker !== "" && rpath !== "", "patching reports what it wrote");

    for (const entry of [linker, ...rpath.split(":")]) {
      ok(entry.startsWith("/nix/store/"), `expected a store path, got ${entry}`);
      ok(await exists(entry), `${entry} does not exist; the patched node will not start`);
    }
    const libs = rpath.split(":");
    ok(libs.length >= 2, "the rpath replaces node's own, so it needs libstdc++ too");
    ok(
      await exists(path.join(libs[1], "libstdc++.so.6")),
      `no libstdc++.so.6 under ${libs[1]}; patched node will not start`,
    );

    // The point of the patch: this binary runs on a host with no /lib64/ld-linux.
    const node = path.join(path.dirname(path.dirname(await fs.realpath(launcher))), "node")
    const { stdout } = await exec(node, ["-p", "process.versions.node"], {
      cwd: work,
      timeoutMs: 60_000,
    });
    ok(stdout.trim().length > 0, "the patched node did not report a version");

    // Patching is idempotent, so a warm resolve does not rewrite the binary at all.
    const again = await manager.patchServerNode(launcher, work);
    eq(again.linker, linker);
  });

  await test("patches a node that another server is already running", async () => {
    // Servers outlive their window and several devShells share one distribution, so there
    // is usually a `node` from this very file running when a resolve wants to patch it.
    // Linux refuses to write to a running executable -- patchelf fails with "open: Text
    // file busy" -- which is why the patch goes through a rename rather than in place.
    // A throwaway copy of the distribution keeps this off the one the user's own windows
    // are running on.
    const patchelf = await exec("patchelf", ["--version"], { cwd: work, timeoutMs: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!patchelf) {
      console.log("       (no patchelf on PATH; skipping busy-binary check)");
      return;
    }

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
      const { rpath = "" } = await manager.patchServerNode(fakeLauncher, work);
      await exec("patchelf", ["--set-rpath", `${rpath}:/nonexistent`, node], {
        cwd: work,
        timeoutMs: 60_000,
      });

      child.proc = spawn(node, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
      await new Promise((r) => setTimeout(r, 1_000));
      eq(child.proc.exitCode, null, "the child should still be running the copied node");

      await manager.patchServerNode(fakeLauncher, work);
      const { stdout } = await exec("patchelf", ["--print-rpath", node], {
        cwd: work,
        timeoutMs: 60_000,
      });
      eq(stdout.trim(), rpath, "the busy node was not repatched");
      eq(child.proc.exitCode, null, "the running child must survive the swap");
    } finally {
      child.proc?.kill("SIGKILL");
      await fs.rm(dist, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  await test("patchServerLd turned off touches neither the binary nor the environment", async () => {
    // A throwaway distribution -- `bin/<launcher>` plus the `node` beside it is all
    // `patchServerNode` resolves -- so this stays off the real one, which the tests below
    // actually run.
    const dist = await fs.mkdtemp(path.join(os.tmpdir(), "nd-nold-"));
    try {
      const fake = path.join(dist, "bin", "code-server");
      await fs.mkdir(path.dirname(fake), { recursive: true });
      await fs.writeFile(fake, "#!/bin/sh\n", { mode: 0o755 });
      const node = path.join(dist, "node");
      await fs.writeFile(node, "not really node\n", { mode: 0o755 });

      const unpatched = new ServerManager({ fsPath: storage } as never, {
        ...cfg,
        remote: { ...cfg.remote, patchServerLd: false },
      });
      const result = await unpatched.patchServerNode(fake, work);

      eq(result.patched, false);
      eq(result.node, node);
      eq(await fs.readFile(node, "utf8"), "not really node\n", "the binary must not be written");
      // Nothing to report, because nothing was resolved: with this off nothing is built
      // from nixpkgs at all, which is the only reason it is usable on a cold store.
      eq(result.linker, undefined);
      eq(result.rpath, undefined);
    } finally {
      await fs.rm(dist, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  await test("nothing is running before we start", async () => {
    eq(await manager.findRunning(key, commit), undefined);
  });

  let port = 0;
  try {
    await test("starts a server inside nix develop and reports a port", async () => {
      const handle = await manager.start({
        key,
        commit,
        launcher,
        installable,
        flakeDir: work,
        profile,
        extensionsDir,
        serverDataDir,
      });
      port = handle.port;
      ok(handle.port > 0, "a listening port is required");
      ok(handle.connectionToken.length > 0, "a connection token is required");
      ok(handle.pid > 0, "a pid is required to reuse or stop the server");
    });

    await test("the running server's devShell is a GC root", async () => {
      // Without --profile there is nothing holding the shell's store paths, so
      // `nix store gc` may collect them out from under a server that is still serving.
      const target = await fs.readlink(profile);
      ok(target.length > 0, "nix develop --profile should have written the profile symlink");
    });

    await test("the server process really has the devShell environment", async () => {
      const pids = await serverPids(storage);
      ok(pids.length > 0, "no server process found");
      let marked = 0;
      let withHello = 0;
      for (const pid of pids) {
        const env = await readProcEnv(pid);
        if (env.SERVER_E2E_MARKER === "present") marked++;
        if ((env.PATH ?? "").split(":").some((p) => p.includes("hello"))) withHello++;
      }
      ok(marked > 0, "no server process carried the devShell's SERVER_E2E_MARKER");
      ok(withHello > 0, "the devShell's packages are not on the server's PATH");
    });

    await test("the server is not told it is running on an unsupported OS", async () => {
      // The server reports isUnsupportedGlibc whenever VSCODE_SERVER_CUSTOM_GLIBC_LINKER is
      // in its environment, and the client turns that into "You are connected to an OS
      // version that is unsupported by Visual Studio Code". Patching node ourselves is what
      // keeps the variable out of the environment; this is the assertion that says so.
      //
      // The extension patching `node` itself, rather than letting `bin/code-server` do it
      // from these variables, is the whole reason they are absent. Anyone handing the
      // launcher the hooks again should expect this test to fail, not to be loosened.
      const pids = await serverPids(storage);
      ok(pids.length > 0, "no server process found");
      for (const pid of pids) {
        const env = await readProcEnv(pid);
        eq(env.VSCODE_SERVER_CUSTOM_GLIBC_LINKER, undefined, `pid ${pid} carries the glibc hook`);
        eq(env.VSCODE_SERVER_CUSTOM_GLIBC_PATH, undefined, `pid ${pid} carries the glibc hook`);
        eq(env.VSCODE_SERVER_PATCHELF_PATH, undefined, `pid ${pid} carries the glibc hook`);
      }
    });

    await test("a second resolve reuses the running server instead of starting another", async () => {
      const found = await manager.findRunning(key, commit);
      ok(!!found, "the lock file should let another window attach");
      eq(found!.port, port, "reuse must return the same port");
    });

    await test("installs a declared extension into the devShell's own directory", async () => {
      const vsix = process.env.NIX_DEVELOP_TEST_VSIX;
      if (!vsix) {
        console.log("       (no NIX_DEVELOP_TEST_VSIX; skipping install check)");
        return;
      }
      const res = await ensureInstalled({
        launcher,
        extensionsDir,
        serverDataDir,
        flakeDir: work,
        wanted: [vsix],
      });
      eq(res.failed, [], "the install should succeed");
      const installed = await installedIn(extensionsDir);
      ok(installed.length > 0, `expected an extension in ${extensionsDir}, found none`);
    });
  } finally {
    await test("stops the server for real, not just its lock file", async () => {
      const before = await serverPids(storage);
      eq(await manager.stop(key), true);
      eq(await manager.findRunning(key, commit), undefined);

      // `nix develop` forks the server and exits, so the pid we spawned is already dead.
      // Killing only that pid would leave the server listening for good -- which is what
      // this asserts. The port must be closed immediately; the processes are allowed a
      // grace period to finish shutting down, but must not survive it.
      eq(await isPortOpen(port), false, "the server is still accepting connections");

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
      eq(survivors, [], `a server process outlived stop():\n    ${detail.join("\n    ")}`);
    });

    await test("stopping leaves the devShell's GC root in place", async () => {
      // The profile is the project's, not the stopped server's: it is what keeps the shell
      // out of the next `nix store gc`, so the folder reopens without a rebuild.
      ok(await exists(profile), "the profile should survive the server it was built for");
    });
    await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Processes that are actually a VS Code server.
 *
 * `/proc/<pid>/cmdline` is NUL-separated, so it has to be split into real arguments before
 * matching: a substring search over the whole blob also matches any shell whose command
 * line happens to mention the path, including the one running this test.
 */
async function serverPids(marker?: string): Promise<number[]> {
  const out: number[] = [];
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = (await fs.readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0").filter(Boolean);
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
    for (const entry of raw.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } catch {
    /* not readable */
  }
  return env;
}

async function cmdlineOf(pid: number): Promise<string> {
  try {
    return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
  } catch {
    return "(gone)";
  }
}

/**
 * The guarantee the whole idle-shutdown design exists for: a devShell nobody is using stops
 * costing a Node process, without anyone asking it to.
 *
 * It gets its own server rather than joining `run()`, because proving it means letting that
 * server die -- which would strand every test after it. Nothing of the extension is alive
 * while the wait happens, which is the point: the lock outlives the server it names, and
 * stays until something on this side looks at it again.
 *
 * Opt-in, because the server's grace period is a fixed five minutes and no flag shortens it
 * without also making a window reload tear the server down.
 */
export async function runIdleShutdown(): Promise<void> {
  if (
    process.env.NIX_DEVELOP_E2E !== "1" ||
    !process.env.NIX_DEVELOP_COMMIT ||
    process.env.NIX_DEVELOP_E2E_IDLE !== "1"
  ) {
    console.log("\nidle shutdown (end-to-end)  [skipped: needs NIX_DEVELOP_E2E_IDLE=1, takes ~6min]");
    return;
  }
  console.log("\nidle shutdown (end-to-end)");

  const commit = process.env.NIX_DEVELOP_COMMIT;
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-idle-"));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "nd-idle-work-"));
  const manager = new ServerManager({ fsPath: storage } as never, cfg);

  const preset = process.env.NIX_DEVELOP_SERVER_DIR;
  if (preset) {
    const dest = path.join(storage, "server", commit);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.symlink(preset, dest);
  }

  const key = "idlekey";
  const profile = path.join(work, ".vscode", "nix-develop", "default", "devshell");
  const lock = path.join(storage, "server", "instances", `${key}.json`);
  let port = 0;

  try {
    const system = (await import("../src/nix")).currentSystem;
    const sys = await system(cfg, work);
    await fs.writeFile(path.join(work, "flake.nix"), FLAKE.replace("@SYSTEM@", sys));
    const launcher = await manager.ensureServer(commit);

    await test("starts a server that nothing ever connects to", async () => {
      const handle = await manager.start({
        key,
        commit,
        launcher,
        installable: `${work}#devShells.${sys}.default`,
        flakeDir: work,
        profile,
        extensionsDir: path.join(storage, "ext"),
        serverDataDir: path.join(storage, "data"),
      });
      port = handle.port;
      ok(await exists(lock), "the lock should exist while the server runs");
      ok(await exists(profile), "the profile should pin the devShell while the server runs");
    });

    await test("the server shuts itself down once it has been idle", async () => {
      const deadline = Date.now() + 8 * 60_000;
      while (Date.now() < deadline && (await isPortOpen(port))) {
        await new Promise((r) => setTimeout(r, 5_000));
      }
      eq(await isPortOpen(port), false, "an idle server must not run forever");
    });

    await test("the lock outlives the server, and a sweep is what clears it", async () => {
      // Nothing of ours runs inside the devShell, so an exiting server cannot tidy up after
      // itself. The lock it leaves is inert -- it names a port nothing answers on -- and
      // the next sweep, which the extension runs at activation, is what removes it.
      ok(await exists(lock), "a retired server leaves its lock behind");
      eq(await manager.sweep(), 1, "the sweep should release exactly this lock");
      eq(await exists(lock), false, "and the lock should be gone afterwards");
      ok(await exists(profile), "the devShell's GC root is not the sweep's to release");
    });
  } finally {
    await manager.stop(key).catch(() => undefined);
    await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
