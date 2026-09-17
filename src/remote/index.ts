import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { isResolverAvailable, readConfig } from "../config";
import { log } from "../utils/log";
import { captureEnv, currentSystem, listDevShells, toInstallable } from "../nix";
import { ensureProfile } from "../profile";
import { computeDelta, renderDelta } from "../environment";
import {
  AUTHORITY_PREFIX,
  authorityFor,
  decodeAuthority,
  storageKeyFor,
} from "./authority";
import { extensionsDirFor, installedIn } from "./extensions";
import { machineSettingsPath, parseJsonc } from "./settings";
import { ServerManager } from "./server";
import { pickDevShell } from "../ui";

export { AUTHORITY_PREFIX, authorityFor, decodeAuthority, storageKeyFor } from "./authority";
export {  NixDevelopResolver } from "./resolver";

/** True when this window is already running against one of our devShell servers. */
export function inDevShellWindow(): boolean {
  return (vscode.env.remoteAuthority ?? "").startsWith(`${AUTHORITY_PREFIX}+`);
}

/**
 * Reopen a folder in a window whose extension host runs inside the devShell.
 *
 * The heavy lifting happens later, in the resolver: this only encodes the target into an
 * authority and asks VS Code to open the folder against it.
 */
export async function reopenInDevShell(
  folder: vscode.WorkspaceFolder,
  devShell: string,
  flakeDir: string,
): Promise<void> {
  if (folder.uri.scheme !== "file") {
    void vscode.window.showWarningMessage("Only local folders can be reopened in a devShell.");
    return;
  }
  if (!devShell) {
    void vscode.window.showWarningMessage("Select a devShell first.");
    return;
  }
  // Opening the window is the only thing a devShell choice does, and it needs a proposed
  // API that stock VS Code grants only at launch. Checked here, at the single funnel for
  // opening one, rather than warning every window that merely has a flake.nix.
  if (!isResolverAvailable()) {
    const choice = await vscode.window.showWarningMessage(
      "Nix Develop needs the `resolvers` proposed API to open a devShell window. " +
        "Relaunch VS Code with --enable-proposed-api nix-develop.nix-develop.",
      "How?",
      "Dismiss",
    );
    if (choice === "How?") log.show();
    return;
  }

  const authority = authorityFor({ folder: folder.uri.fsPath, flakeDir, devShell });

  const uri = vscode.Uri.from({
    scheme: "vscode-remote",
    authority,
    path: folder.uri.path,
  });

  log.info(`reopening ${folder.uri.fsPath} at ${uri.toString()}`);
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceReuseWindow: true });
}

/** Go back to a normal local window. */
export async function reopenLocally(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage("No folder is open.");
    return;
  }
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    folder.uri.with({ scheme: "file", authority: "" }),
    { forceReuseWindow: true, forceLocalWindow: true },
  );
}

/**
 * Show which extensions this devShell's server has, and where each came from. This is the
 * view that makes per-devShell scoping legible: the list is the contents of the server's
 * `--extensions-dir`, which is chosen per devShell.
 */
