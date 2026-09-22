import * as path from "node:path";
import * as vscode from "vscode";
import {
  EXTENSION_ID,
  flakeDir,
  readConfig,
  SECTION,
  setResolverAvailable,
} from "./config";
import { initLog, log } from "./utils/log";
import {
  AUTHORITY_PREFIX,
  inDevShellWindow,
  killServer,
  NixDevShellResolver,
  decodeAuthority,
  reopenInDevShell,
  reopenLocally,
  restartDevShellWindow,
  watchDevShellFlake,
  offerExtensionSync,
  openPendingFile,
  switchDevShellInRemoteWindow,
  sweepServerLocks,
} from "./remote";
import { DevShellSession } from "./session";
import {
  registerResourceLabelFormatter,
  StatusBar,
  type StatusState,
} from "./ui";

/** One session per workspace folder, keyed by folder URI. */
const sessions = new Map<string, DevShellSession>();
let statusBar: StatusBar;

/**
 * A watched flake appeared or vanished. Contexts and the status bar are workspace-wide,
 * so they are recomputed across all folders here.
 */
async function flakeChanged(): Promise<void> {
  await setContexts();

  // A devShell window's status is owned by `activate` and left alone.
  if (!inDevShellWindow()) {
    statusBar.set(anyFlake() ? { kind: "unset" } : { kind: "idle" });
  }
}

/** True while at least one tracked folder actually has a flake.nix on disk. */
function anyFlake(): boolean {
  for (const session of sessions.values()) if (session.hasFlake()) return true;
  return false;
}

/**
 * Two kinds of window:
 *
 * - **local** (no remote authority): finds flakes per folder and offers the picker.
 *   Choosing a devShell opens a second window on a `nix-devshell+…` authority.
 * - **devShell** (`nix-devshell+…`): already runs inside the shell. It only shows which
 *   one and watches the flake for staleness.
 *
 * Shared by both, above the branch: the resolver (VS Code re-resolves on every
 * reconnect), the status bar, the commands, and sweeping stale server locks.
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  context.subscriptions.push(initLog());

  registerResolver(context);
  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);
  registerCommands(context);
  // Not awaited: nothing here is a precondition for anything below.
  void sweepServerLocks(context);

  if (inDevShellWindow()) {
    await activateInDevShellWindow(context);
  } else {
    await activateLocalWindow(context);
  }
}

/** A window running inside a devShell: show which one, and watch its flake. */
async function activateInDevShellWindow(
  context: vscode.ExtensionContext,
): Promise<void> {
  await setContexts();

  const authority = vscode.env.remoteAuthority ?? "";
  log.info(`running inside devShell window (${authority})`);
  // NIX_DEVSHELL_SHELL is set on the *remote* extension host; this extension is a UI
  // extension, so the name comes out of the authority itself.
  const target = decodeAuthority(authority);
  const active: StatusState = {
    kind: "active",
    label: target?.devShell ?? "devShell",
    summary: "the extension host is running inside this devShell",
  };
  statusBar.set(active);

  context.subscriptions.push(watchDevShellFlake(context, statusBar, active));
  void offerExtensionSync(context).catch((err) => log.error(err as Error));
}

/**
 * A local window: where a devShell is chosen. `syncSessions` must run before
 * `setContexts`, since `hasFlake` is derived from the sessions.
 */
async function activateLocalWindow(
  context: vscode.ExtensionContext,
): Promise<void> {
  syncSessions(context);
  await setContexts();

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      syncSessions(context);
      await setContexts();
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      for (const session of sessions.values()) {
        if (e.affectsConfiguration(SECTION, session.workspaceFolder.uri)) {
          // Refresh the status bar without offering the picker again.
          await session.activate({ silent: true });
        }
      }
    }),

    { dispose: disposeSessions },
  );

  // After a failed build, open the file at the position Nix complained about. Awaited:
  // it decides whether the sessions below stay silent.
  const recovering = await openPendingFile(context).catch((err) => {
    log.error(err as Error);
    return false;
  });

  // Not awaited. No picker offer right after a failed evaluation: that is what broke.
  for (const session of sessions.values()) {
    void session
      .activate({ silent: recovering })
      .catch((err) => log.error(err as Error));
  }
}

/**
 * Every contributed command, registered in both scopes so nothing hits "command not
 * found"; the `when` clauses in package.json keep the palette scoped.
 */
