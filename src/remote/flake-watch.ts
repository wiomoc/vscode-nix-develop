import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { readConfig } from "../config";
import { log } from "../utils/log";
import type { StatusBar, StatusState } from "../ui";
import { decodeAuthority, storageKeyFor } from "./authority";
import { ServerManager } from "./server";

/** The files a devShell is built from. A change to either one invalidates the shell. */
const FLAKE_FILES = ["flake.nix", "flake.lock"];

/** How long the flake has to sit still before the change is acted on. */
const SETTLE_MS = 750;

/**
 * A digest of `flake.nix` and `flake.lock` contents, so saving unchanged files is not a
 * change. Read synchronously, so an edit landing right after startup cannot become the
 * baseline.
 */
function digest(dir: string): string {
  const hash = crypto.createHash("sha256");
  for (const name of FLAKE_FILES) {
    hash.update(name);
    try {
      hash.update(fs.readFileSync(path.join(dir, name)));
    } catch {
      // Absent is a state like any other: a flake.lock appearing is a change.
      hash.update("absent");
    }
  }
  return hash.digest("hex");
}

/**
 * Watch the flake this devShell window was built from, and offer a restart when it
 * changes, since the running shell keeps the old toolchain.
 *
 * `fs.watch`, since the flake is a local path while the window's folders are remote. The
 * directory is watched, because an atomic save replaces the file by rename.
 */
export function watchDevShellFlake(
  context: vscode.ExtensionContext,
  status: StatusBar,
  active: StatusState,
): vscode.Disposable {
  const authority = vscode.env.remoteAuthority;
  const target = authority ? decodeAuthority(authority) : undefined;
  if (!target) return { dispose() {} };

  // Taken once, at the point the window is running the shell this describes.
  const built = digest(target.flakeDir);
  let announced = false;
  let timer: NodeJS.Timeout | undefined;

  const check = async (): Promise<void> => {
    if (digest(target.flakeDir) === built) {
      // Edited and then put back: the running shell is the right one again.
      if (announced) {
        announced = false;
        log.info("the flake is back to what this devShell was built from");
        status.set(active);
      }
      return;
    }

    // The status bar carries this from here on, so the notification is shown once. A
    // prompt per save would land on whoever is in the middle of editing their flake.
    if (announced) return;
    announced = true;
    log.info(
      `${target.flakeDir} changed since devShell '${target.devShell}' was built; ` +
        "this window is still running the old shell",
    );
    status.set({
      kind: "stale",
      label: target.devShell,
      reason: "the flake changed after this devShell was built",
    });

    const choice = await vscode.window.showInformationMessage(
      "The flake changed. This window is still running the devShell built before that edit.",
      "Restart devShell",
      "Later",
    );
    if (choice === "Restart devShell") await restartDevShellWindow(context);
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(target.flakeDir, { persistent: false });
  } catch (err) {
    // A flake directory that cannot be watched is not worth failing the window over.
    log.warn(`cannot watch ${target.flakeDir} for flake changes: ${(err as Error).message}`);
    return { dispose() {} };
  }

  watcher.on("error", (err) => log.warn(`the flake watcher stopped: ${err.message}`));
  watcher.on("change", (_event, name) => {
    // `name` can be absent on some platforms; re-checking costs two small reads.
    if (name && !FLAKE_FILES.includes(name.toString())) return;
    clearTimeout(timer);
    timer = setTimeout(() => void check().catch((err) => log.error(err as Error)), SETTLE_MS);
  });

  log.info(`watching ${target.flakeDir} for changes to the devShell this window runs in`);
  return {
    dispose() {
      clearTimeout(timer);
      watcher.close();
    },
  };
}

/**
 * Rebuild this window's devShell: stop its server, so the resolver cannot reattach to it,
 * then reload.
 */
export async function restartDevShellWindow(context: vscode.ExtensionContext): Promise<void> {
  const authority = vscode.env.remoteAuthority;
  const target = authority ? decodeAuthority(authority) : undefined;
  if (!authority || !target) {
    void vscode.window.showInformationMessage(
      "This window is not running inside a devShell, so there is no server to restart.",
    );
    return;
  }

  const cfg = readConfig(vscode.workspace.workspaceFolders?.[0]);
  const servers = new ServerManager(context.globalStorageUri, cfg);
  const stopped = await servers.stop(storageKeyFor(authority));
  log.info(
    stopped
      ? `stopped the server for devShell '${target.devShell}'; reloading`
      : `no running server for devShell '${target.devShell}'; reloading`,
  );
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}