export async function showRemoteExtensions(context: vscode.ExtensionContext): Promise<void> {
  const authority = vscode.env.remoteAuthority;
  if (!authority || !inDevShellWindow()) {
    void vscode.window.showInformationMessage(
      "This window is not running inside a devShell server. Use “Reopen in devShell” first.",
    );
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  const cfg = readConfig(folder);
  const key = storageKeyFor(authority);
  const root = path.join(context.globalStorageUri.fsPath, "remote");
  const dir = extensionsDirFor(root, key);
  const installed = await installedIn(dir);
  // Extensions the flake supplies are symlinks into the store rather than installs.
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const nixLinked = entries.filter((e) => e.isSymbolicLink()).map((e) => e.name).sort();

  // The devShell's settings live in the server's machine settings file, which is the same
  // "this devShell only" story as the extension directory above.
  const settingsFile = machineSettingsPath(path.join(root, "data", key));
  const settingsKeys = await fsp
    .readFile(settingsFile, "utf8")
    .then((text) => Object.keys(parseJsonc(text)).sort())
    .catch(() => [] as string[]);

  const remoteKind = vscode.extensions.all
    .filter((e) => !e.id.startsWith("vscode."))
    .map((e) => ({ id: e.id, kind: e.extensionKind === vscode.ExtensionKind.Workspace ? "workspace" : "ui" }));

  const lines = [
    `# Extensions for devShell '${process.env.NIX_DEVELOP_SHELL ?? authority}'`,
    "",
    `Server extensions directory:`,
    `  ${dir}`,
    `  (this devShell only)`,
    "",
    `## Installed in this devShell (${installed.length})`,
    ...(installed.length ? installed.map((i) => `  ${i}`) : ["  (none)"]),
    "",
    `## Declared in settings (nixDevelop.remote.extensions)`,
    ...(cfg.remote.extensions.length ? cfg.remote.extensions.map((i) => `  ${i}`) : ["  (none)"]),
    "",
    `## Supplied by the flake`,
    cfg.remote.extensionsFromFlake
      ? "  reading 'vscodeExtensions' and Nix-built extensions from the devShell"
      : "  disabled (nixDevelop.remote.extensionsFromFlake)",
    ...(nixLinked.length ? nixLinked.map((i) => `  ${i}  (built by Nix)`) : []),
    "",
    `## Settings applied to this devShell`,
    `  ${settingsFile}`,
    ...(settingsKeys.length ? settingsKeys.map((k) => `  ${k}`) : ["  (none)"]),
    cfg.remote.settingsFromFlake
      ? "  reading 'vscodeSettings' from the devShell"
      : "  disabled (nixDevelop.remote.settingsFromFlake)",
    "",
    `## Where extensions are running in this window`,
    ...remoteKind.map((e) => `  ${e.kind.padEnd(9)} ${e.id}`),
  ];

  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: lines.join("\n"),
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/**
 * Stop the server backing a devShell, so the next open starts a fresh one.
 *
 * Inside a devShell window the target is obvious: this window's own server. From a local
 * window there is nothing that records which shells have servers running, so it has to be
 * asked -- a server outlives the window that started it, which is exactly why this command
 * exists.
 */
export async function killServer(
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder | undefined,
): Promise<void> {
  const cfg = readConfig(folder);
  let key: string | undefined;

  if (inDevShellWindow() && vscode.env.remoteAuthority) {
    key = storageKeyFor(vscode.env.remoteAuthority);
  } else if (folder) {
    const flakeDir = path.resolve(folder.uri.fsPath, cfg.flakeDirectory);
    const shells = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Nix: evaluating flake…", cancellable: true },
      async (_p, token) => {
        const system = await currentSystem(cfg, flakeDir, token);
        return listDevShells(cfg, flakeDir, system, token);
      },
    );
    const picked = await pickDevShell(shells);
    if (!picked) return;
    key = storageKeyFor(
      authorityFor({ folder: folder.uri.fsPath, flakeDir, devShell: picked.value }),
    );
  }

  if (!key) {
    void vscode.window.showInformationMessage("No devShell server is associated with this window.");
    return;
  }

  const servers = new ServerManager(context.globalStorageUri, cfg);
  const stopped = await servers.stop(key);
  void vscode.window.showInformationMessage(
    stopped ? "devShell server stopped." : "No running devShell server was found.",
  );
}

/**
 * Clear out locks whose servers are gone.
 *
 * A devShell server outlives the window that started it and retires itself once it has
 * been idle, which means the moment it exits there is nothing of ours running to tidy up
 * after it -- the server is the process `nix develop` exec'd into, with no shell of ours
 * wrapped around it. The extension is the one that notices, so it does the tidying, at the
 * point a stale lock is most likely to be sitting there: the next time an editor starts.
 *
 * Nothing waits on this. A lock that outlives its server is inert -- every reader tests the
 * port before trusting it -- so sweeping is housekeeping, not a precondition for anything.
 */
export async function sweepServerLocks(context: vscode.ExtensionContext): Promise<void> {
  const cfg = readConfig(vscode.workspace.workspaceFolders?.[0]);
  try {
    await new ServerManager(context.globalStorageUri, cfg).sweep();
  } catch (err) {
    log.warn(`sweeping stale devShell server locks failed: ${(err as Error).message}`);
  }
}

/**
 * Switch devShells from inside a devShell window.
 *
 * Such a window has no local workspace folder -- its folders are `vscode-remote://` URIs --
 * so the usual per-folder session does not exist here. The authority registry is the only
 * record of which local flake this window came from, which is exactly what makes switching
 * possible without dropping back to a local window first. The new choice lives in the new
 * window's authority as well; nothing is written to the workspace.
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
    { location: vscode.ProgressLocation.Window, title: "Nix: evaluating flake…", cancellable: true },
    async (_p, token) => {
      const system = await currentSystem(cfg, target.flakeDir, token);
      return listDevShells(cfg, target.flakeDir, system, token);
    },
  );

  const picked = await pickDevShell(shells, target.devShell);
  if (!picked) return;
  if (picked.value === target.devShell) {
    void vscode.window.showInformationMessage(`Already running in devShell \`${picked.value}\`.`);
    return;
  }

  const next = authorityFor({
    folder: target.folder,
    flakeDir: target.flakeDir,
    devShell: picked.value,
  });

  // This window is the only thing using the server it is about to leave, and that server's
  // extension host still has the previous devShell's extensions activated. Shutting it down
  // releases it and guarantees the next visit to this devShell starts from the extension set
  // the flake currently declares, rather than whatever was loaded before.
  const servers = new ServerManager(context.globalStorageUri, cfg);
  if (await servers.stop(storageKeyFor(authority))) {
    log.info(`stopped the server for devShell ${target.devShell}`);
  }

  const uri = vscode.Uri.from({ scheme: "vscode-remote", authority: next, path: target.folder });
  log.info(`switching devShell ${target.devShell} -> ${picked.value} (${next})`);
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceReuseWindow: true });
}

/**
 * A devShell window loads `workspace`-kind extensions from the server's extension
 * directory, which starts out empty. Without the ones the user already has, language
 * servers and linters are simply absent -- which looks exactly like the devShell
 * environment having failed to apply, even though the toolchain is present.
 *
 * VS Code ships the right action for this; offer it once per devShell rather than
 * silently installing forty extensions.
 */
export async function offerExtensionSync(context: vscode.ExtensionContext): Promise<void> {
  const authority = vscode.env.remoteAuthority;
  if (!authority || !inDevShellWindow()) return;

  const key = `nixDevelop.extensionsOffered.${storageKeyFor(authority)}`;
  if (context.globalState.get<boolean>(key)) return;

  const dir = extensionsDirFor(
    path.join(context.globalStorageUri.fsPath, "remote"),
    storageKeyFor(authority),
  );
  const installed = await installedIn(dir);
  // VS Code installs Copilot into a fresh server on its own; it is not a sign that the
  // user's own extension set made it across.
  const own = installed.filter((id) => !id.toLowerCase().startsWith("github.copilot"));
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

/**
 * Render the environment a devShell window is actually running in.
 *
 * There is no local session here to ask, so the shell is re-read from the flake the
 * authority points at. Reporting "no devShell is active" inside a devShell window would be
 * plainly wrong.
 */
export async function showRemoteEnvironment(): Promise<void> {
  const authority = vscode.env.remoteAuthority;
  const target = authority ? decodeAuthority(authority) : undefined;
  if (!target) {
    void vscode.window.showWarningMessage("This devShell window's origin is unknown.");
    return;
  }

  const cfg = readConfig(vscode.workspace.workspaceFolders?.[0]);
  const text = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Nix: reading devShell environment…" },
    async () => {
      const system = await currentSystem(cfg, target.flakeDir);
      const installable = toInstallable(target.devShell, target.flakeDir, system);
      // The same GC root the window's server runs under, so reading the environment
      // re-enters the shell that is already built rather than rooting a second copy.
      const profile = await ensureProfile(cfg, target.folder, target.devShell);
      const capture = await captureEnv(cfg, installable, target.flakeDir, profile);
      return renderDelta(computeDelta(capture), target.devShell);
    },
  );

  const doc = await vscode.workspace.openTextDocument({ language: "shellscript", content: text });
  await vscode.window.showTextDocument(doc, { preview: true });
}
