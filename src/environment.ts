import { log } from "./utils/log";
import type { CaptureResult } from "./nix";

const SEP = ":";

/**
 * Derivation plumbing that `mkShell` leaks into the environment. Exporting these into a
 * user's terminal is at best noise and at worst actively harmful -- `TMPDIR` points at a
 * scratch directory that no longer exists, and `name`/`out`/`phases` shadow variables
 * that build scripts legitimately use.
 */
const DERIVATION_INTERNALS = new Set([
  "__structuredAttrs",
  "__ignoreNulls",
  "allowSubstitutes",
  "args",
  "buildInputs",
  "buildPhase",
  "builder",
  "checkPhase",
  "configurePhase",
  "defaultBuildInputs",
  "depsBuildBuild",
  "depsBuildBuildPropagated",
  "depsBuildTarget",
  "depsBuildTargetPropagated",
  "depsHostHost",
  "depsHostHostPropagated",
  "depsTargetTarget",
  "depsTargetTargetPropagated",
  "distPhase",
  "doCheck",
  "doInstallCheck",
  "dontAddDisableDepTrack",
  "dontPatchELF",
  "fixupPhase",
  "initialPath",
  "installCheckPhase",
  "installPhase",
  "name",
  "nativeBuildInputs",
  "nobuildPhase",
  "out",
  "outputs",
  "patchPhase",
  "patches",
  "phases",
  "pname",
  "preferLocalBuild",
  "propagatedBuildInputs",
  "propagatedNativeBuildInputs",
  "shell",
  "shellHook",
  "stdenv",
  "strictDeps",
  "system",
  "unpackPhase",
  "version",
  "HOST_PATH",
  "NIX_BUILD_TOP",
  "NIX_GCROOT",
]);

/** Owned by the user's session or the terminal; the devShell must not dictate these. */
const SESSION_OWNED = new Set([
  "_",
  "COLORTERM",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LOGNAME",
  "OLDPWD",
  "PWD",
  "SHELL",
  "SHLVL",
  "TEMP",
  "TEMPDIR",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMP",
  "TMPDIR",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_ID",
  "GIT_ASKPASS",
  "CHROME_DESKTOP",
  "ORIGINAL_XDG_CURRENT_DESKTOP",
]);

const IGNORED_PREFIXES = ["VSCODE_", "ELECTRON_", "SSH_", "npm_", "NIX_BUILD_CORES_"];

export interface EnvDelta {
  /** Variables set to an absolute value. */
  replace: Map<string, string>;
  /** Search-path variables where only the devShell's leading segment is contributed. */
  prepend: Map<string, string>;
  /** Present in the baseline but gone inside the shell; cannot be unset in terminals. */
  removed: string[];
  /** Filtered out by the deny lists. */
  dropped: string[];
}

function isIgnored(name: string, extra: Set<string>): boolean {
  if (DERIVATION_INTERNALS.has(name) || SESSION_OWNED.has(name) || extra.has(name)) return true;
  return IGNORED_PREFIXES.some((p) => name.startsWith(p));
}

/** Variables that are `:`-separated search paths rather than plain values. */
const PATH_LIKE = [
  "PATH",
  "XDG_DATA_DIRS",
  "XDG_CONFIG_DIRS",
  "MANPATH",
  "INFOPATH",
  "PKG_CONFIG_PATH",
  "LD_LIBRARY_PATH",
  "CMAKE_PREFIX_PATH",
];

export interface DeltaOptions {
  ignoredVariables?: string[];
  pathLikeVariables?: string[];
}

/**
 * Reduce the captured environments to the minimal set of changes the devShell makes.
 *
 * Search-path variables are special-cased: `nix develop` appends the host value, so the
 * devShell's contribution is a strict prefix. Prepending that prefix (instead of replacing
 * the whole variable) keeps entries the user's own shell profile adds later.
 */
export function computeDelta(capture: CaptureResult, opts: DeltaOptions = {}): EnvDelta {
  const extra = new Set(opts.ignoredVariables ?? []);
  const pathLike = new Set(opts.pathLikeVariables ?? PATH_LIKE);
  const delta: EnvDelta = { replace: new Map(), prepend: new Map(), removed: [], dropped: [] };

  for (const [name, value] of Object.entries(capture.inside)) {
    if (isIgnored(name, extra)) {
      delta.dropped.push(name);
      continue;
    }
    const before = capture.baseline[name];
    if (before === value) continue;

    if (pathLike.has(name) && before !== undefined && before !== "") {
      if (value === before) continue;
      if (value.endsWith(SEP + before)) {
        const prefix = value.slice(0, value.length - before.length - SEP.length);
        if (prefix) delta.prepend.set(name, prefix);
        continue;
      }
      // The devShell rewrote the variable rather than extending it; take it verbatim.
      log.debug(`${name} is not an extension of the host value; replacing outright`);
    }
    delta.replace.set(name, value);
  }

  for (const name of Object.keys(capture.baseline)) {
    if (!(name in capture.inside) && !isIgnored(name, extra)) delta.removed.push(name);
  }
  return delta;
}

function describeDelta(delta: EnvDelta): string {
  return `${delta.replace.size} set, ${delta.prepend.size} prepended, ${delta.dropped.length} filtered`;
}

/** Human-readable dump for the "Show resolved environment" command. */
export function renderDelta(delta: EnvDelta, label: string): string {
  const lines: string[] = [
    `# Nix devShell environment`,
    `# devShell : ${label}`,
    `# summary  : ${describeDelta(delta)}`,
    "",
  ];
  if (delta.prepend.size > 0) {
    lines.push("# ---- prepended search paths ----");
    for (const [name, prefix] of [...delta.prepend].sort()) {
      lines.push(`${name}="${prefix}:$${name}"`);
      for (const part of prefix.split(SEP)) lines.push(`#   ${part}`);
      lines.push("");
    }
  }
  if (delta.replace.size > 0) {
    lines.push("# ---- exported variables ----");
    for (const [name, value] of [...delta.replace].sort()) lines.push(`${name}=${JSON.stringify(value)}`);
    lines.push("");
  }
  if (delta.dropped.length > 0) {
    lines.push("# ---- filtered out (stdenv internals / session-owned) ----");
    lines.push(`# ${[...delta.dropped].sort().join(" ")}`);
  }
  return lines.join("\n");
}
