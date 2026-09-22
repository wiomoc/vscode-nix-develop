import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./log";
import type { LockFile, ProvisionOptions } from "./protocol";
import { installDeclaredExtensions } from "./extensions";
import { applyDeclaredSettings } from "./settings";

/**
 * Everything that has to happen *inside* the devShell, in one process.
 *
 * This is `dist/provision.js`, a second bundle run by the server's `node` as the
 * `--command` of a single `nix develop`. Before it existed the extension host entered the
 * shell twice: once with a shell script that dumped the environment into a temp file,
 * which the host parsed to find out what the flake declared, and once more to start the
 * server. Two evaluations, two `shellHook` runs, and a whole protocol for shipping an
 * environment across a process boundary -- to reach code that could simply have been
 * running in there.
 *
 * So it runs in there. `vscodeExtensions` and `vscodeSettings` are read from
 * `process.env`, because this process *is* the devShell.
 *
 * It tells the host one thing, in two parts: the lock file, and the exit code. Zero means
 * that file describes a server that is up. Everything else it has to say it says on
 * stderr, which is already on screen in the build terminal.
 *
 * What it must not do is stay. The server outlives the window that started it, and this
 * process holds the far end of the pty the host is painting that terminal with -- so the
 * server is started detached, in a session of its own, and this exits the moment the
 * server is up. Nothing of ours is left between the extension and the server, and the host
 * is free to let the terminal go.
 */
async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error("no options were given");
  const opts = JSON.parse(raw) as ProvisionOptions;

  // Neither of these is allowed to stop the server starting: a flake that declares an
  // extension that will not install, or a settings file that cannot be read, costs that
  // one thing and not the window.
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
 * Start the server, detached, and wait for it to say which port it is on.
 *
 * `detached` is doing real work here, on both ends. It makes the server a session leader,
 * which takes it off this process's controlling terminal -- the pty the extension host
 * lent Nix -- so closing that terminal cannot send it a SIGHUP. And it makes the server's
 * own pid a process group leader, which is the group `ServerManager.stop` signals; before
 * this the recorded pid belonged to `nix develop`, which had exec'd away by then.
 *
 * Its output comes back over ordinary pipes, and this process reads them only until the
 * server names its port. After that the read ends are dropped and the server goes on
 * writing into a pipe nobody holds. That is survivable for this particular child and not
 * in general: a bare Node process takes an uncaught `EPIPE` and dies, while the VS Code
 * server keeps running -- it was checked under load that makes it log, not assumed. What
 * makes it safe to rely on is that the server is not writing anything here that matters
 * anyway: its real logs go to `<serverDataDir>/data/logs/`, which it opens for itself.
 *
 * This is the arrangement the extension host used to have, minus its two costs. It held
 * those pipes for the whole session with an ever-growing buffer behind them, and the
 * server only ever lost them when the editor quit -- at the point where nothing was left
 * to notice what happened next.
 */
async function startServer(opts: ProvisionOptions): Promise<void> {
  const args = [
    "--start-server",
    // Servers outlive the window that started them so the next one attaches instantly,
    // but nothing notices when the *last* window goes away: VS Code never asks a server
    // to exit, and a devShell window cannot sensibly kill the server it is running on.
    // The server settles it itself. Five minutes after its last extension host
    // disconnects it exits; a host that reconnects inside that window cancels it, which
    // is what keeps reloads and reopens on the running server. The same timer starts at
    // boot, so a server we start and then fail to connect to is collected too.
    "--enable-remote-auto-shutdown",
    "--host",
    "127.0.0.1",
    // The server picks, and says so on the line `LISTENING` matches. Picking one out here
    // would mean holding a socket open to reserve it and letting go a moment before the
    // server binds, which is a race with nothing to gain: the server has to be read for
    // its readiness in any case.
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

  // Ours to let go of, and it has to be done explicitly: a pipe with a listener on it is a
  // handle that would keep this process alive, and staying alive is the one thing it must
  // not do.
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
 * Read the server's output until it names its port, and say what went wrong if it never
 * does.
 *
 * Everything it prints on the way goes straight out on stderr, which is the stream the
 * extension host is painting the build terminal with -- so a server that takes a while, or
 * complains, does it where someone can see. This is the only window in which its output
 * has anywhere to go, which is also why the failure messages carry the tail of it.
 *
 * Only a tail is kept. The line being matched can be split across two chunks, so some
 * overlap has to be held, but the whole of a server's startup output does not: keeping all
 * of it is what used to leave a buffer growing in the extension host for as long as the
 * server lived.
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
