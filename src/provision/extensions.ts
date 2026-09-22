import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { log } from "./log";
import { exists, isDirectory } from "../utils/fs-stat";
import { run } from "./run";
import { syncManifest } from "./extensions-manifest";

/**
 * Per-devShell extension sets.
 *
 * A remote window loads `workspace`-kind extensions from the *server's* `--extensions-dir`,
 * not from the local install. Pointing that directory at a per-devShell path is therefore
 * all it takes to scope a set of extensions to one devShell: two devShells in the same repo
 * get genuinely separate extension sets, and neither disturbs the local window.
 *
 * Which extensions belong to a devShell is declared by the devShell itself, in a
 * `vscodeExtensions` list. `mkShell` turns a Nix list attribute into a space-separated
 * environment variable, and a derivation in that list stringifies to its store path, so
 *
 *     pkgs.mkShell {
 *       vscodeExtensions = [
 *         pkgs.vscode-extensions.jnoortheen.nix-ide   # built by Nix
 *         "rust-lang.rust-analyzer"                   # fetched from the Marketplace
 *       ];
 *     }
 *
 * arrives as `vscodeExtensions="/nix/store/...-nix-ide-0.5.13 rust-lang.rust-analyzer"`.
 * The two forms are told apart by shape -- a store path is absolute, an id is not -- and
 * handled differently: a package is already built, so it is linked, while an id has to be
 * downloaded. The toolchain and the editor support for it are then declared and versioned
 * in the same expression, which is the whole point of putting the shell in the flake.
 */
const FLAKE_EXTENSION_VARS = ["vscodeExtensions", "VSCODE_EXTENSIONS"];

const EXTENSION_ID =
  /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_-]*(@[\w.^-]+)?$/;

/** What a devShell's extension list asks for, split by how each entry is obtained. */
export interface DeclaredExtensions {
  /** Marketplace ids, in declaration order and without duplicates. */
  ids: string[];
  /** Store paths of Nix-built extension packages, in declaration order, deduplicated. */
  paths: string[];
}

