import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NixDevShellConfig } from "../config";
import { log } from "../utils/log";
import { developCommand } from "../nix";
import { clientProduct, serverDownloadUrl, serverOsArch } from "./product";
import { exists } from "../utils/fs-stat";
import { run } from "../utils/run-subprocess";

/** Printed by the server once the extension host agent is accepting connections. */
const LISTENING = /Extension host agent listening on (\d+)/;

export interface ServerHandle {
  port: number;
  connectionToken: string;
  pid: number;
}

interface LockFile extends ServerHandle {
  installable: string;
  commit: string;
  startedAt: number;
}

/**
 * VS Code server distributions are per-commit and per-platform. The client refuses to
 * connect to a server built from a different commit, so the commit of the *running*
 * client is the one that matters.
 */
export function serverPlatform(): string {
  const { os, arch } = serverOsArch();
  return `${os}-${arch}`;
}

export class ServerManager {
  constructor(
    private readonly globalStorage: vscode.Uri,
    private readonly cfg: NixDevShellConfig,
  ) {}

  private get root(): string {
    return path.join(this.globalStorage.fsPath, "server");
  }

  private serverDir(commit: string): string {
    return path.join(this.root, commit);
  }

  /**
   * The launcher inside an extracted distribution.
   *
   * Its name is the product's -- `code-server`, `codium-server` -- so it is read from the
   * distribution's own `product.json` where there is one, and from the running editor's
   * otherwise. The last resort is whatever in `bin/` looks like a launcher, which covers a
   * rebuild whose `product.json` says nothing useful.
   */
  private async launcherIn(dir: string): Promise<string | undefined> {
    const names: string[] = [];
    const own = await readJson(path.join(dir, "product.json"));
    if (typeof own?.serverApplicationName === "string")
      names.push(own.serverApplicationName);
    names.push((await clientProduct()).serverApplicationName);

    for (const name of names) {
      const candidate = path.join(dir, "bin", name);
      if (await exists(candidate)) return candidate;
    }

    const bin = await fs
      .readdir(path.join(dir, "bin"))
      .catch(() => [] as string[]);
    const guess = bin.find((n) => n.endsWith("-server"));
    return guess ? path.join(dir, "bin", guess) : undefined;
  }

  // ------------------------------------------------------------- acquisition

  /**
   * Ensure a server matching `commit` is on disk, downloading it if necessary.
   *
   * The desktop application cannot stand in for one. It is a different build: it ships
   * `out/main.js` and an Electron binary, with no `out/server-main.js`, no `vs/server`, and
   * no plain `node` to run them with. That is why `code serve-web` and `code tunnel`
   * download a server too.
   *
   * What can be reused is a server some other feature of the same editor already fetched
   * for this exact commit, which saves a second ~220 MB copy.
   */
  async ensureServer(
    commit: string,
    progress?: (m: string) => void,
  ): Promise<string> {
    const dir = this.serverDir(commit);
    const managed = await this.launcherIn(dir);
    if (managed) return managed;

    const existing = await this.findExistingServer(commit);
    if (existing) {
      log.info(`reusing the server already on disk at ${existing}`);
      return existing;
    }

    const url = await serverDownloadUrl(
      commit,
      this.cfg.remote.serverDownloadUrl,
    );
    progress?.("Downloading the VS Code server…");
    log.info(`downloading server: ${url}`);

    const tmp = `${dir}.tmp-${process.pid}`;
    await fs.mkdir(tmp, { recursive: true });
    const tarball = path.join(tmp, "server.tar.gz");

    try {
      await download(url, tarball, (percent) => {
        progress?.(`Downloading the VS Code server… (${percent}%)`);
      });
      progress?.("Extracting the VS Code server…");
      await run("tar", ["-xzf", tarball, "-C", tmp], {
        cwd: tmp,
        timeoutMs: 600_000,
      });
      await fs.rm(tarball, { force: true });

      // Where the distribution actually begins differs by product: Microsoft's tarball
      // wraps everything in a single `vscode-server-<platform>` directory, VSCodium's has
      // no wrapper at all. Unpacking flat and then looking for the real root handles both
      // without having to be told which one this is.
      const root = await findDistributionRoot(tmp);
      if (!root) {
        throw new Error(
          `the downloaded archive contains no server distribution (from ${url})`,
        );
      }
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await fs.rename(root, dir);
      if (root !== tmp)
        await fs
          .rm(tmp, { recursive: true, force: true })
          .catch(() => undefined);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }

    const launcher = await this.launcherIn(dir);
    if (!launcher) {
      const name = (await clientProduct()).serverApplicationName;
      throw new Error(`the downloaded server has no bin/${name} (from ${url})`);
    }
    return launcher;
  }

