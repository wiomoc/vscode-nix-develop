import { spawn } from "node:child_process";
import * as path from "node:path";

/**
 * Run a command to completion inside the devShell. `utils/run-subprocess` needs `vscode`,
 * which is not available here. Only an output tail is kept, for the error message.
 */
export function run(
  exe: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let tail = "";
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`),
      );
    }, opts.timeoutMs);

    const collect = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-2000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", (err) => finish(err));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              `${path.basename(exe)} exited with code ${code}: ${tail.trim()}`,
            ),
      ),
    );
  });
}