function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    // Only a devShell window can switch; a local window uses `Reopen in devShell`.
    vscode.commands.registerCommand("nixDevShell.selectDevShell", async () => {
      if (!inDevShellWindow()) {
        void vscode.window.showInformationMessage(
          "This window is not running inside a devShell — use “Reopen in devShell” to open one.",
        );
        return;
      }
      await switchDevShellInRemoteWindow(context);
    }),

    vscode.commands.registerCommand("nixDevShell.reopenInDevShell", async () => {
      const folder = await pickFolder("Reopen which folder in a devShell?");
      if (!folder) return;

      const session = sessions.get(folder.uri.toString());
      if (!session?.hasFlake()) {
        void vscode.window.showWarningMessage(
          `No flake.nix was found for ${folder.name}. Check nixDevShell.flakeDirectory.`,
        );
        return;
      }
      const picked = await session.promptForDevShell();
      if (!picked) return;
      await reopenInDevShell(
        folder,
        picked.value,
        flakeDir(folder, readConfig(folder)),
      );
    }),

    vscode.commands.registerCommand("nixDevShell.showLog", () => log.show()),

    vscode.commands.registerCommand("nixDevShell.reopenLocally", () =>
      reopenLocally(),
    ),

    vscode.commands.registerCommand("nixDevShell.restartDevShell", () =>
      restartDevShellWindow(context),
    ),

    vscode.commands.registerCommand("nixDevShell.killServer", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      await killServer(context, folder);
    }),
  );
}

export function deactivate(): void {
  disposeSessions();
}

/**
 * The `resolvers` proposed API is absent unless enabled in argv.json; the rest of the
 * extension still works without it.
 */
function registerResolver(context: vscode.ExtensionContext): void {
  const api = vscode.workspace as Partial<typeof vscode.workspace>;
  if (typeof api.registerRemoteAuthorityResolver !== "function") {
    log.info(
      "workspace.registerRemoteAuthorityResolver is unavailable; " +
        `add "enable-proposed-api": ["${EXTENSION_ID}"] to argv.json ` +
        "(Preferences: Configure Runtime Arguments) and restart VS Code " +
        "to enable devShell windows",
    );
    return;
  }
  try {
    context.subscriptions.push(
      api.registerRemoteAuthorityResolver(
        AUTHORITY_PREFIX,
        new NixDevShellResolver(context),
      ),
    );
    context.subscriptions.push(...registerResourceLabelFormatter(api));

    setResolverAvailable(true);
    log.info(
      `registered remote authority resolver for '${AUTHORITY_PREFIX}+*'`,
    );
  } catch (err) {
    log.error(
      `registering the remote authority resolver failed: ${(err as Error).message}`,
    );
  }
}

async function setContexts(): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    `${SECTION}.hasFlake`,
    anyFlake(),
  );
  await vscode.commands.executeCommand(
    "setContext",
    `${SECTION}.inDevShell`,
    inDevShellWindow(),
  );
}

function syncSessions(context: vscode.ExtensionContext): void {
  // A devShell window indexes no flakes: the authority names the shell and
  // `watchDevShellFlake` already watches the flake.
  if (inDevShellWindow()) {
    disposeSessions();
    return;
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  const seen = new Set<string>();

  for (const folder of folders) {
    const key = folder.uri.toString();
    seen.add(key);
    if (sessions.has(key)) continue;
    // UI extension: only local folders are real paths here.
    if (folder.uri.scheme !== "file") continue;
    // Kept without a flake.nix too, so the session can notice one appearing.
    const session = new DevShellSession(
      context,
      folder,
      statusBar,
      flakeChanged,
    );
    log.info(
      session.hasFlake()
        ? `tracking flake in ${folder.uri.fsPath}`
        : `watching ${folder.uri.fsPath} for a flake.nix`,
    );
    sessions.set(key, session);
  }

  for (const [key, session] of [...sessions]) {
    if (seen.has(key)) continue;
    session.dispose();
    sessions.delete(key);
  }
}

function disposeSessions(): void {
  for (const session of sessions.values()) session.dispose();
  sessions.clear();
}

async function pickFolder(
  prompt: string,
): Promise<vscode.WorkspaceFolder | undefined> {
  const local = (vscode.workspace.workspaceFolders ?? []).filter(
    (f) => f.uri.scheme === "file",
  );
  if (local.length === 0) {
    void vscode.window.showWarningMessage("No local folder is open.");
    return undefined;
  }
  if (local.length === 1) return local[0];
  const picked = await vscode.window.showQuickPick(
    local.map((f) => ({
      label: f.name,
      description: path.dirname(f.uri.fsPath),
      folder: f,
    })),
    { title: prompt, placeHolder: "Workspace folder" },
  );
  return picked?.folder;
}