  /**
   * A server for this commit that something else already downloaded.
   *
   * Remote-SSH unpacks into `~/<serverDataFolderName>/bin/<commit>`, and the CLI behind
   * `code tunnel` uses `<cli data>/servers/<quality>-<commit>/server`, where the quality
   * prefix varies by build; matching on the commit suffix avoids guessing its spelling and
   * also skips the `-web` variants, which are built for serving a browser UI rather than a
   * remote window. Both folder names come from the product, so VSCodium's
   * `.vscodium-server` and `.vscode-oss` are searched when VSCodium is what is running.
   *
   * A miss costs nothing -- the caller downloads -- so this is best effort by design.
   */
  private async findExistingServer(
    commit: string,
  ): Promise<string | undefined> {
    const home = process.env.HOME ?? "";
    if (!home) return undefined;
    const product = await clientProduct();

    const remoteSsh = path.join(
      home,
      product.serverDataFolderName,
      "bin",
      commit,
    );
    const fromRemoteSsh = await this.launcherIn(remoteSsh);
    if (fromRemoteSsh) return fromRemoteSsh;

    const cliRoots = [
      path.join(home, product.dataFolderName, "cli"),
      path.join(home, `${product.dataFolderName}-cli`),
    ];
    for (const root of cliRoots) {
      const servers = path.join(root, "servers");
      for (const name of await fs
        .readdir(servers)
        .catch(() => [] as string[])) {
        if (!name.endsWith(`-${commit}`)) continue;
        const candidate = await this.launcherIn(
          path.join(servers, name, "server"),
        );
        if (candidate) return candidate;
      }
    }
    return undefined;
  }

  // ---------------------------------------------------------------- lifecycle

  private lockPath(key: string): string {
    return path.join(this.root, "instances", `${key}.json`);
  }

  private readLock(key: string): Promise<LockFile | undefined> {
    return readJson(this.lockPath(key)) as Promise<LockFile | undefined>;
  }

  /**
   * A previously started server for this key, if it is still reachable.
   *
   * Liveness is decided by the *port*, not by the recorded pid. A lock outlives reboots,
   * and a pid from a previous boot is free to belong to something else entirely by the time
   * it is read back -- a live pid is no evidence that the server is the thing behind it.
   * The pid is recorded to signal, not to ask.
   *
   * This is also the backstop for releasing what a departed server held. The server's own
   * wrapper does that the moment it exits, so ordinarily there is nothing left to find;
   * what reaches here is what no wrapper survived to clean up -- a SIGKILL, an OOM kill, a
   * reboot. The commit is compared only after the port has answered: a lock from a
   * different commit is still worth releasing when nothing is behind it, and must be left
   * alone when something is.
   */
  async findRunning(
    key: string,
    commit: string,
  ): Promise<ServerHandle | undefined> {
    const lock = await this.readLock(key);
    if (!lock) return undefined;

    if (!(await isPortOpen(lock.port))) {
      await this.release(key, lock);
      return undefined;
    }
    if (lock.commit !== commit) return undefined;

    log.info(`reusing the devShell server on port ${lock.port}`);
    return {
      port: lock.port,
      connectionToken: lock.connectionToken,
      pid: lock.pid,
    };
  }

  /**
   * Give up what a departed server held: its lock.
   *
   * The devShell's GC root is not touched. A profile under `.vscode/nix-devshell/` is meant
   * to outlive the servers that enter it -- that is the whole of
   * `nixDevShell.profile: persistent` -- so the store paths stay put for the next window,
   * offline or not, and the directory is the user's to delete.
   *
   * Nothing runs inside the devShell to do this at the moment a server exits: the server is
   * the process `nix develop` execs into, with no shell of ours around it. So a lock is
   * cleaned up by whoever next looks at it -- `sweep`, `findRunning` or `stop` -- and until
   * then it is a lock naming a port nothing answers on, which every reader already checks
   * for. All three are idempotent, so the order they arrive in does not matter.
   */
  private async release(key: string, lock: LockFile): Promise<void> {
    await fs.rm(this.lockPath(key), { force: true });
    log.info(`released the lock for the devShell server on port ${lock.port}`);
  }

