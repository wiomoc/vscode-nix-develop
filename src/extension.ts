import * as path from "node:path";
import * as vscode from "vscode";
import { flakeDir, readConfig, SECTION, setResolverAvailable } from "./config";
import { initLog, log } from "./utils/log";
import {
  AUTHORITY_PREFIX,
  inDevShellWindow,
  killServer,
  NixDevelopResolver,
  decodeAuthority,
  reopenInDevShell,
  reopenLocally,
  restartDevShellWindow,
  watchDevShellFlake,
  offerExtensionSync,
  openPendingFile,
  showRemoteEnvironment,
  showRemoteExtensions,
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
 * A watched flake appeared or vanished. Only this module can say what the workspace as a
 * whole now looks like: the menus' `when` clauses and the single status bar are shared by
 * every folder, so one folder losing its flake does not mean the workspace has none.
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

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  context.subscriptions.push(initLog());

  registerResolver(context);
  // Housekeeping, not a precondition: nothing below waits for it.
  void sweepServerLocks(context);

  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

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
          // Silent: a settings change should refresh the status bar (flakeDirectory can
          // move which flake this folder means) without popping the picker offer.
          await session.activate({ silent: true });
        }
      }
    }),

    // Only a devShell window has a devShell to select: it is the one this window is
    // running in, and the authority registry is what says which flake and folder it came
    // from. Picking one from a local window means opening a window against it, which is
    // `Reopen in devShell` and nothing else.
    vscode.commands.registerCommand("nixDevelop.selectDevShell", async () => {
      if (!inDevShellWindow()) {
        void vscode.window.showInformationMessage(
          "This window is not running inside a devShell — use “Reopen in devShell” to open one.",
        );
        return;
      }
      await switchDevShellInRemoteWindow(context);
    }),

    vscode.commands.registerCommand("nixDevelop.reopenInDevShell", async () => {
      const folder = await pickFolder("Reopen which folder in a devShell?");
      if (!folder) return;

      const session = sessions.get(folder.uri.toString());
      if (!session?.hasFlake()) {
        // Previously this returned silently, leaving the command looking broken.
        void vscode.window.showWarningMessage(
          `No flake.nix was found for ${folder.name}. Check nixDevelop.flakeDirectory.`,
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

    vscode.commands.registerCommand("nixDevelop.showEnvironment", async () => {
      if (!inDevShellWindow()) {
        void vscode.window.showInformationMessage(
          "Reopen the folder in a devShell first — this window is not running inside one.",
        );
        return;
      }
      await showRemoteEnvironment();
    }),

    vscode.commands.registerCommand("nixDevelop.showLog", () => log.show()),

    vscode.commands.registerCommand("nixDevelop.reopenLocally", () =>
      reopenLocally(),
    ),

    vscode.commands.registerCommand("nixDevelop.remoteExtensions", () =>
      showRemoteExtensions(context),
    ),

    vscode.commands.registerCommand("nixDevelop.restartDevShell", () =>
      restartDevShellWindow(context),
    ),

    vscode.commands.registerCommand("nixDevelop.killServer", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      await killServer(context, folder);
    }),

    { dispose: disposeSessions },
  );

  // In a devShell window the server was launched inside `nix develop`, so the environment
  // is already correct everywhere; re-applying it locally would be wrong as well as
  // pointless, since this extension runs on the UI side.
  if (inDevShellWindow()) {
    const authority = vscode.env.remoteAuthority ?? "";
    log.info(`running inside devShell window (${authority})`);
    // NIX_DEVELOP_SHELL is set on the *remote* extension host; this extension is a UI
    // extension, so the name comes out of the authority itself.
    const target = decodeAuthority(authority);
    const active: StatusState = {
      kind: "active",
      label: target?.devShell ?? "devShell",
      summary: "the extension host is running inside this devShell",
    };
    statusBar.set(active);
    // The shell this window runs in was built when the window opened. Editing the flake
    // afterwards leaves every terminal and language server on the old toolchain, so the
    // window has to say so -- and offer the reload that is the only way to pick it up.
    context.subscriptions.push(watchDevShellFlake(context, statusBar, active));
    void offerExtensionSync(context).catch((err) => log.error(err as Error));
    return;
  }

  // A window that is here because a devShell could not be built has a file waiting to be
  // opened at the position Nix complained about. Awaited, because whether there was one
  // decides how the sessions below announce themselves.
  const recovering = await openPendingFile(context).catch((err) => {
    log.error(err as Error);
    return false;
  });

  // Fire-and-forget: this shows the status bar and may offer the picker, neither of which
  // should hold up the rest of the window. `nixDevelop.promptWhenUnset` is what silences
  // the offer for a workspace that does not want it -- and so does a flake that has just
  // failed to evaluate, where offering to pick a devShell is offering the thing that broke.
  for (const session of sessions.values()) {
    void session
      .activate({ silent: recovering })
      .catch((err) => log.error(err as Error));
  }
}

export function deactivate(): void {
  disposeSessions();
}

/**
 * The `resolvers` proposal is only granted when VS Code is started with
 * `--enable-proposed-api`, so the API may simply be absent. Failing softly keeps the rest
 * of the extension working in a stock editor.
 */
function registerResolver(context: vscode.ExtensionContext): void {
  const api = vscode.workspace as Partial<typeof vscode.workspace>;
  if (typeof api.registerRemoteAuthorityResolver !== "function") {
    log.info(
      "workspace.registerRemoteAuthorityResolver is unavailable; " +
        "start VS Code with --enable-proposed-api nix-develop.nix-develop to enable devShell windows",
    );
    return;
  }
  try {
    context.subscriptions.push(
      api.registerRemoteAuthorityResolver(
        AUTHORITY_PREFIX,
        new NixDevelopResolver(context),
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
  const folders = vscode.workspace.workspaceFolders ?? [];
  const seen = new Set<string>();

  for (const folder of folders) {
    const key = folder.uri.toString();
    seen.add(key);
    if (sessions.has(key)) continue;
    // This extension runs on the UI side, so in a remote window the folder URIs are not
    // local paths and none of the local filesystem logic applies.
    if (folder.uri.scheme !== "file") continue;
    // Kept even when the folder has no flake.nix yet: a session is little more than a file
    // watcher, and dropping the ones without a flake is what left nothing watching for a
    // flake appearing. `hasFlake()` is what decides whether a session has anything to
    // offer; see `anyFlake`.
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
