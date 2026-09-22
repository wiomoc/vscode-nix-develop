import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "./utils/log";
import type { NixDevShellConfig } from "./config";
import { run, SubprocessError, type TtyOptions } from "./utils/run-subprocess";

/** Flakes are still gated behind experimental features on many installs. */
const FEATURE_ARGS = ["--extra-experimental-features", "nix-command flakes"];

/**
 * What Nix is asked for when something is rendering its output rather than parsing it.
 *
 * `bar-with-logs` is two things: the progress bar, and every line the builders print -- the
 * half `-L` turns on. The second half arrives whatever the child is writing to. The first
 * is Nix's own decision, taken by calling `isatty` on its stderr and overridden by nothing:
 * there is no `--color`, no config key, no environment variable. So the bar appears only on
 * the `CaptureOptions.tty` path, where `loadPty` has borrowed the editor's pty; over a pipe
 * the same flag still turns the output from the few lines Nix prints by default into the
 * whole build log, which is the half that says why an evaluation failed.
 *
 * This is asked for by the environment capture alone. The server start runs `nix develop`
 * too, but its output is parsed for a listening port, and a progress bar redrawing into
 * that stream could interleave with the line being matched.
 */
export const BUILD_LOG_FORMAT = "bar-with-logs";

/**
 * Dumps every exported variable NUL-delimited into the file named by $0.
 *
 * NUL delimiting is what keeps values containing newlines or `=` intact.
 *
 * `env -0` is the fast path. The fallback exists because `nix develop` puts nixpkgs'
 * *minimal* bash on PATH, which is built without programmable completion -- so `compgen`
 * is unavailable -- and a devShell is free to leave coreutils off PATH entirely. Only the
 * variable *names* are parsed out of `export -p`; each value is read back with indirect
 * expansion, so multi-line values survive the round trip.
 */
const DUMP_SCRIPT = [
  'if env -0 >/dev/null 2>&1; then',
  '  env -0 > "$0"',
  'else',
  '  export -p | while IFS= read -r line; do',
  '    case "$line" in',
  '      "declare -x "*) line="${line#declare -x }" ;;',
  '      "export "*) line="${line#export }" ;;',
  '      *) continue ;;',
  '    esac',
  '    name="${line%%=*}"',
  '    case "$name" in *[!A-Za-z0-9_]*) continue ;; esac',
  '    printf "%s=%s\\0" "$name" "${!name}"',
  '  done > "$0"',
  'fi',
].join("\n");




export interface NixCommand {
  /** The `nix` executable, from `nixDevShell.nixPath`. */
  exe: string;
  args: string[];
}

/**
 * How this extension invokes Nix.
 *
 * Every `nix` spawn is assembled here, so the rules that apply to all of them -- flakes are
 * gated behind experimental features, and `nixDevShell.impure` is the user's answer to
 * whether evaluation may reach outside the store -- are stated exactly once. Callers that
 * cannot use `run` (the server manager needs a detached child) still take their argv from
 * here rather than hand-rolling it.
 *
 * The subcommand is a separate argument because the two flags sit on opposite sides of it:
 * `--extra-experimental-features` is a top-level flag, while `--impure` belongs to the
 * subcommand and Nix refuses it with `unrecognised flag` if it appears any earlier.
 * `--log-format` is top-level too, so it joins the features rather than the arguments.
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
   * Where Nix keeps the built shell, or `undefined` for no GC root at all.
   *
   * `--profile` is the only thing that makes a devShell a GC root: without one, `nix store
   * gc` is free to collect paths that a running server -- or the next activation -- still
   * depends on. Nix's GC does scan `/proc` for store paths a live process references, so a
   * running server is not defenceless, but that covers neither the gap between building the
   * shell and starting the server nor a GC whose scan happened before the server appeared.
   *
   * Whether to keep one is the user's call (`nixDevShell.profile`), so this is nullable --
   * but not optional. Making it part of the type means a caller has to say which it wants
   * rather than silently omitting the root; `ensureProfile` in `profile.ts` is what
   * answers the question.
   */
  profile: string | undefined;
  /** argv exec'd inside the shell, via `--command`. */
  command: string[];
  /**
   * `--log-format`, for a caller that is rendering Nix's output rather than parsing it.
   * See `BUILD_LOG_FORMAT`; omitted, Nix decides, which over a pipe means terse lines.
   */
  logFormat?: string;
}

