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
 * What the devShell was built from, as one value.
 *
 * Contents rather than mtime and size, because saving a file the editor has not changed --
 * or `nix flake update` writing back an identical lock -- must not be reported as a change
 * the user has to restart for.
 *
 * Read synchronously: the baseline has to be the flake as it was when the window opened,
 * and an asynchronous read can lose to an edit that lands a tick later -- which would
 * quietly take that edit as the baseline and never report it. Two small files at window
 * startup, on a path that already runs `nix develop`.
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
 * Watch the flake this devShell window was opened against, and offer to restart on a change.
 *
 * The window's extension host is running inside a shell that was built when the window
 * opened. Editing the flake afterwards changes nothing about the running shell -- every
 * terminal, task and language server still has the old toolchain -- and until now nothing
 * said so, which is indistinguishable from the extension having ignored the edit.
 *
 * `fs.watch` rather than `workspace.createFileSystemWatcher`: this is the UI side of the
 * extension, so the flake is an ordinary local path, while the window's own folders are
 * `vscode-remote://` URIs that no local pattern can be hung off. The *directory* is
 * watched rather than the two files, because a replace-by-rename -- how `nix flake update`
 * writes, and how an atomic save writes -- leaves a watch on the old file watching nothing.
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
 * Put this window back on a devShell built from the flake as it is now.
 *
 * The reload is what re-runs the resolver, and stopping the server first is what stops the
 * resolver attaching to the one already listening -- a server outlives its window, so
 * reloading on its own would come straight back to the same shell. This extension runs on
 * the UI side, so it survives its own server being stopped and can see the reload through.
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
