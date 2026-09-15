import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exists } from "./utils/fs-stat";

/**
 * direnv co-existence.
 *
 * A devShell window gets its environment from the server running inside `nix develop`, so
 * direnv and this extension no longer contend for the terminal. What still matters is
 * *which* devShell each one picked: a plain terminal outside the window follows `.envrc`,
 * so a shell it names is the project's own statement of which one it means, and the picker
 * offers that one first. It is the only such statement left -- there is no setting.
 */
export interface DirenvState {
  /** An `.envrc` exists in the flake directory. */
  present: boolean;
  /** `.envrc` uses a flake devShell (`use flake`, `use nix`). */
  usesFlake: boolean;
  /** direnv has been allowed here, so its hook actually runs. */
  allowed: boolean;
  /** The devShell `.envrc` names, when it names one. */
  devShell?: string;
}
// Todo ensure direnv extension is disabled in remote workspace
/**
 * `use flake`, `use flake .#ci`, `use flake "path:.#ci"`, `use nix`.
 *
 * The rest of the line is captured whole: `#` cannot be excluded here because it is what
 * separates the flake reference from the attribute. Trailing shell comments are stripped
 * afterwards, where `#` is only a comment when whitespace precedes it.
 */
const USE_FLAKE = /^[ \t]*use[ \t]+(?:flake|nix)\b([^\n]*)/m;
const TRAILING_COMMENT = /\s+#.*$/;
const ATTR = /#([A-Za-z0-9_][A-Za-z0-9_.-]*)/;

export async function detectDirenv(dir: string): Promise<DirenvState> {
  let envrc: string;
  try {
    envrc = await fs.readFile(path.join(dir, ".envrc"), "utf8");
  } catch {
    return { present: false, usesFlake: false, allowed: false };
  }

  const match = USE_FLAKE.exec(envrc);
  const usesFlake = match !== null;

  let devShell: string | undefined;
  if (match) {
    const attr = ATTR.exec((match[1] ?? "").replace(TRAILING_COMMENT, ""));
    if (attr) {
      // `.#devShells.x86_64-linux.ci` and `.#ci` both name `ci`.
      const parts = attr[1].split(".");
      devShell = parts[parts.length - 1];
    }
  }

  /**
 * direnv records approval outside the project, so a `.envrc` alone does not mean its hook
 * runs. `.direnv/` is the practical signal that it has loaded here at least once; a stale
 * cache without an `.envrc` is ignored by the caller, since `present` is false there.
 */
  const allowed = await exists(path.join(dir, ".direnv"))

  return { present: true, usesFlake, allowed, devShell };
}