  /**
   * Drop every lock whose server is gone.
   *
   * A server that retires itself -- five minutes after its last window closes -- leaves its
   * lock behind, because nothing of ours is running at that moment to remove it. `stop` and
   * `findRunning` clear the one lock they are about; this is what clears the rest, and it
   * runs at activation, when a stale lock is exactly what a just-started editor is likely
   * to be looking at.
   *
   * A closed port is the test, as everywhere else. Reading a malformed or half-written lock
   * yields nothing and is left alone rather than deleted: an unreadable file here is not
   * evidence that a server is gone.
   */
  async sweep(): Promise<number> {
    const dir = path.join(this.root, "instances");
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    let released = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const key = name.slice(0, -".json".length);
      const lock = await this.readLock(key);
      if (!lock) continue;
      if (await isPortOpen(lock.port)) continue;
      try {
        await this.release(key, lock);
        released++;
      } catch (err) {
        log.warn(`could not release the stale lock ${name}: ${err}`);
      }
    }
    if (released > 0) log.info(`swept ${released} stale devShell server lock(s)`);
    return released;
  }

  private static async isStopped(lock: LockFile): Promise<boolean> {
    return !(await isPortOpen(lock.port)) && !groupAlive(lock.pid);
  }

  /**
   * Stop the server behind a key.
   *
   * The signal goes to the whole process *group* rather than the recorded pid. The child
   * was spawned detached, so it leads a new group that the real server stays in even after
   * `nix develop` itself exits -- signalling the bare pid would hit a corpse and leave the
   * server running.
   */
  async stop(key: string): Promise<boolean> {
    const lock = await this.readLock(key);
    if (!lock) return false;

    let signalled = false;
    for (const target of [-lock.pid, lock.pid]) {
      try {
        process.kill(target, "SIGTERM");
        signalled = true;
        break;
      } catch {
        /* already gone, or not a group leader */
      }
    }

    // Confirm it actually stopped rather than reporting success optimistically. The socket
    // closes before the process exits, so both have to be waited on.
    const deadline = Date.now() + 10_000;
    let stopped = await ServerManager.isStopped(lock);
    while (Date.now() < deadline && !stopped) {
      await delay(200);
      stopped = await ServerManager.isStopped(lock);
    }

    if (!stopped) {
      for (const target of [-lock.pid, lock.pid]) {
        try {
          process.kill(target, "SIGKILL");
          break;
        } catch {
          /* nothing left to kill */
        }
      }
      const hard = Date.now() + 3_000;
      stopped = await ServerManager.isStopped(lock);
      while (Date.now() < hard && !stopped) {
        await delay(100);
        stopped = await ServerManager.isStopped(lock);
      }
    }

    try {
      await this.release(key, lock);
    } catch (err) {
      log.warn(
        `failed to release the lock for the devShell server on port ${lock.port}: ${err}`,
      );
    }
    log.info(
      stopped
        ? `stopped the devShell server on port ${lock.port}`
        : `could not stop the devShell server on port ${lock.port}`,
    );
    return stopped && signalled;
  }

  /**
   * Start a server *inside* `nix develop`, so that the server process -- and therefore the
   * remote extension host it forks, its terminals, tasks and debuggers -- inherits the
   * devShell environment from birth.
   */
  async start(opts: {
    key: string;
    commit: string;
    launcher: string;
    installable: string;
    flakeDir: string;
    /** GC root for the shell the server runs in, if any; see `DevelopOptions.profile`. */
    profile: string | undefined;
    extensionsDir: string;
    serverDataDir: string;
    progress?: (m: string) => void;
  }): Promise<ServerHandle> {
    const connectionToken = crypto.randomUUID();
    await fs.mkdir(opts.extensionsDir, { recursive: true });
    await fs.mkdir(opts.serverDataDir, { recursive: true });
    await fs.mkdir(path.dirname(this.lockPath(opts.key)), { recursive: true });

    // How to enter a devShell belongs to `nix.ts`; what to run once inside it is the only
    // part this file gets an opinion about. `nix develop --command` execs, so the launcher
    // *is* the process this spawn returns -- nothing is interposed between the extension
    // and the server.
    const { exe, args } = await developCommand(this.cfg, {
      installable: opts.installable,
      profile: opts.profile,
      command: [
        opts.launcher,
        "--start-server",
        // Servers outlive the window that started them so the next one attaches instantly,
        // but nothing here notices when the *last* window goes away: VS Code never asks a
        // server to exit, and a devShell window cannot sensibly kill the server it is
        // running on. The server settles it itself. Five minutes after its last extension
        // host disconnects it exits; an extension host that reconnects inside that window
        // cancels it, which is what keeps reloads and reopens on the running server. The
        // same timer starts at boot, so a server we start and then fail to connect to is
        // collected too rather than lingering for the life of the machine.
        "--enable-remote-auto-shutdown",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--connection-token",
        connectionToken,
        "--accept-server-license-terms",
        "--telemetry-level",
        "off",
        "--server-data-dir",
        opts.serverDataDir,
        "--extensions-dir",
        opts.extensionsDir,
      ],
    });

    log.info(`starting devShell server: ${exe} ${args.join(" ")}`);
    opts.progress?.("Starting the server inside the devShell…");

    // Detached, so closing the window that started it does not tear the server down; the
    // lock file is how a later window finds it again.
    const child = spawn(exe, args, {
      cwd: opts.flakeDir,
      // Nothing of ours is added: whatever this process is given, the devShell window's
      // terminals, tasks and debuggers inherit.
      env: { ...process.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const port = await this.awaitListening(child, opts.progress);
    child.unref();

    const handle: ServerHandle = {
      port,
      connectionToken,
      pid: child.pid ?? -1,
    };
    const lock: LockFile = {
      ...handle,
      installable: opts.installable,
      commit: opts.commit,
      startedAt: Date.now(),
    };
    await fs.writeFile(this.lockPath(opts.key), JSON.stringify(lock, null, 2));
    log.info(
      `devShell server listening on 127.0.0.1:${port} (pid ${handle.pid})`,
    );
    return handle;
  }

  private awaitListening(
    child: ChildProcess,
    progress?: (m: string) => void,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const timeoutMs =
        Math.max(30, this.cfg.remote.connectTimeoutSeconds) * 1000;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            new Error(
              `the server did not report a listening port within ${timeoutMs / 1000}s`,
            ),
          ),
        );
      }, timeoutMs);

      const onChunk = (data: Buffer) => {
        const text = data.toString("utf8");
        buffer += text;
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t) log.info(`[server] ${t}`);
          if (/^(Installing|Downloading|Extracting|Updating)/i.test(t))
            progress?.(t.slice(0, 80));
        }
        const match = LISTENING.exec(buffer);
        if (match) finish(() => resolve(Number(match[1])));
      };

      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.on("error", (err) => finish(() => reject(err)));
      child.on("exit", (code) =>
        finish(() =>
          reject(
            new Error(
              `the server exited with code ${code} before listening.\n${buffer.slice(-1500)}`,
            ),
          ),
        ),
      );
    });
  }
}

