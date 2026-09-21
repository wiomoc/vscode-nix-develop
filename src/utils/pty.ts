import { createRequire } from "node:module";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "./log";

/**
 * Just enough of `node-pty` to run one command under a terminal.
 *
 * Declared rather than imported: the module this describes is not a dependency of this
 * extension, it is the copy the editor already carries. See `loadPty`.
 */
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
 * The editor's own `node-pty`, or nothing.
 *
 * Nix decides whether to colour its output, and whether to draw its progress bar, by
 * calling `isatty` on its own stderr. Nothing overrides that -- there is no `--color`, no
 * config key, no environment variable -- so the only way to see a `nix develop` the way a
 * shell shows it is to give it a real terminal, and a pipe from `spawn` is not one.
 *
 * Allocating a pty needs a native module, and adding one to this extension would be a poor
 * trade: it would need a prebuild per Electron ABI, `vsce package --no-dependencies` would
 * not ship it, and it would break on editor versions whose ABI moved. VS Code has already
 * paid that cost -- every terminal in the editor is a `node-pty` -- and ships the module at
 * `<appRoot>/node_modules/node-pty`, so this borrows it instead.
 *
 * Two things keep that from being as fragile as it sounds. The binding is Node-API, so it
 * is ABI-stable rather than built against one V8; and nothing here depends on it, so an
 * editor that has moved or dropped it costs colour and nothing else. Everything is wrapped
 * accordingly: a failure to load is remembered, reported once, and answered with a pipe.
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
