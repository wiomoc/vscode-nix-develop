import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { log } from "./log";
import { loadPty, type PtyModule, type PtyProcess } from "./pty";
import path from "node:path";


export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Extra variables layered on top of the inherited environment. */
  env?: Record<string, string>;
  token?: vscode.CancellationToken;
  /** Streamed stderr, for surfacing build progress. */
  onStderr?: (chunk: string) => void;
  /**
   * Streamed stdout.
   *
   * Nix writes its own logs to stderr and keeps stdout for the payload, so this is not
   * where build progress arrives -- it is where a devShell's `shellHook` banner does.
   * Only safe to stream when the caller is not using stdout as data; `captureEnv` routes
   * the environment through a file precisely so that it is not.
   */
  onStdout?: (chunk: string) => void;
  /**
   * Run under a real terminal, when the editor lends one; see `loadPty`.
   *
   * A pty has one stream, not two, so this changes the shape of what comes back: every
   * byte arrives on `onStderr` and lands in `RunResult.stderr`, and `stdout` is empty.
   * That suits a caller that is showing the output and reading its result from elsewhere;
   * it is wrong for one that parses stdout, which is why this is opt-in.
   */
  tty?: TtyOptions;
}

export interface TtyOptions {
  /** The size to tell the child about. A terminal nobody has rendered yet has no size. */
  columns?: number;
  rows?: number;
  /** Resizes of the terminal showing this, so the child can reflow to match. */
  onResize?: vscode.Event<{ columns: number; rows: number }>;
}

export class SubprocessError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) {
    super(message);
    this.name = "SubprocessError";
  }
}

/** A terminal that has never been rendered still has to tell the child something. */
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 30;

export function run(exe: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const pty = opts.tty ? loadPty() : undefined;
  // No pty to borrow is not a failure: the command runs, it just says less about itself.
  if (opts.tty && pty) return runInPty(pty, exe, args, opts, opts.tty);
  return runInPipe(exe, args, opts);
}

/**
 * Run under a terminal, so the child believes it is talking to one.
 *
 * What this buys is entirely the child's opinion of itself: Nix draws its progress bar and
 * colours its output here and does neither over a pipe. What it costs is the split between
 * stdout and stderr, which a pty does not have -- one terminal, one stream.
 */
function runInPty(
  pty: PtyModule,
  exe: string,
  args: string[],
  opts: RunOptions,
  tty: TtyOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    log.debug(`exec (tty): ${exe} ${args.join(" ")}  (cwd=${opts.cwd})`);

    let child: PtyProcess;
    try {
      child = pty.spawn(exe, args, {
        // Sets TERM, which is what tells Nix how much it may draw.
        name: "xterm-256color",
        cols: tty.columns ?? DEFAULT_COLUMNS,
        rows: tty.rows ?? DEFAULT_ROWS,
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
      });
    } catch (err) {
      // Unlike `spawn`, node-pty reports a missing executable by throwing here. The message
      // it throws is not one to show a user, so it gets the same treatment as ENOENT.
      reject(
        new SubprocessError(
          `Could not run '${exe}'. Is Nix installed and on PATH?`,
          (err as Error).message,
          null,
        ),
      );
      return;
    }

    let output = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancel?.dispose();
      resize?.dispose();
      data.dispose();
      exit.dispose();
      fn();
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(
          new SubprocessError(
            `Timed out after ${Math.round(opts.timeoutMs / 1000)}s`,
            output,
            null,
          ),
        ),
      );
    }, opts.timeoutMs);

    const cancel = opts.token?.onCancellationRequested(() => {
      child.kill();
      finish(() => reject(new vscode.CancellationError()));
    });

    const resize = tty.onResize?.((d) => {
      // Nix reflows its bar to the width it is told about, so a resized terminal that was
      // never mentioned keeps drawing at the old width.
      if (!settled) child.resize(d.columns, d.rows);
    });

    const data = child.onData((chunk) => {
      output += chunk;
      opts.onStderr?.(chunk);
    });

    // node-pty holds this back until the pty's socket has drained, so what arrives here is
    // the whole of the output and not merely what had been read by the time of _exit_.
    const exit = child.onExit(({ exitCode }) =>
      finish(() => {
        if (exitCode === 0) resolve({ stdout: "", stderr: output });
        else
          reject(
            new SubprocessError(
              `${path.basename(exe)} exited with code ${exitCode}`,
              output,
              exitCode,
            ),
          );
      }),
    );
  });
}

function runInPipe(exe: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    log.debug(`exec: ${exe} ${args.join(" ")}  (cwd=${opts.cwd})`);
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      // Never attach a tty: nix would emit progress bars into stdout.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub?.dispose();
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => reject(new SubprocessError(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s`, stderr, null)));
    }, opts.timeoutMs);

    const sub = opts.token?.onCancellationRequested(() => {
      child.kill("SIGTERM");
      finish(() => reject(new vscode.CancellationError()));
    });

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      opts.onStderr?.(s);
    });

    child.on("error", (err) =>
      finish(() =>
        reject(
          new SubprocessError(
            (err as NodeJS.ErrnoException).code === "ENOENT"
              ? `Could not run '${exe}'. Is Nix installed and on PATH?`
              : err.message,
            stderr,
            null,
          ),
        ),
      ),
    );

    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new SubprocessError(`${path.basename(exe)} exited with code ${code}`, stderr, code));
      });
    });
  });
}
