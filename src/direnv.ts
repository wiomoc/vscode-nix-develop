import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exists } from "./utils/fs-stat";

/** What `.envrc` says; a devShell it names is offered first in the picker. */
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
 * `use flake`, `use flake .#ci`, `use flake "path:.#ci"`, `use nix`. The rest of the line
 * is captured whole, since `#` also separates the attribute; comments are stripped later.
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

  // Approval is recorded outside the project; `.direnv/` shows it has loaded here.
  const allowed = await exists(path.join(dir, ".direnv"))

  return { present: true, usesFlake, allowed, devShell };
}
