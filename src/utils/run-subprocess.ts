import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { log } from "./log";
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
}

export class SubprocessError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) {
    super(message);
    this.name = "SubprocessError";
  }
}

export function run(exe: string, args: string[], opts: RunOptions): Promise<RunResult> {
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

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
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
