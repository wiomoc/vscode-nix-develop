import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "./utils/log";
import type { NixDevelopConfig } from "./config";
import { run, SubprocessError } from "./utils/run-subprocess";

/** Flakes are still gated behind experimental features on many installs. */
const FEATURE_ARGS = ["--extra-experimental-features", "nix-command flakes"];

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
  /** The `nix` executable, from `nixDevelop.nixPath`. */
  exe: string;
  args: string[];
}

/**
 * How this extension invokes Nix.
 *
 * Every `nix` spawn is assembled here, so the rules that apply to all of them -- flakes are
 * gated behind experimental features, and `nixDevelop.impure` is the user's answer to
 * whether evaluation may reach outside the store -- are stated exactly once. Callers that
 * cannot use `run` (the server manager needs a detached child) still take their argv from
 * here rather than hand-rolling it.
 *
 * The subcommand is a separate argument because the two flags sit on opposite sides of it:
 * `--extra-experimental-features` is a top-level flag, while `--impure` belongs to the
 * subcommand and Nix refuses it with `unrecognised flag` if it appears any earlier.
 */
export function nixCommand(
  cfg: NixDevelopConfig,
  subcommand: string[],
  args: string[],
  opts: { impure?: boolean } = {},
): NixCommand {
  const impure = opts.impure ?? cfg.impure;
  return {
    exe: cfg.nixPath,
    args: [...FEATURE_ARGS, ...subcommand, ...(impure ? ["--impure"] : []), ...args],
  };
}

export interface DevelopOptions {
  /** A full flake installable, as produced by `toInstallable`. */
  installable: string;
  /**
   * Where Nix keeps the built shell.
   *
   * Required, deliberately. `--profile` is the only thing that makes a devShell a GC root:
   * without one, `nix store gc` is free to collect paths that a running server -- or the
   * next activation -- still depends on. It is also what makes re-entering the shell
   * near-instant. Making it part of the type means no caller can forget it.
   */
  profile: string;
  /** argv exec'd inside the shell, via `--command`. */
  command: string[];
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
  cfg: NixDevelopConfig,
  opts: DevelopOptions,
): Promise<NixCommand> {
  // Nix writes the profile symlinks itself, but will not create the directory holding them.
  await fs.mkdir(path.dirname(opts.profile), { recursive: true });
  return nixCommand(cfg, ["develop"], [
    opts.installable,
    "--profile",
    opts.profile,
    ...cfg.extraArgs,
    "--command",
    ...opts.command,
  ]);
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
  cfg: NixDevelopConfig,
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
  cfg: NixDevelopConfig,
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
  cfg: NixDevelopConfig,
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

/** Does this failure mean Nix refused to look at an untracked flake.nix? */
export function isUntrackedFlakeError(err: unknown): boolean {
  const text = `${(err as SubprocessError)?.stderr ?? ""}\n${(err as Error)?.message ?? ""}`;
  return /not tracked by Git|To make it visible to Nix|does not contain a ['"]?flake\.nix/i.test(text);
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

/**
 * Build the devShell and capture its environment.
 *
 * The env is written to a temp file rather than stdout because shell hooks routinely
 * print banners, and `nix develop` itself writes notices (e.g. SOURCE_DATE_EPOCH) that
 * would otherwise corrupt the payload.
 */
export async function captureEnv(
  cfg: NixDevelopConfig,
  installable: string,
  dir: string,
  profilePath: string,
  token?: vscode.CancellationToken,
  onProgress?: (line: string) => void,
): Promise<CaptureResult> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vscode-nix-develop-"));
  const insideFile = path.join(tmp, "inside.env");
  const baselineFile = path.join(tmp, "baseline.env");

  try {
    // Baseline: same dumper, same cwd, same inherited env, no devShell.
    await run("bash", ["-c", DUMP_SCRIPT, baselineFile], { cwd: dir, timeoutMs: 30_000, token });

    const { exe, args } = await developCommand(cfg, {
      installable,
      profile: profilePath,
      command: ["bash", "-c", DUMP_SCRIPT, insideFile],
    });

    let carry = "";
    await run(exe, args, {
      cwd: dir,
      timeoutMs: Math.max(30, cfg.buildTimeoutSeconds) * 1000,
      token,
      onStderr: (chunk) => {
        carry += chunk;
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (t) onProgress?.(t);
        }
      },
    });

    return {
      inside: parseDump(await fs.readFile(insideFile)),
      baseline: parseDump(await fs.readFile(baselineFile)),
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