/**
 * The one way into a devShell.
 *
 * Its two callers need the same invocation but run it differently -- capturing the
 * environment waits for a short-lived child, launching the server needs a detached one that
 * outlives the window -- so this yields the argv instead of running it. What it does not
 * yield is a choice: the feature flags, `impure`, `extraArgs` and the profile are settled
 * here, and `nix develop` is spelled out in exactly this one place.
 */
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

/**
 * The Nix system double for this machine, e.g. `x86_64-linux`.
 *
 * Spawning Nix for a value that never changes is pure latency on the path to showing the
 * devShell picker, so the answer is memoised for the life of the extension host. Callers
 * that need it across windows should persist it themselves.
 */
let systemDouble: string | undefined;

export async function currentSystem(
  cfg: NixDevShellConfig,
  cwd: string,
  token?: vscode.CancellationToken,
): Promise<string> {
  if (systemDouble) return systemDouble;
  // `builtins.currentSystem` is impure by definition, so this one does not ask the config.
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
 * Enumerate `devShells.<system>`.
 *
 * Preferred path is a targeted `nix eval ... --apply builtins.attrNames`, which only
 * forces the attribute names. `nix flake show` is the fallback: it is richer (it gives
 * derivation names) but evaluates far more of the flake and fails on outputs that
 * cannot be evaluated on this system.
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
 * How to address a local flake directory.
 *
 * A *bare* path lets Nix notice the directory is in a Git work tree and use the Git
 * source, which contains only tracked files. A `path:` ref instead hashes and copies the
 * whole directory -- `node_modules`, `target/`, build outputs and all -- on every single
 * evaluation. On a 12 GB checkout with 800 tracked files that is the difference between
 * 0.07s and not finishing at all, so `path:` is a fallback, never the default.
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
 * Everything a failure said -- its output and its message -- flattened to a single line.
 *
 * Nix's output arrives here in two shapes: clean lines when it ran over a pipe, and a
 * coloured, redrawn, terminal-wrapped stream when it was handed a pty. Stripping the escape
 * codes and collapsing every run of whitespace lets one pattern read either. What it cannot
 * undo is a *soft* wrap, which splits a word rather than separating two, so the patterns
 * below stay short enough to have somewhere to match.
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
 * A failure of the *build*, or of the network it needed. Tested first, because the log a
 * builder failed with is arbitrary text: a compiler saying `syntax error` is a build that
 * may well go differently once the source is fixed, not a flake that cannot be evaluated.
 */
const BUILD_FAILED =
  /builder for .{0,120}? failed|build of .{0,120}? failed|failed to build|hash mismatch|unable to download|unable to fetch|Connection (refused|timed out|reset)|curl error|SSL|Timed out after/i;

/**
 * Nix's vocabulary for giving up before anything was built: the flake does not parse, does
 * not have the attribute, or is not there at all.
 */
const EVALUATION_FAILED =
  /syntax error|undefined variable|infinite recursion|attribute '[^']*' missing|does not provide attribute|is not a flake|does not contain a ['"]?flake\.nix|could not find a flake\.nix|cannot find flake|not tracked by Git|called without required argument|while evaluating|cannot coerce/i;

/**
 * Does this failure mean Nix could not *evaluate* the flake?
 *
 * The distinction is what a second attempt is worth. A download that failed, a builder that
 * ran out of memory, a store daemon that was not listening -- those are worth retrying, and
 * are what `TemporarilyNotAvailable` exists for. A flake with a typo in it evaluates exactly
 * the same way next time, so a retry is a loop: the same build refuses to start, the same
 * error scrolls past, and nothing moves until the user edits the file. Such a failure is
 * reported as final so the user gets to read it.
 */
export function isEvaluationError(err: unknown): boolean {
  const text = failureText(err);
  if (BUILD_FAILED.test(text)) return false;
  return EVALUATION_FAILED.test(text);
}

/**
 * What Nix actually complained about, for somewhere that shows one line rather than a log.
 *
 * Everything from the first `error:` onwards: that is the trace *and* the cause beneath it,
 * and a caller showing this has no terminal to scroll, so the trace is worth the characters.
 */
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

export interface CaptureResult {
  /** Exported variables as seen inside `nix develop`. */
  inside: Record<string, string>;
  /** Exported variables of the same bash invocation without the devShell. */
  baseline: Record<string, string>;
}

