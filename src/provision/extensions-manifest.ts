import * as fs from "node:fs/promises";
import * as path from "node:path";
import { log } from "../utils/log";
import type { NixExtension } from "./extensions";

/**
 * The server's own record of what is installed in an extensions directory.
 *
 * A VS Code server does not load what it finds in `--extensions-dir`; it loads what
 * `extensions.json` in that directory lists. On every start its `ExtensionsWatcher` scans
 * the directory and marks for removal everything whose `<id>-<version>` is missing from
 * that file -- recording the removal in `.obsolete`, which then hides the extension from
 * later scans as well.
 *
 * There are two ways an extension that was put there by something other than the server
 * gets into the file, and a symlink of ours meets neither:
 *
 *   - the directory is migrated wholesale into the record, but only when the record does
 *     not exist yet, which is the first server start for a devShell;
 *   - a directory that *appears while the server is running* is noticed by its file
 *     watcher and added.
 *
 * We link before the server starts, deliberately: pruning is only safe when the devShell
 * has no server, so nothing can be pulled out from under a live extension host. That puts
 * every link we make outside both paths, so the record has to be written here -- otherwise
 * a Nix-supplied extension works only if it happened to be there at the first ever start,
 * and even then only until its version changes.
 *
 * What is written stays minimal: an entry the server's validator accepts, with whatever
 * the record already held for that extension preserved.
 */

/** The record itself: what the server reads instead of listing the directory. */
export function manifestPath(extensionsDir: string): string {
  return path.join(extensionsDir, "extensions.json");
}

function obsoletePath(extensionsDir: string): string {
  return path.join(extensionsDir, ".obsolete");
}

/** One entry of `extensions.json`. */
interface ProfileEntry {
  identifier: { id: string; uuid?: string };
  version: string;
  location: { $mid: number; path: string; scheme: string };
  relativeLocation: string;
  metadata?: Record<string, unknown>;
}

/**
 * The server's own validity check, reproduced.
 *
 * It rejects the *whole file* when a single entry fails, which would cost the devShell
 * every extension it has -- so nothing is written until what we are about to write passes
 * the same test.
 */
function isValidEntry(entry: unknown): entry is ProfileEntry {
  const e = entry as ProfileEntry;
  return (
    !!e &&
    typeof e === "object" &&
    !!e.identifier &&
    typeof e.identifier === "object" &&
    typeof e.identifier.id === "string" &&
    (!e.identifier.uuid || typeof e.identifier.uuid === "string") &&
    !!e.location &&
    typeof e.location.path === "string" &&
    typeof e.location.scheme === "string" &&
    (e.relativeLocation === undefined ||
      typeof e.relativeLocation === "string") &&
    !!e.version &&
    typeof e.version === "string"
  );
}

/** The version an extension directory declares, or undefined if it declares none. */
async function versionOf(extensionDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(extensionDir, "package.json"), "utf8"),
    );
    return typeof manifest.version === "string" && manifest.version
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bring the server's record in line with the Nix extensions we linked.
 *
 * Entries the record already holds are updated rather than replaced, so a uuid or the
 * gallery metadata an earlier install left behind survives. Entries for extensions we
 * unlinked are dropped, which is what stops the record naming a directory that is gone.
 * Everything else in the file is another installer's business and is left untouched.
 *
 * A record that does not exist yet is *not* created: that absence is what makes the server
 * migrate the directory wholesale on its next start, which picks up our links along with
 * anything else there. Writing a partial file first would take that migration away and
 * lose whatever it would have found.
 *
 * Trouble here is logged, not thrown. The extensions are linked either way, and a record
 * we cannot safely rewrite is better left as it is than replaced with a guess.
 */
export async function syncManifest(
  extensionsDir: string,
  linked: NixExtension[],
  unlinked: string[],
): Promise<{ recorded: string[]; dropped: string[] }> {
  const none = { recorded: [], dropped: [] };
  const file = manifestPath(extensionsDir);

  let existing: ProfileEntry[];
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(parsed)) {
      log.warn(`not recording Nix-built extensions: ${file} is not a list`);
      return none;
    }
    existing = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // The server has not written its record yet, so its first start will build one from
      // the directory -- which is where our links already are.
      return none;
    }
    log.warn(
      `not recording Nix-built extensions: ${file} is unreadable (${(err as Error).message})`,
    );
    return none;
  }

  const byId = new Map<string, ProfileEntry>();
  for (const entry of existing) {
    if (!isValidEntry(entry)) {
      // Rewriting a file we do not fully understand could drop an extension that works.
      log.warn(
        `not recording Nix-built extensions: ${file} has an entry we cannot read`,
      );
      return none;
    }
    byId.set(entry.identifier.id.toLowerCase(), entry);
  }

  const recorded: string[] = [];
  const next = new Map(byId);
  for (const ext of linked) {
    const version = await versionOf(ext.path);
    if (!version) {
      log.warn(`not recording ${ext.id}: its package.json declares no version`);
      continue;
    }
    const previous = next.get(ext.id.toLowerCase());
    next.set(ext.id.toLowerCase(), {
      // A uuid and the gallery metadata are worth keeping: they are how the editor matches
      // the extension against the Marketplace, and we have nothing better to put there.
      identifier: {
        id: ext.id,
        ...(previous?.identifier.uuid
          ? { uuid: previous.identifier.uuid }
          : {}),
      },
      version,
      location: {
        $mid: 1,
        path: path.join(extensionsDir, ext.id),
        scheme: "file",
      },
      relativeLocation: ext.id,
      ...(previous?.metadata ? { metadata: previous.metadata } : {}),
    });
    recorded.push(ext.id);
  }

  const dropped: string[] = [];
  for (const id of unlinked) {
    if (next.delete(id.toLowerCase())) dropped.push(id);
  }

  const entries = [...next.values()];
  if (!entries.every(isValidEntry)) {
    log.warn(
      `not recording Nix-built extensions: the result would not be valid`,
    );
    return none;
  }

  // Compared as values: the server rewrites this file itself, and a run that changes
  // nothing should not touch it.
  const body = JSON.stringify(entries);
  if (body !== JSON.stringify(existing)) {
    await fs.writeFile(file, body);
    log.info(
      `recorded in ${file}: ${recorded.length} Nix-built extension(s)` +
        (dropped.length > 0 ? `, ${dropped.length} no longer declared` : ""),
    );
  }

  await unmarkForRemoval(
    extensionsDir,
    entries
      .filter((e) => recorded.includes(e.identifier.id))
      .map((e) => `${e.identifier.id}-${e.version}`),
  );

  return { recorded, dropped };
}

/**
 * Take our extensions off the server's removal list.
 *
 * An extension the server marked for removal stays hidden even once the record names it
 * again, and the next cleanup deletes the directory -- so a link that was rejected on an
 * earlier start would be rejected forever. The keys are `<id>-<version>`, exactly as the
 * server writes them for an extension with no target platform of its own.
 */
async function unmarkForRemoval(
  extensionsDir: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const file = obsoletePath(extensionsDir);

  let marked: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    marked = parsed;
  } catch {
    // No list, or one we cannot read: nothing of ours is on it either way.
    return;
  }

  const cleared = keys.filter((key) => key in marked);
  if (cleared.length === 0) return;
  for (const key of cleared) delete marked[key];

  await fs.writeFile(file, JSON.stringify(marked));
  log.info(`no longer marked for removal: ${cleared.join(", ")}`);
}
