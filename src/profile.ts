import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { log } from "./utils/log";
import type { NixDevelopConfig } from "./config";

/**
 * What roots a devShell against `nix store gc`.
 *
 * `persistent` writes a Nix profile next to the project, under `.vscode/nix-develop/`, and
 * leaves it there. `none` passes no `--profile` at all, which leaves the shell's store
 * paths unrooted: on Linux, Nix's GC still scans `/proc` for paths a live process
 * references, so a *running* server is largely covered, but nothing protects the shell
 * between the environment capture and the server start, nothing survives the server's
 * exit, and a GC that starts before the server appears does not see it at all.
 */
export type ProfileMode = NixDevelopConfig["profile"];

/** Everything this extension writes into a project lives here. */
export const PROFILE_DIR = path.join(".vscode", "nix-develop");

/**
 * Store paths, one machine's Nix store, rebuilt on demand: nothing here belongs in a
 * repository. `*` covers this file too, so the directory disappears from `git status`
 * entirely rather than leaving the ignore rule itself to be committed.
 */
const GITIGNORE = [
  "# Nix GC roots for the devShells opened by the nix-develop extension.",
  "# Machine-specific store paths, recreated on demand -- never committed.",
  "*",
  "",
].join("\n");

/** The directory holding every devShell profile for a workspace folder. */
export function profileRoot(folder: string): string {
  return path.join(folder, PROFILE_DIR);
}

/**
 * A directory name for a devShell: its own name where that is already a safe one.
 *
 * A devShell is named by an attribute (`default`, `ci`) but may also arrive as a full
 * installable (`.#ci`, `github:owner/repo#ci`), which is not a usable path component. The
 * readable name is kept whenever it survives unchanged, since the point of putting these
 * next to the project is that a person can see which shell a root belongs to. Anything
 * that had to be rewritten -- or is too long for a path component -- carries a digest of
 * the original, because sanitising alone would map two different devShells onto one
 * directory and so onto one profile.
 */
export function profileDirName(devShell: string): string {
  const safe = devShell
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  if (safe === devShell && safe.length <= 64) return safe;

  const digest = crypto
    .createHash("sha256")
    .update(devShell)
    .digest("hex")
    .slice(0, 8);
  return `${safe.slice(0, 64) || "devshell"}-${digest}`;
}

/**
 * The GC root for a devShell, or nothing when the user asked for none.
 *
 * Creating the directory here rather than at the `nix develop` call site is what lets the
 * `.gitignore` be written exactly once, alongside it. A failure is not fatal: a read-only
 * checkout, or a folder the user cannot write to, gives up the root and opens the window
 * anyway -- which is `none`, the mode they could have chosen.
 */
export async function ensureProfile(
  cfg: NixDevelopConfig,
  folder: string,
  devShell: string,
): Promise<string | undefined> {
  if (cfg.profile === "none") return undefined;

  const root = profileRoot(folder);
  const dir = path.join(root, profileDirName(devShell));
  try {
    await fs.mkdir(dir, { recursive: true });
    // `wx` so an ignore file the user has since edited is left as theirs.
    await fs
      .writeFile(path.join(root, ".gitignore"), GITIGNORE, { flag: "wx" })
      .catch(() => undefined);
    return path.join(dir, "devshell");
  } catch (err) {
    log.warn(
      `could not create the devShell profile under ${root}, continuing without a GC root: ${
        (err as Error).message
      }`,
    );
    return undefined;
  }
}