/** A CSI escape sequence, which is all Nix emits: colour, and the cursor moves of its bar. */
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * One line of Nix output as plain text, for somewhere that cannot render a terminal.
 *
 * Asking Nix for its progress bar means the same stream now carries escape codes and
 * in-place redraws. A progress notification would print those literally, so they are
 * stripped -- and since a redrawn line is several frames separated by carriage returns,
 * only the last frame is kept: that is what the line currently says.
 */
function plainText(line: string): string {
  const latest = line.split("\r").pop() ?? "";
  return latest.replace(ANSI_CSI, "").trim();
}

function parseDump(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of buf.toString("utf8").split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

export interface CaptureOptions {
  token?: vscode.CancellationToken;
  /** One trimmed line at a time, for a one-line progress notification. */
  onProgress?: (line: string) => void;
  /**
   * Nix's output verbatim -- escape codes, carriage returns and all -- for something that
   * can render it. Supplying this also changes what Nix is asked to print: see
   * `BUILD_LOG_FORMAT`. `onProgress` still fires, so both can be attached at once.
   */
  onOutput?: (chunk: string) => void;
  /**
   * The terminal `onOutput` is feeding, so Nix can be given one of its own to write to.
   *
   * Without this the build still streams, in the plain-text form Nix falls back to over a
   * pipe. With it Nix sees a tty and draws what it would draw in a shell. Only `onStderr`
   * fires then -- a pty has one stream -- which is why `onProgress` keeps working and the
   * separate stdout sink below is for the pipe path alone.
   */
  tty?: TtyOptions;
}

/**
 * Build the devShell and capture its environment.
 *
 * This is the call that does the heavy lifting on the way into a window: the shell is
 * built here, and the server start that follows re-enters one Nix has already cached. So
 * this is also where downloads, compiles and evaluation failures happen, and `onOutput` is
 * how a user gets to watch them.
 *
 * The env is written to a temp file rather than stdout because shell hooks routinely
 * print banners, and `nix develop` itself writes notices (e.g. SOURCE_DATE_EPOCH) that
 * would otherwise corrupt the payload. That is what makes streaming stdout safe here.
 */
export async function captureEnv(
  cfg: NixDevShellConfig,
  installable: string,
  dir: string,
  profilePath: string | undefined,
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  const { token, onProgress, onOutput, tty } = opts;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-nix-devshell-"));
  const insideFile = path.join(tmp, "inside.env");
  const baselineFile = path.join(tmp, "baseline.env");

  try {
    // Baseline: same dumper, same cwd, same inherited env, no devShell.
    await run("bash", ["-c", DUMP_SCRIPT, baselineFile], { cwd: dir, timeoutMs: 30_000, token });

    const { exe, args } = await developCommand(cfg, {
      installable,
      profile: profilePath,
      command: ["bash", "-c", DUMP_SCRIPT, insideFile],
      logFormat: onOutput ? BUILD_LOG_FORMAT : undefined,
    });

    let carry = "";
    await run(exe, args, {
      cwd: dir,
      timeoutMs: Math.max(30, cfg.buildTimeoutSeconds) * 1000,
      token,
      onStderr: (chunk) => {
        onOutput?.(chunk);
        // The notification wants whole lines; the terminal wants the bytes as they came,
        // so the two sinks see the same stream at different granularities.
        carry += chunk;
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          const t = plainText(line);
          if (t) onProgress?.(t);
        }
      },
      // A `shellHook` banner is the devShell talking to the user; it belongs on screen.
      onStdout: onOutput,
      tty,
    });

    return {
      inside: parseDump(await fs.readFile(insideFile)),
      baseline: parseDump(await fs.readFile(baselineFile)),
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
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
 * Every position Nix named, in the order it printed them.
 *
 * A failure is rarely one position: Nix prints a trace, outermost frame first, and the
 * innermost one -- the last -- is the expression that actually went wrong. But the
 * innermost frame is often inside a dependency in the store, or inside nixpkgs, which is
 * no use to someone who wants to fix their own flake. So the order is preserved rather
 * than resolved here, and the caller walks it from the innermost outwards until it finds a
 * position it can put an editor on.
 */
export function nixErrorLocations(err: unknown): NixErrorLocation[] {
  const text = failureText(err);
  const out: NixErrorLocation[] = [];
  for (const m of text.matchAll(ERROR_LOCATION)) {
    out.push({ file: m[1], line: Number(m[2]), column: Number(m[3]) });
  }
  return out;
}