/** Parse a JSON file, or nothing if it is missing or malformed. */
async function readJson(
  file: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

/**
 * Find the directory a freshly unpacked distribution actually starts at: the extraction
 * directory itself, or the single wrapper directory inside it.
 */
export async function findDistributionRoot(dir: string): Promise<string | undefined> {
  if (await exists(path.join(dir, "product.json"))) return dir;
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) return undefined;
  const inner = path.join(dir, dirs[0].name);
  return (await exists(path.join(inner, "product.json"))) ? inner : undefined;
}

export function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * `curl` is not guaranteed to exist, and the download is large enough that buffering it in
 * memory is wasteful, so stream it with the platform fetch into a file.
 */
async function download(url: string, dest: string, progress?: (percent: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  const contentLength = parseInt(res.headers.get("content-length") as string);
  let downloaded = 0;
  let lastPercent = -1;
  if (!res.ok || !res.body) {
    throw new Error(
      `downloading the server failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const handle = await fs.open(dest, "w");
  try {
    const out = handle.createWriteStream();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
      if (!isNaN(contentLength)) {
        downloaded += value.length;
        const percent = Math.floor((downloaded / contentLength) * 100);
        if (percent > lastPercent) {
          lastPercent = percent;
          progress?.(percent);
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(resolve);
    });
  } finally {
    await handle.close();
  }
}

/**
 * Does any process remain in the group led by `pid`? EPERM means something is there that
 * we may not signal, which still counts as alive.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
