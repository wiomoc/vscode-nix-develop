import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "./utils/log";
import type { NixDevShellConfig } from "./config";
import { run, SubprocessError } from "./utils/run-subprocess";

/** Flakes are still gated behind experimental features on many installs. */
const FEATURE_ARGS = ["--extra-experimental-features", "nix-command flakes"];

/**
 * `--log-format` for output that is rendered rather than parsed: the full build log
 * (like `-L`), plus the progress bar when Nix's stderr is a tty. Nix decides the bar via
 * `isatty` alone, so it only appears on the `CaptureOptions.tty` path.
 */
export const BUILD_LOG_FORMAT = "bar-with-logs";

export interface NixCommand {
  /** The `nix` executable, from `nixDevShell.nixPath`. */
  exe: string;
  args: string[];
}

/**
 * Every `nix` invocation. The subcommand is separate because `--impure` must follow it,
 * while `--extra-experimental-features` and `--log-format` must precede it.
 */
export function nixCommand(
  cfg: NixDevShellConfig,
  subcommand: string[],
  args: string[],
  opts: { impure?: boolean; logFormat?: string } = {},
): NixCommand {
  const impure = opts.impure ?? cfg.impure;
  return {
    exe: cfg.nixPath,
    args: [
      ...FEATURE_ARGS,
      ...(opts.logFormat ? ["--log-format", opts.logFormat] : []),
      ...subcommand,
      ...(impure ? ["--impure"] : []),
      ...args,
    ],
  };
}

export interface DevelopOptions {
  /** A full flake installable, as produced by `toInstallable`. */
  installable: string;
  /**
   * `--profile` path, the devShell's GC root; `undefined` for none. Required rather than
   * optional so callers must decide (see `ensureProfile`).
   */
  profile: string | undefined;
  /** argv exec'd inside the shell, via `--command`. */
  command: string[];
  /** `--log-format`; see `BUILD_LOG_FORMAT`. */
  logFormat?: string;
}

/** The one way into a devShell. */
export async function developCommand(
  cfg: NixDevShellConfig,
  opts: DevelopOptions,
): Promise<NixCommand> {
  // Nix writes the profile symlinks itself, but will not create the directory holding them.
  if (opts.profile) await fs.mkdir(path.dirname(opts.profile), { recursive: true });
  return nixCommand(
    cfg,
    ["develop"],
    [
      opts.installable,
      ...(opts.profile ? ["--profile", opts.profile] : []),
      ...cfg.extraArgs,
      "--command",
      ...opts.command,
    ],
    { logFormat: opts.logFormat },
  );
}

/** The Nix system double for this machine, e.g. `x86_64-linux`. Memoised. */
let systemDouble: string | undefined;

export async function currentSystem(
  cfg: NixDevShellConfig,
  cwd: string,
  token?: vscode.CancellationToken,
): Promise<string> {
  if (systemDouble) return systemDouble;
  // `builtins.currentSystem` requires `--impure`.
  const { exe, args } = nixCommand(cfg, ["eval"], ["--raw", "--expr", "builtins.currentSystem"], {
    impure: true,
  });
  const { stdout } = await run(exe, args, { cwd, timeoutMs: 60_000, token });
  systemDouble = stdout.trim();
  return systemDouble;
}

/** Seed the memo from a persisted value, so the first picker open costs nothing. */
export function primeCurrentSystem(value: string | undefined): void {
  if (value && /^[a-z0-9_]+-[a-z0-9]+$/.test(value)) systemDouble = value;
}

export interface DevShell {
  /** Attribute name under `devShells.<system>`, e.g. `default`. */
  name: string;
  /** Derivation name, e.g. `my-project-shell-env`. */
  derivationName?: string;
  description?: string;
}

/**
 * Enumerate `devShells.<system>` via `nix eval --apply builtins.attrNames`, falling back
 * to the slower `nix flake show`.
 */
export async function listDevShells(
  cfg: NixDevShellConfig,
  dir: string,
  system: string,
  token?: vscode.CancellationToken,
): Promise<DevShell[]> {
  try {
    const names = await withFlakeRef(dir, async (ref) => {
      const { exe, args } = nixCommand(cfg, ["eval"], [
        "--json",
        `${ref}#devShells.${system}`,
        "--apply",
        "builtins.attrNames",
      ]);
      const { stdout } = await run(exe, args, { cwd: dir, timeoutMs: 300_000, token });
      return JSON.parse(stdout) as string[];
    });
    if (names.length > 0) return names.map((name) => ({ name }));
  } catch (err) {
    if (err instanceof vscode.CancellationError) throw err;
    log.warn(`nix eval of devShells failed, falling back to 'nix flake show': ${(err as Error).message}`);
  }
  return listViaFlakeShow(cfg, dir, system, token);
}

interface FlakeShowNode {
  type?: string;
  name?: string;
  description?: string;
}

async function listViaFlakeShow(
  cfg: NixDevShellConfig,
  dir: string,
  system: string,
  token?: vscode.CancellationToken,
): Promise<DevShell[]> {
  const { stdout } = await withFlakeRef(dir, async (ref) => {
    const { exe, args } = nixCommand(cfg, ["flake", "show"], ["--json", "--all-systems", ref]);
    return run(exe, args, { cwd: dir, timeoutMs: 600_000, token });
  });
  const tree = JSON.parse(stdout) as Record<string, Record<string, Record<string, FlakeShowNode>>>;
  const shells = tree?.devShells?.[system] ?? {};
  return Object.entries(shells).map(([name, node]) => ({
    name,
    derivationName: node?.name,
    description: node?.description || undefined,
  }));
}

