import { createRequire } from "node:module";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "./log";

/** The subset of `node-pty` used here; declared, since the module is the editor's. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): PtyProcess;
}

let cached: PtyModule | null | undefined;

/**
 * The editor's own `node-pty` (`<appRoot>/node_modules/node-pty`), or nothing.
 *
 * Nix only draws colours and its progress bar when stderr is a tty. Borrowing the
 * editor's module avoids shipping a native prebuild per Electron ABI; its binding is
 * Node-API, so it is ABI-stable. Without it, output falls back to a pipe.
 */
export function loadPty(): PtyModule | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = null;

  const appRoot = vscode.env.appRoot;
  if (!appRoot) return undefined;

  const entry = path.join(appRoot, "node_modules", "node-pty");
  try {
    // An absolute path, so this resolves to the editor's copy without consulting this
    // extension's own module paths -- where there is deliberately no `node-pty` to find.
    const loaded = createRequire(__filename)(entry) as Partial<PtyModule>;
    if (typeof loaded?.spawn !== "function") {
      log.info(`${entry} is not a usable node-pty; running Nix without a terminal`);
      return undefined;
    }
    cached = loaded as PtyModule;
    log.debug(`using the editor's node-pty from ${entry}`);
    return cached;
  } catch (err) {
    log.info(
      `the editor does not lend a node-pty (${(err as Error).message}); ` +
        `running Nix without a terminal, so it will print no colour`,
    );
    return undefined;
  }
}

/** Forget the memo, so a test can exercise both paths. */
export function forgetPty(): void {
  cached = undefined;
}
