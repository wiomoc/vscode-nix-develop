import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";
import type { NixDevShellConfig } from "../config";
import { log } from "../utils/log";
import { BUILD_LOG_FORMAT, developCommand, plainText } from "../nix";
import { clientProduct, serverDownloadUrl, serverOsArch } from "./product";
import { exists } from "../utils/fs-stat";
import { run, type TtyOptions } from "../utils/run-subprocess";
import { serverNodePath } from "./server-ld-patch";
import type { LockFile, ProvisionOptions } from "../provision/protocol";

/** How long one `--install-extension` inside the devShell may take. */
const INSTALL_TIMEOUT_SECONDS = 300;

/**
 * Where the output of `nix develop` goes: Nix's build log and the provisioning script's
 * stderr. Display only -- the script answers through its lock file and exit code.
 */
export interface BuildOutput {
  /** Nix's output verbatim, escape codes included. */
  onOutput?: (chunk: string) => void;
  /** The terminal rendering it, so Nix can be given a pty of matching size. */
  tty?: TtyOptions;
}

/** What a resolve needs to hand VS Code: where the server is, and how to talk to it. */
export interface ServerHandle {
  port: number;
  connectionToken: string;
  pid: number;
}

/** Server distributions are per-commit and per-platform; the client's commit must match. */
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
   * The launcher inside an extracted distribution. Its name is product-specific
   * (`code-server`, `codium-server`): taken from the distribution's `product.json`, then
   * the editor's, then any `bin/*-server`.
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
   * Ensure a server matching `commit` is on disk, downloading it if necessary. The desktop
   * build cannot serve (no `out/server-main.js`, no plain `node`), but a server another
   * feature already fetched for this commit is reused.
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

      // Microsoft's tarball has a wrapper directory, VSCodium's does not.
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
   * A server for this commit that something else already downloaded (best effort):
   * Remote-SSH's `~/<serverDataFolderName>/bin/<commit>`, or the tunnel CLI's
   * `<cli data>/servers/<quality>-<commit>/server`. Matching the commit suffix skips the
   * `-web` variants.
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
   * Liveness is decided by the port, not the pid: a lock outlives reboots, and a recycled
   * pid proves nothing. A dead lock is released even when its commit differs.
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
   * Remove a departed server's lock. The devShell's GC root stays: a persistent profile is
   * meant to outlive servers.
   *
   * Nothing of ours runs when a server exits, so locks are cleaned up lazily by whoever
   * reads them next: `sweep`, `findRunning` or `stop`.
   */
  private async release(key: string, lock: LockFile): Promise<void> {
    await fs.rm(this.lockPath(key), { force: true });
    log.info(`released the lock for the devShell server on port ${lock.port}`);
  }

  /**
   * Drop every lock whose port is closed; runs at activation. An unreadable lock is left
   * alone, since it is no evidence that its server is gone.
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
   * Stop the server behind a key. The server was started detached and leads its own
   * process group, so signalling the group also reaches its extension hosts and terminals.
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

    // The socket closes before the process exits, so wait for both.
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
   * Build the devShell, provision it and start a server in it, in one `nix develop` that
   * runs `dist/provision.js`. The server is detached (see `startServer` there), so the
   * `nix develop` exits as soon as it is up.
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
    /** `dist/provision.js`, as shipped beside this bundle. */
    provisionScript: string;
    progress?: (m: string) => void;
    output?: BuildOutput;
  }): Promise<ServerHandle> {
    await fs.mkdir(opts.extensionsDir, { recursive: true });
    await fs.mkdir(opts.serverDataDir, { recursive: true });
    await fs.mkdir(path.dirname(this.lockPath(opts.key)), { recursive: true });

    // The server's own `node`: the devShell may have none, or a different version.
    const node = await serverNodePath(opts.launcher);

    const provision: ProvisionOptions = {
      launcher: opts.launcher,
      extensionsDir: opts.extensionsDir,
      serverDataDir: opts.serverDataDir,
      flakeDir: opts.flakeDir,
      lockFile: this.lockPath(opts.key),
      // Minted here: the resolve hands this token to VS Code.
      connectionToken: crypto.randomUUID(),
      commit: opts.commit,
      installable: opts.installable,
      connectTimeoutSeconds: this.connectTimeoutSeconds,
      installTimeoutSeconds: INSTALL_TIMEOUT_SECONDS,
    };

    // Otherwise a stale lock would be read back below as this run's.
    await fs.rm(provision.lockFile, { force: true });

    const { exe, args } = await developCommand(this.cfg, {
      installable: opts.installable,
      profile: opts.profile,
      command: [node, opts.provisionScript, JSON.stringify(provision)],
      logFormat: opts.output?.onOutput ? BUILD_LOG_FORMAT : undefined,
    });

    // Redact the token: logs get pasted into issues.
    log.info(
      `entering the devShell: ${exe} ${args.join(" ")}`.replace(
        provision.connectionToken,
        "<token>",
      ),
    );
    opts.progress?.("Building the devShell\u2026");

    // The terminal gets the raw stream; the notification gets it line by line.
    let carry = "";
    const toOutput = (chunk: string) => {
      opts.output?.onOutput?.(chunk);
      carry += chunk;
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        const text = plainText(line);
        if (text) opts.progress?.(text);
      }
    };

    // Throws on a non-zero exit. The script exits zero exactly when the lock file describes
    // a running server; the error is what `isEvaluationError` inspects.
    await run(exe, args, {
      cwd: opts.flakeDir,
      // Build plus server startup.
      timeoutMs:
        (Math.max(30, this.cfg.buildTimeoutSeconds) +
          this.connectTimeoutSeconds) *
        1000,
      onStderr: toOutput,
      // `shellHook` output belongs on screen too.
      onStdout: toOutput,
      tty: opts.output?.tty,
    });

    const lock = await this.readLock(opts.key);
    if (!lock) {
      throw new Error(
        "the devShell was entered and provisioning reported success, but left no server. " +
          "See the build output.",
      );
    }
    log.info(
      `devShell server listening on 127.0.0.1:${lock.port} (pid ${lock.pid})`,
    );
    return {
      port: lock.port,
      connectionToken: lock.connectionToken,
      pid: lock.pid,
    };
  }

  /** `nixDevShell.remote.connectTimeoutSeconds`, floored so it cannot be set to nothing. */
  private get connectTimeoutSeconds(): number {
    return Math.max(30, this.cfg.remote.connectTimeoutSeconds);
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

/** Stream a download to a file with the platform fetch; `curl` may not exist. */
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
