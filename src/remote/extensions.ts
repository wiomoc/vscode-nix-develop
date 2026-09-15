import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { NixDevelopConfig } from "../config";
import { log } from "../utils/log";
import { exists, isDirectory } from "../utils/fs-stat";
import { run } from "../utils/run-subprocess";

/**
 * Per-devShell extension sets.
 *
 * A remote window loads `workspace`-kind extensions from the *server's* `--extensions-dir`,
 * not from the local install. Pointing that directory at a per-devShell path is therefore
 * all it takes to scope a set of extensions to one devShell: two devShells in the same repo
 * get genuinely separate extension sets, and neither disturbs the local window.
 *
 * Which extensions belong to a devShell can come from two places:
 *
 *  1. `nixDevelop.remote.extensions` in workspace settings -- the `devcontainer.json`
 *     equivalent, good for per-checkout tweaks.
 *
 *  2. The devShell itself. `mkShell` turns a Nix list attribute into a space-separated
 *     environment variable, so
 *
 *         pkgs.mkShell {
 *           vscodeExtensions = [ "rust-lang.rust-analyzer" "tamasfe.even-better-toml" ];
 *         }
 *
 *     arrives as `vscodeExtensions="rust-lang.rust-analyzer tamasfe.even-better-toml"`.
 *     The toolchain and the editor support for it are then declared and versioned in the
 *     same expression, which is the whole point of putting the shell in the flake.
 */
export const FLAKE_EXTENSION_VARS = ["vscodeExtensions", "VSCODE_EXTENSIONS"];

const EXTENSION_ID =
  /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*(@[\w.^-]+)?$/;

export interface ExtensionSources {
  /** From `nixDevelop.remote.extensions`. */
  fromSettings: string[];
  /** From the devShell's own environment. */
  fromFlake: string[];
}

export function collectExtensions(
  cfg: NixDevelopConfig,
  devShellEnv: Record<string, string>,
): ExtensionSources {
  const fromSettings = cfg.remote.extensions
    .map((s) => s.trim())
    .filter(Boolean);

  const fromFlake: string[] = [];
  if (cfg.remote.extensionsFromFlake) {
    for (const name of FLAKE_EXTENSION_VARS) {
      const raw = devShellEnv[name];
      if (!raw) continue;
      for (const id of raw.split(/[\s,]+/)) {
        const trimmed = id.trim();
        if (!trimmed) continue;
        if (!EXTENSION_ID.test(trimmed)) {
          log.warn(
            `ignoring '${trimmed}' from ${name}: not a publisher.name extension id`,
          );
          continue;
        }
        fromFlake.push(trimmed);
      }
    }
  }
  return { fromSettings, fromFlake };
}

export function mergedExtensions(sources: ExtensionSources): string[] {
  return [...new Set([...sources.fromFlake, ...sources.fromSettings])];
}

/** Extension ids currently present in a server extensions directory. */
export async function installedIn(extensionsDir: string): Promise<string[]> {
  try {
    const installled = [];

    const entries = await fsPromises.readdir(extensionsDir, {
      withFileTypes: true,
    });
    for (const e of entries) {
      if (await isDirectory(e)) {
        // Directories are `<publisher>.<name>-<version>`; drop the version suffix.

        installled.push(e.name.replace(/-\d+\.\d+\.\d+.*$/, ""));
      }
    }
    installled.sort();
    return installled;
  } catch {
    return [];
  }
}

/**
 * Install any declared extension that is not already present.
 *
 * Failures are logged rather than thrown: a typo in a flake attribute, or an extension
 * that is unavailable offline, should not stop the devShell window from opening.
 */
export async function ensureInstalled(opts: {
  cfg: NixDevelopConfig;
  launcher: string;
  extensionsDir: string;
  serverDataDir: string;
  flakeDir: string;
  wanted: string[];
  progress?: (m: string) => void;
}): Promise<{ installed: string[]; failed: string[] }> {
  const present = new Set(
    (await installedIn(opts.extensionsDir)).map((id) => id.toLowerCase()),
  );
  const missing = opts.wanted.filter(
    (id) => !present.has(id.split("@")[0].toLowerCase()),
  );
  if (missing.length === 0) return { installed: [], failed: [] };

  log.info(`installing into ${opts.extensionsDir}: ${missing.join(", ")}`);
  opts.progress?.(
    `Installing ${missing.length} extension(s) into the devShell…`,
  );

  const installed: string[] = [];
  const failed: string[] = [];
  for (const id of missing) {
    try {
      await run(
        opts.launcher,
        [
          "--extensions-dir",
          opts.extensionsDir,
          "--server-data-dir",
          opts.serverDataDir,
          "--accept-server-license-terms",
          "--telemetry-level",
          "off",
          "--install-extension",
          id,
        ],
        { cwd: opts.flakeDir, timeoutMs: 300_000 },
      );
      installed.push(id);
      log.info(`installed ${id}`);
    } catch (err) {
      failed.push(id);
      log.warn(`could not install ${id}: ${(err as Error).message}`);
    }
  }
  return { installed, failed };
}

