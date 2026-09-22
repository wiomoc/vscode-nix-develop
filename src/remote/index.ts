import * as path from "node:path";
import * as vscode from "vscode";
import { EXTENSION_ID, isResolverAvailable, readConfig } from "../config";
import { log } from "../utils/log";
import { currentSystem, listDevShells } from "../nix";
import {
  AUTHORITY_PREFIX,
  authorityFor,
  decodeAuthority,
  storageKeyFor,
} from "./authority";
import { extensionsDirFor, installedIn } from "../provision/extensions";
import { ServerManager } from "./server";
import { reopenFolderLocally } from "./recover";
import { pickDevShell } from "../ui";

export {
  AUTHORITY_PREFIX,
  authorityFor,
  decodeAuthority,
  storageKeyFor,
} from "./authority";
export { NixDevShellResolver } from "./resolver";
export { restartDevShellWindow, watchDevShellFlake } from "./flake-watch";
export { openPendingFile } from "./recover";

/** True when this window is already running against one of our devShell servers. */
export function inDevShellWindow(): boolean {
  return (vscode.env.remoteAuthority ?? "").startsWith(`${AUTHORITY_PREFIX}+`);
}

/**
 * Reopen a folder in a devShell window. This only encodes the authority; the resolver
 * does the work.
 */
export async function reopenInDevShell(
  folder: vscode.WorkspaceFolder,
  devShell: string,
  flakeDir: string,
): Promise<void> {
  if (folder.uri.scheme !== "file") {
    void vscode.window.showWarningMessage(
      "Only local folders can be reopened in a devShell.",
    );
    return;
  }
  if (!devShell) {
    void vscode.window.showWarningMessage("Select a devShell first.");
    return;
  }
  // Needs the proposed resolver API; checked here rather than in every flake window.
  if (!isResolverAvailable()) {
    // argv.json, since `--enable-proposed-api` only lasts one launch.
    const choice = await vscode.window.showWarningMessage(
      "Nix DevShell needs the `resolvers` proposed API to open a devShell window. " +
        `Add "enable-proposed-api": ["${EXTENSION_ID}"] to argv.json, ` +
        "then restart VS Code.",
      "Open argv.json",
      "How?",
    );
    if (choice === "Open argv.json") {
      await vscode.commands.executeCommand(
        "workbench.action.configureRuntimeArguments",
      );
    } else if (choice === "How?") log.show();
    return;
  }

  const authority = authorityFor({
    folder: folder.uri.fsPath,
    flakeDir,
    devShell,
  });

  const uri = vscode.Uri.from({
    scheme: "vscode-remote",
    authority,
    path: folder.uri.path,
  });

  log.info(`reopening ${folder.uri.fsPath} at ${uri.toString()}`);
  await vscode.commands.executeCommand("vscode.openFolder", uri, {
    forceReuseWindow: true,
  });
}

/** Go back to a normal local window. */
export async function reopenLocally(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage("No folder is open.");
    return;
  }
  await reopenFolderLocally(folder.uri);
}

/**
 * Stop the server backing a devShell, so the next open starts a fresh one: this window's
 * own, or one picked from a local window.
 */
export async function killServer(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder | undefined,
): Promise<void> {
  const cfg = readConfig(folder);
  let key: string | undefined;
  /** Whether the server being stopped is the one this window is running against. */
  let ownServer = false;

  if (inDevShellWindow() && vscode.env.remoteAuthority) {
    key = storageKeyFor(vscode.env.remoteAuthority);
    ownServer = true;
  } else if (folder) {
    const flakeDir = path.resolve(folder.uri.fsPath, cfg.flakeDirectory);
    const shells = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Nix: evaluating flake…",
        cancellable: true,
      },
      async (_p, token) => {
        const system = await currentSystem(cfg, flakeDir, token);
        return listDevShells(cfg, flakeDir, system, token);
      },
    );
    const picked = await pickDevShell(shells);
    if (!picked) return;
    key = storageKeyFor(
      authorityFor({
        folder: folder.uri.fsPath,
        flakeDir,
        devShell: picked.value,
      }),
    );
  }

  if (!key) {
    void vscode.window.showInformationMessage(
      "No devShell server is associated with this window.",
    );
    return;
  }

  // This window ran on that server, so put the folder back in a local window.
  if (ownServer && folder) {
    log.info(
      "stopped this window's devShell server; reopening the folder locally",
    );
    reopenFolderLocally(folder.uri);
    return;
  }

  const servers = new ServerManager(context.globalStorageUri, cfg);
  const stopped = await servers.stop(key);


  void vscode.window.showInformationMessage(
    stopped
      ? "devShell server stopped."
      : "No running devShell server was found.",
  );
}

