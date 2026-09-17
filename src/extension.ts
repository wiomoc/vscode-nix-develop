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
  offerExtensionSync,
  showRemoteEnvironment,
  showRemoteExtensions,
  switchDevShellInRemoteWindow,
  sweepServerLocks,
} from "./remote";
import { DevShellSession, type SessionHost } from "./session";
import { registerResourceLabelFormatter, StatusBar } from "./ui";

/** One session per workspace folder, keyed by folder URI. */
const sessions = new Map<string, DevShellSession>();
let statusBar: StatusBar;
let host: SessionHost;

/**
 * Turns a devShell choice into an outcome.
 *
 * Selecting a devShell is the moment the user expects something to happen, and opening the
 * window against it is the only thing the choice is for, so it happens straight away --
 * nothing is stored and no second command is needed.
 */
function makeHost(): SessionHost {
  return {
    async chosen(session, picked) {
      if (!picked) return;
      const folder = session.workspaceFolder;
      await reopenInDevShell(folder, picked.value, flakeDir(folder, readConfig(folder)));
    },
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(initLog());

  registerResolver(context);
  // Housekeeping, not a precondition: nothing below waits for it.
  void sweepServerLocks(context);

  statusBar = new StatusBar();
  context.subscriptions.push(statusBar);

  host = makeHost();
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

    vscode.commands.registerCommand("nixDevelop.selectDevShell", async () => {
      // Inside a devShell window there are no local folders to build a session from; the
      // authority registry is what says which flake and folder this window came from.
      if (inDevShellWindow()) {
        await switchDevShellInRemoteWindow(context);
        return;
      }
      const session = await resolveSession("Select a devShell for which folder?");
      if (!session) return;
      const picked = await session.promptForDevShell();
      if (picked) await host.chosen(session, picked);
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

    vscode.commands.registerCommand("nixDevelop.reopenInDevShell", async () => {
      const folder = await pickFolder("Reopen which folder in a devShell?");
      if (!folder) return;

      const session = sessions.get(folder.uri.toString());
      if (!session) {
        // Previously this returned silently, leaving the command looking broken.
        void vscode.window.showWarningMessage(
          `No flake.nix was found for ${folder.name}. Check nixDevelop.flakeDirectory.`,
        );
        return;
      }
      const picked = await session.promptForDevShell();
      if (!picked) return;
      await reopenInDevShell(folder, picked.value, flakeDir(folder, readConfig(folder)));
    }),

    vscode.commands.registerCommand("nixDevelop.reopenLocally", () => reopenLocally()),

    vscode.commands.registerCommand("nixDevelop.remoteExtensions", () =>
      showRemoteExtensions(context),
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
    statusBar.set({
      kind: "active",
      label: target?.devShell ?? "devShell",
      summary: "the extension host is running inside this devShell",
    });
    void offerExtensionSync(context).catch((err) => log.error(err as Error));
    return;
  }

  // Fire-and-forget: this shows the status bar and may offer the picker, neither of which
  // should hold up the rest of the window. `nixDevelop.promptWhenUnset` is what silences
  // the offer for a workspace that does not want it.
  for (const session of sessions.values()) {
    void session.activate().catch((err) => log.error(err as Error));
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
    context.subscriptions.push(...registerResourceLabelFormatter(api))

    setResolverAvailable(true);
    log.info(`registered remote authority resolver for '${AUTHORITY_PREFIX}+*'`);
  } catch (err) {
    log.error(`registering the remote authority resolver failed: ${(err as Error).message}`);
  }
}

async function setContexts(): Promise<void> {
  await vscode.commands.executeCommand("setContext", `${SECTION}.hasFlake`, sessions.size > 0);
  await vscode.commands.executeCommand("setContext", `${SECTION}.inDevShell`, inDevShellWindow());
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
    const session = new DevShellSession(context, folder, statusBar, host);
    if (!session.hasFlake()) {
      session.dispose();
      continue;
    }
    log.info(`tracking flake in ${folder.uri.fsPath}`);
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

/**
 * Most workspaces have exactly one flake; only ask which folder when that is genuinely
 * ambiguous, preferring the folder of the active editor.
 */
async function resolveSession(prompt: string): Promise<DevShellSession | undefined> {
  if (sessions.size === 0) {
    void vscode.window.showWarningMessage("No flake.nix found in this workspace.");
    return undefined;
  }
  if (sessions.size === 1) return [...sessions.values()][0];

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    const session = folder && sessions.get(folder.uri.toString());
    if (session) return session;
  }

  const picked = await vscode.window.showQuickPick(
    [...sessions.values()].map((s) => ({
      label: s.workspaceFolder.name,
      description: s.workspaceFolder.uri.fsPath,
      session: s,
    })),
    { title: prompt, placeHolder: "Workspace folder" },
  );
  return picked?.session;
}

async function pickFolder(prompt: string): Promise<vscode.WorkspaceFolder | undefined> {
  const local = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file");
  if (local.length === 0) {
    void vscode.window.showWarningMessage("No local folder is open.");
    return undefined;
  }
  if (local.length === 1) return local[0];
  const picked = await vscode.window.showQuickPick(
    local.map((f) => ({ label: f.name, description: path.dirname(f.uri.fsPath), folder: f })),
    { title: prompt, placeHolder: "Workspace folder" },
  );
  return picked?.folder;
}
