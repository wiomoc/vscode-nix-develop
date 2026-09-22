import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { log } from "./utils/log";
import type { NixDevShellConfig } from "./config";

/**
 * What roots a devShell against `nix store gc`: `persistent` keeps a profile under
 * `.vscode/nix-devshell/`; `none` leaves it unrooted, protected only while a process
 * references it.
 */
export type ProfileMode = NixDevShellConfig["profile"];

/** Everything this extension writes into a project lives here. */
const PROFILE_DIR = path.join(".vscode", "nix-devshell");

/** Ignores everything, this file included, so the directory never shows in `git status`. */
const GITIGNORE = [
  "# Nix GC roots for the devShells opened by the nix-devshell extension.",
  "# Machine-specific store paths, recreated on demand -- never committed.",
  "*",
  "",
].join("\n");

/** The directory holding every devShell profile for a workspace folder. */
export function profileRoot(folder: string): string {
  return path.join(folder, PROFILE_DIR);
}

/**
 * A directory name for a devShell: its own name when that is safe, otherwise a sanitised
 * name plus a digest, so different installables never share a profile.
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
 * The GC root for a devShell (creating its directory and `.gitignore`), or `undefined`
 * for `none` or when the folder is not writable.
 */
export async function ensureProfile(
  cfg: NixDevShellConfig,
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