/**
 * Clear out locks left by servers that retired while nothing of ours was running.
 * Housekeeping only: every reader checks the port anyway.
 */
export async function sweepServerLocks(
  context: vscode.ExtensionContext,
): Promise<void> {
  const cfg = readConfig(vscode.workspace.workspaceFolders?.[0]);
  try {
    await new ServerManager(context.globalStorageUri, cfg).sweep();
  } catch (err) {
    log.warn(
      `sweeping stale devShell server locks failed: ${(err as Error).message}`,
    );
  }
}

/**
 * Switch devShells from inside a devShell window, using the flake recorded in its
 * authority.
 */
export async function switchDevShellInRemoteWindow(
  context: vscode.ExtensionContext,
): Promise<void> {
  const authority = vscode.env.remoteAuthority;
  if (!authority) return;

  const target = decodeAuthority(authority);
  if (!target) {
    void vscode.window.showWarningMessage(
      "This devShell window's origin is unknown. Reopen the folder locally and pick a devShell again.",
    );
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  const cfg = readConfig(folder);
  const shells = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Nix: evaluating flake…",
      cancellable: true,
    },
    async (_p, token) => {
      const system = await currentSystem(cfg, target.flakeDir, token);
      return listDevShells(cfg, target.flakeDir, system, token);
    },
  );

  const picked = await pickDevShell(shells, target.devShell);
  if (!picked) return;
  if (picked.value === target.devShell) {
    void vscode.window.showInformationMessage(
      `Already running in devShell \`${picked.value}\`.`,
    );
    return;
  }

  const next = authorityFor({
    folder: target.folder,
    flakeDir: target.flakeDir,
    devShell: picked.value,
  });

  // Stop the server being left, so the next visit starts with the flake's current
  // extension set.
  const servers = new ServerManager(context.globalStorageUri, cfg);
  if (await servers.stop(storageKeyFor(authority))) {
    log.info(`stopped the server for devShell ${target.devShell}`);
  }

  const uri = vscode.Uri.from({
    scheme: "vscode-remote",
    authority: next,
    path: target.folder,
  });
  log.info(
    `switching devShell ${target.devShell} -> ${picked.value} (${next})`,
  );
  await vscode.commands.executeCommand("vscode.openFolder", uri, {
    forceReuseWindow: true,
  });
}

/**
 * A devShell's server starts with no extensions, so offer VS Code's own "install local
 * extensions" action, once per devShell.
 */
export async function offerExtensionSync(
  context: vscode.ExtensionContext,
): Promise<void> {
  const authority = vscode.env.remoteAuthority;
  if (!authority || !inDevShellWindow()) return;

  const key = `nixDevShell.extensionsOffered.${storageKeyFor(authority)}`;
  if (context.globalState.get<boolean>(key)) return;

  const dir = extensionsDirFor(
    path.join(context.globalStorageUri.fsPath, "remote"),
    storageKeyFor(authority),
  );
  const installed = await installedIn(dir);
  // VS Code installs Copilot into a fresh server on its own; it is not a sign that the
  // user's own extension set made it across.
  const own = installed.filter(
    (id) => !id.toLowerCase().startsWith("github.copilot"),
  );
  if (own.length > 0) {
    await context.globalState.update(key, true);
    return;
  }

  log.info(`devShell extension directory ${dir} has no user extensions yet`);
  const choice = await vscode.window.showInformationMessage(
    "This devShell window has its own extension set, and none of your extensions are installed in it yet.",
    "Install Local Extensions…",
    "Not now",
    "Don't ask again",
  );
  if (choice === "Install Local Extensions…") {
    await vscode.commands.executeCommand(
      "workbench.extensions.actions.installLocalExtensionsInRemote",
    );
    await context.globalState.update(key, true);
  } else if (choice === "Don't ask again") {
    await context.globalState.update(key, true);
  }
}