/**
 * Directories that must be addressed as `path:<dir>` because their flake.nix is not
 * tracked by Git. Discovered on first failure and remembered for the session.
 */
const pathRefDirs = new Set<string>();

/**
 * How to address a local flake directory. A bare path uses the Git source (tracked files
 * only); `path:` copies the whole directory on every evaluation, so it is only a fallback.
 */
export function flakeRefFor(dir: string): string {
  return pathRefDirs.has(dir) ? `path:${dir}` : dir;
}

export function markPathRefRequired(dir: string): void {
  if (pathRefDirs.has(dir)) return;
  pathRefDirs.add(dir);
  log.warn(
    `${dir}: flake.nix is not tracked by Git, so Nix cannot use the Git source. ` +
      `Falling back to 'path:', which copies the entire directory on every evaluation. ` +
      `Run 'git -C ${dir} add flake.nix flake.lock' to make this fast.`,
  );
}

/**
 * A failure's output and message as one line, escape codes stripped and whitespace
 * collapsed, so the same patterns match pipe and pty output. Soft wraps can still split
 * words, so keep patterns short.
 */
function failureText(err: unknown): string {
  const raw = `${(err as SubprocessError)?.stderr ?? ""}\n${(err as Error)?.message ?? ""}`;
  return raw.replace(ANSI_CSI, " ").replace(/\s+/g, " ");
}

/** Does this failure mean Nix refused to look at an untracked flake.nix? */
export function isUntrackedFlakeError(err: unknown): boolean {
  return /not tracked by Git|To make it visible to Nix|does not contain a ['"]?flake\.nix/i.test(
    failureText(err),
  );
}

/**
 * A build or network failure. Tested first: a builder's log is arbitrary text and may
 * match `EVALUATION_FAILED` too.
 */
const BUILD_FAILED =
  /builder for .{0,120}? failed|build of .{0,120}? failed|failed to build|hash mismatch|unable to download|unable to fetch|Connection (refused|timed out|reset)|curl error|SSL|Timed out after/i;

/** Nix giving up before building: the flake does not parse, lacks the attribute, or is missing. */
const EVALUATION_FAILED =
  /syntax error|undefined variable|infinite recursion|attribute '[^']*' missing|does not provide attribute|is not a flake|does not contain a ['"]?flake\.nix|could not find a flake\.nix|cannot find flake|not tracked by Git|called without required argument|while evaluating|cannot coerce/i;

/**
 * Does this failure mean Nix could not evaluate the flake? Such a failure is final:
 * retrying it just loops until the user edits the file.
 */
export function isEvaluationError(err: unknown): boolean {
  const text = failureText(err);
  if (BUILD_FAILED.test(text)) return false;
  return EVALUATION_FAILED.test(text);
}

/** Everything from the first `error:` onwards, for a one-line display. */
export function nixErrorSummary(err: unknown): string | undefined {
  const text = failureText(err);
  const at = text.search(/error:/i);
  if (at < 0) return undefined;
  return text.slice(at, at + 600).trim();
}

/** Run `fn` with the preferred ref, retrying once as `path:` if Git refuses the flake. */
async function withFlakeRef<T>(dir: string, fn: (ref: string) => Promise<T>): Promise<T> {
  try {
    return await fn(flakeRefFor(dir));
  } catch (err) {
    if (err instanceof vscode.CancellationError) throw err;
    if (pathRefDirs.has(dir) || !isUntrackedFlakeError(err)) throw err;
    markPathRefRequired(dir);
    return fn(flakeRefFor(dir));
  }
}

/**
 * Turn a user-supplied selection into a full flake installable.
 * A bare attribute name is resolved under `devShells.<system>`; anything containing
 * `#` or `:` is assumed to already be a complete installable.
 */
export function toInstallable(selection: string, dir: string, system: string): string {
  const s = selection.trim();
  if (s.includes("#")) return s;
  const name = s || "default";
  return `${flakeRefFor(dir)}#devShells.${system}.${name}`;
}

/** A CSI escape sequence, which is all Nix emits: colour, and the cursor moves of its bar. */
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * One line of Nix output as plain text: escape codes stripped, and only the last
 * `\r`-separated frame of a redrawn line kept.
 */
export function plainText(line: string): string {
  const latest = line.split("\r").pop() ?? "";
  return latest.replace(ANSI_CSI, "").trim();
}

/** A `file:line:column` Nix named while failing. */
export interface NixErrorLocation {
  /** Absolute, as Nix printed it: the checkout, or the store copy of it. */
  file: string;
  /** 1-based, as Nix counts. */
  line: number;
  column: number;
}

/** `at /w/proj/flake.nix:12:1`, the only shape Nix gives a position in. */
const ERROR_LOCATION = /\bat ((?:[A-Za-z]:)?[^\s:]*\.nix):(\d+):(\d+)/g;

/**
 * Every position Nix named, outermost frame first. The innermost is often inside the
 * store, so the caller walks back to one it can open.
 */
export function nixErrorLocations(err: unknown): NixErrorLocation[] {
  const text = failureText(err);
  const out: NixErrorLocation[] = [];
  for (const m of text.matchAll(ERROR_LOCATION)) {
    out.push({ file: m[1], line: Number(m[2]), column: Number(m[3]) });
  }
  return out;
}
