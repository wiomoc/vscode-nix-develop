import * as fs from "node:fs/promises";
import * as path from "node:path";
import { log } from "./log";
import type { NixExtension } from "./extensions";

/**
 * The server's record of installed extensions (`extensions.json`).
 *
 * The server loads only what this file lists, and on start marks anything unlisted for
 * removal (in `.obsolete`). It adds unlisted directories itself only when the file does
 * not exist yet, or when they appear while it runs. Our links are made before the server
 * starts, so we must write their entries ourselves.
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
 * The server's own validity check, reproduced: one bad entry makes it reject the whole
 * file.
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
 * Bring the server's record in line with the Nix extensions we linked: existing entries
 * are updated in place, entries for unlinked ones dropped, others left alone.
 *
 * A missing record is not created, so the server still imports the whole directory on
 * its next start. Errors are logged, not thrown.
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
 * Take our extensions off the server's removal list, where they would otherwise stay
 * hidden even once listed. Keys are `<id>-<version>`, as the server writes them.
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