/**
 * Each devShell gets its own extension directory, keyed by the authority (folder + devShell).
 *
 * That is what makes a devShell's extension set actually *be* the devShell's: what the flake
 * declares is what is there, and nothing another shell installed leaks in. It also makes the
 * set safe to prune, since a sync only ever runs when this devShell has no server.
 */
export function extensionsDirFor(root: string, key: string): string {
  return path.join(root, "extensions", key);
}

// ----------------------------------------------------------- nix-built extensions

/** An extension the devShell supplies as a Nix package. */
export interface NixExtension {
  /** `publisher.name`, taken from the directory the package installs. */
  id: string;
  /** The store path of the extension directory itself. */
  path: string;
}

/**
 * Extensions a devShell supplies through Nix rather than the Marketplace.
 *
 * `nix-vscode-extensions` (and `pkgs.vscode-extensions`) package an extension as
 * `$out/share/vscode/extensions/<publisher>.<name>`, and putting such a package in a
 * devShell's `packages` makes `$out/share` appear in `XDG_DATA_DIRS`. So the devShell can
 * pin its editor tooling in the flake, with no download at activation time and the same
 * versions for everyone.
 *
 * Only the entries the devShell *added* are considered: the host's own `XDG_DATA_DIRS`
 * may point at an existing VS Code installation, which is not what the flake declared.
 */
export async function collectNixExtensions(capture: {
  inside: Record<string, string>;
  baseline: Record<string, string>;
}): Promise<NixExtension[]> {
  const inside = capture.inside.XDG_DATA_DIRS ?? "";
  const baseline = new Set(
    (capture.baseline.XDG_DATA_DIRS ?? "").split(":").filter(Boolean),
  );
  const added = inside
    .split(":")
    .filter((entry) => entry && !baseline.has(entry));

  const found = new Map<string, string>();
  for (const share of added) {
    const dir = path.join(share, "vscode", "extensions");
    let entries: string[];
    try {
      entries = await fsPromises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (!(await exists(path.join(full, "package.json")))) continue;
      // First one wins, matching how XDG_DATA_DIRS is searched.
      if (!found.has(name)) found.set(name, full);
    }
  }

  return [...found]
    .map(([id, p]) => ({ id, path: p }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Is this a symlink we created, pointing at a Nix-built extension?
 *
 * Identified by shape rather than by a `/nix/store` prefix: the store path is
 * configurable, and what actually distinguishes these links is that they point at
 * `.../share/vscode/extensions/<same name>`.
 */
const EXTENSION_SHARE_PATH = /\/share\/vscode\/extensions\/([^/]+)\/?$/;

async function managedLink(
  entry: string,
  name: string,
): Promise<string | undefined> {
  try {
    const stat = await fsPromises.lstat(entry);
    if (!stat.isSymbolicLink()) return undefined;
    const target = await fsPromises.readlink(entry);
    const match = EXTENSION_SHARE_PATH.exec(target);
    return match && match[1] === name ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make the extension directory match the devShell's Nix-supplied extensions exactly.
 *
 * Removal is safe because the directory belongs to a single devShell and a sync only runs
 * when that devShell has no server: nothing can be pulled out from under a live extension
 * host. Real directories are never touched -- those came from the Marketplace and are not
 * ours to remove.
 */
export async function syncNixExtensions(
  extensionsDir: string,
  wanted: NixExtension[],
): Promise<{ linked: string[]; removed: string[] }> {
  await fsPromises.mkdir(extensionsDir, { recursive: true });
  const byId = new Map(wanted.map((e) => [e.id, e.path]));
  const linked: string[] = [];
  const removed: string[] = [];

  for (const name of await fsPromises.readdir(extensionsDir).catch(() => [])) {
    const entry = path.join(extensionsDir, name);
    const target = await managedLink(entry, name);
    if (!target) continue;
    if (byId.get(name) === target) {
      byId.delete(name); // already correct
      continue;
    }
    await fsPromises.rm(entry, { force: true });
    // Present with a different target is a version bump, not a removal: it is relinked below.
    if (!byId.has(name)) removed.push(name);
  }

  for (const [id, target] of byId) {
    const entry = path.join(extensionsDir, id);
    if ((await managedLink(entry, id)) === undefined) {
      if (await exists(entry)) {
        log.warn(
          `${id} is installed from the Marketplace; not replacing it with the Nix build`,
        );
        continue;
      }
    }
    await fsPromises.symlink(target, entry);
    linked.push(id);
  }

  if (linked.length > 0)
    log.info(`linked Nix-built extensions: ${linked.join(", ")}`);
  if (removed.length > 0)
    log.info(`unlinked extensions no longer declared: ${removed.join(", ")}`);
  return { linked, removed };
}