/** What the devShell declares, in declaration order and without duplicates. */
export function collectExtensions(
  devShellEnv: Record<string, string | undefined>,
): DeclaredExtensions {
  const ids: string[] = [];
  const paths: string[] = [];
  for (const name of FLAKE_EXTENSION_VARS) {
    const raw = devShellEnv[name];
    if (!raw) continue;
    for (const entry of raw.split(/[\s,]+/)) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      // Store paths have no spaces in them, so splitting on whitespace is safe, and an
      // absolute path is never a valid extension id -- the two cannot be confused.
      if (path.isAbsolute(trimmed)) {
        paths.push(trimmed);
        continue;
      }
      if (!EXTENSION_ID.test(trimmed)) {
        log.warn(
          `ignoring '${trimmed}' from ${name}: not a publisher.name extension id or a store path`,
        );
        continue;
      }
      ids.push(trimmed);
    }
  }
  return { ids: [...new Set(ids)], paths: [...new Set(paths)] };
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
  launcher: string;
  extensionsDir: string;
  serverDataDir: string;
  flakeDir: string;
  wanted: string[];
  /** How long one install may take; see `ProvisionOptions.installTimeoutSeconds`. */
  timeoutMs?: number;
}): Promise<{ installed: string[]; failed: string[] }> {
  const present = new Set(
    (await installedIn(opts.extensionsDir)).map((id) => id.toLowerCase()),
  );
  const missing = opts.wanted.filter(
    (id) => !present.has(id.split("@")[0].toLowerCase()),
  );
  if (missing.length === 0) return { installed: [], failed: [] };

  log.info(
    `installing ${missing.length} extension(s) into ${opts.extensionsDir}: ${missing.join(", ")}`,
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
        { cwd: opts.flakeDir, timeoutMs: opts.timeoutMs ?? 300_000 },
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
 * Both `pkgs.vscode-extensions` (nixpkgs' own curated set) and `nix-vscode-extensions`
 * (almost every Marketplace / Open VSX extension) build an extension as
 * `$out/share/vscode/extensions/<publisher>.<name>`, so a package named in
 * `vscodeExtensions` needs no convention beyond the one they already follow: look under
 * that prefix and take what is there. The devShell can pin its editor tooling in the
 * flake, with no download at activation time and the same versions for everyone.
 *
 * A path that yields nothing is warned about and skipped: a package that turns out not to
 * hold an extension should cost that entry, not the window. A duplicate id keeps the
 * first declaration, so a package named twice is linked once.
 */
export async function resolveNixExtensions(
  storePaths: string[],
): Promise<NixExtension[]> {
  const found = new Map<string, NixExtension>();
  for (const storePath of storePaths) {
    const dir = path.join(storePath, "share", "vscode", "extensions");
    let empty = true;
    for (const name of await fsPromises.readdir(dir).catch(() => [])) {
      const full = path.join(dir, name);
      if (!(await exists(path.join(full, "package.json")))) continue;
      empty = false;
      if (!found.has(name)) found.set(name, { id: name, path: full });
    }
    if (empty)
      log.warn(
        `ignoring '${storePath}' from vscodeExtensions: no VS Code extension in it`,
      );
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
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
 *
 * The server's own record of the directory is part of what has to match, so it is written
 * here too: a link the record does not name is marked for removal on the next start. See
 * `extensions-manifest.ts` for why that cannot be left to the server.
 */
export async function syncNixExtensions(
  extensionsDir: string,
  wanted: NixExtension[],
): Promise<{ linked: string[]; removed: string[] }> {
  await fsPromises.mkdir(extensionsDir, { recursive: true });
  const byId = new Map(wanted.map((e) => [e.id, e.path]));
  const linked: string[] = [];
  const removed: string[] = [];
  /** What the directory holds as ours once this is done -- not just what changed. */
  const present: NixExtension[] = [];

  for (const name of await fsPromises.readdir(extensionsDir).catch(() => [])) {
    const entry = path.join(extensionsDir, name);
    const target = await managedLink(entry, name);
    if (!target) continue;
    if (byId.get(name) === target) {
      byId.delete(name); // already correct
      present.push({ id: name, path: target });
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
    present.push({ id, path: target });
  }

  if (linked.length > 0)
    log.info(`linked Nix-built extensions: ${linked.join(", ")}`);
  if (removed.length > 0)
    log.info(`unlinked extensions no longer declared: ${removed.join(", ")}`);

  // Only what is actually linked is recorded: an id we refused to replace belongs to the
  // Marketplace install still sitting there, and the record already describes that one.
  await syncManifest(extensionsDir, present, removed);

  return { linked, removed };
}

/**
 * Resolve the devShell's declared extensions and install the missing ones.
 *
 * The environment read here is this process's own: the script runs inside `nix develop`,
 * so `vscodeExtensions` is simply there. Nothing has to be dumped, shipped across a
 * process boundary and parsed back -- which is what the extension host used to do.
 *
 * A failure costs the extension, never the window: the server starts either way, and what
 * went wrong is on the stream the build terminal is showing.
 */
export async function installDeclaredExtensions(opts: {
  launcher: string;
  extensionsDir: string;
  serverDataDir: string;
  flakeDir: string;
  devShellEnv: Record<string, string | undefined>;
  installTimeoutMs: number;
}): Promise<void> {
  const declared = collectExtensions(opts.devShellEnv);

  // Extensions the devShell supplies as Nix packages are already built: they only need
  // linking into the extension directory, with no download and no version drift.
  const nixExtensions = await resolveNixExtensions(declared.paths);
  if (nixExtensions.length > 0) {
    log.info(
      `devShell supplies via Nix: ${nixExtensions.map((e) => e.id).join(", ")}`,
    );
  }
  // Runs even when the set is empty: that is what unlinks what the flake dropped.
  await syncNixExtensions(opts.extensionsDir, nixExtensions).catch((err) =>
    log.warn(`could not link Nix-built extensions: ${(err as Error).message}`),
  );

  const wanted = declared.ids;
  if (wanted.length === 0) return;

  log.info(`devShell extensions -- from flake: [${wanted.join(", ")}]`);

  const { failed } = await ensureInstalled({
    launcher: opts.launcher,
    extensionsDir: opts.extensionsDir,
    serverDataDir: opts.serverDataDir,
    flakeDir: opts.flakeDir,
    wanted,
    timeoutMs: opts.installTimeoutMs,
  });
  // `log.warn` rather than a notification: there is no `vscode` here. The extension host
  // counts the warnings it sees go past and raises the one notification that covers them.
  if (failed.length > 0) {
    log.warn(`could not install into the devShell: ${failed.join(", ")}`);
  }
}
