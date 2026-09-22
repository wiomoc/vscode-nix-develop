import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./log";
import type { LockFile, ProvisionOptions } from "./protocol";
import { installDeclaredExtensions } from "./extensions";
import { applyDeclaredSettings } from "./settings";

/**
 * `dist/provision.js`: everything that happens inside the devShell, run by the server's
 * `node` as the `--command` of `nix develop`. Reads `vscodeExtensions` and
 * `vscodeSettings` from `process.env`.
 *
 * Its answer is the lock file plus the exit code (zero means the server is up); the rest
 * goes to stderr, which the build terminal shows. It starts the server detached and exits
 * as soon as it is up.
 */
async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error("no options were given");
  const opts = JSON.parse(raw) as ProvisionOptions;

  // Neither of these may stop the server from starting.
  await installDeclaredExtensions({
    launcher: opts.launcher,
    extensionsDir: opts.extensionsDir,
    serverDataDir: opts.serverDataDir,
    flakeDir: opts.flakeDir,
    devShellEnv: process.env,
    installTimeoutMs: opts.installTimeoutSeconds * 1000,
  }).catch((err) =>
    log.warn(`provisioning extensions failed: ${(err as Error).message}`),
  );

  await applyDeclaredSettings({
    serverDataDir: opts.serverDataDir,
    devShellEnv: process.env,
  });

  await startServer(opts);
}

/**
 * Start the server detached and wait for it to report its port.
 *
 * `detached` makes the server a session leader, so closing the build terminal's pty
 * cannot SIGHUP it, and a process group leader, which is what `ServerManager.stop`
 * signals.
 *
 * Its pipes are dropped once the port is known. The VS Code server survives writing to a
 * closed pipe, and its real logs go to `<serverDataDir>/data/logs/` anyway.
 */
async function startServer(opts: ProvisionOptions): Promise<void> {
  const args = [
    "--start-server",
    // Nothing else stops a server once its last window is gone: it exits five minutes
    // after its last extension host disconnects (or after boot, if none ever connects).
    "--enable-remote-auto-shutdown",
    "--host",
    "127.0.0.1",
    // The server picks the port and reports it on the line `LISTENING` matches.
    "--port",
    "0",
    "--connection-token",
    opts.connectionToken,
    "--accept-server-license-terms",
    "--telemetry-level",
    "off",
    "--server-data-dir",
    opts.serverDataDir,
    "--extensions-dir",
    opts.extensionsDir,
  ];
  log.info("starting the server");

  const child = spawn(opts.launcher, args, {
    cwd: opts.flakeDir,
    // Nothing of ours is added: this process *is* the devShell, so whatever it has is
    // what the window's terminals, tasks and debuggers will inherit.
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.unref();

  const started = await awaitListening(child, opts.connectTimeoutSeconds);

  // Open pipes would keep this process alive.
  child.stdout?.destroy();
  child.stderr?.destroy();

  if ("problem" in started) throw new Error(started.problem);

  const lock: LockFile = {
    port: started.port,
    connectionToken: opts.connectionToken,
    pid: child.pid ?? -1,
    installable: opts.installable,
    commit: opts.commit,
    startedAt: Date.now(),
  };
  await fsp.mkdir(path.dirname(opts.lockFile), { recursive: true });
  await fsp.writeFile(opts.lockFile, JSON.stringify(lock, null, 2));
  log.info(
    `the server is listening on 127.0.0.1:${started.port} (pid ${lock.pid})`,
  );
}

/** Printed by the server once the extension host agent is accepting connections. */
const LISTENING = /Extension host agent listening on (\d+)/;

/** How much of the server's output is kept -- enough to match across a split chunk. */
const WINDOW = 8192;

type Listening = { port: number } | { problem: string };

/**
 * Read the server's output until it names its port, forwarding it to stderr (the build
 * terminal). Only a tail is kept, for matching across chunks and for error messages.
 */
function awaitListening(
  child: ChildProcess,
  timeoutSeconds: number,
): Promise<Listening> {
  return new Promise((resolve) => {
    let seen = "";
    let settled = false;

    const finish = (result: Listening) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onChunk);
      child.stderr?.off("data", onChunk);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* it went away on its own */
      }
      finish({
        problem:
          `the server did not report a listening port within ${timeoutSeconds}s\n` +
          seen.trim(),
      });
    }, timeoutSeconds * 1000);

    const onChunk = (data: Buffer) => {
      const text = data.toString("utf8");
      try {
        fs.writeSync(2, text);
      } catch {
        /* the terminal is gone; the match below still matters */
      }
      seen = (seen + text).slice(-WINDOW);
      const match = LISTENING.exec(seen);
      if (match) finish({ port: Number(match[1]) });
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) =>
      finish({ problem: `the server could not be started: ${err.message}` }),
    );
    child.on("exit", (code, signal) =>
      finish({
        problem:
          `the server exited (${signal ?? `code ${code}`}) before reporting a listening port\n` +
          seen.trim(),
      }),
    );
  });
}

main().catch((err) => {
  log.warn((err as Error).message);
  // The stack goes straight out, unprefixed: it is for whoever is reading the terminal,
  // and a non-zero exit is what the extension host actually acts on.
  try {
    fs.writeSync(2, `${(err as Error).stack ?? ""}\n`);
  } catch {
    /* nothing left to write to */
  }
  process.exitCode = 1;
});
