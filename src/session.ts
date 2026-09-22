import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { flakeDir, readConfig, type NixDevShellConfig } from "./config";
import { detectDirenv } from "./direnv";
import { log } from "./utils/log";
import {
  currentSystem,
  type DevShell,
  listDevShells,
  primeCurrentSystem,
} from "./nix";
import { pickDevShell, type Selection, StatusBar } from "./ui";
import { exists } from "./utils/fs-stat";
import { reopenInDevShell } from "./remote";

const SYSTEM_KEY = "nixDevShell.currentSystem";

/** How long the flake has to sit still before its change is acted on. */
export const FLAKE_DEBOUNCE_MS = 750;

/**
 * One workspace folder's flake: discovers its devShells and asks which to use. It never
 * enters a shell itself; the choice opens a devShell window.
 */
export class DevShellSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private systemCache?: string;
  /** devShell names, keyed on the flake files they were derived from. */
  private shellCache?: { stamp: string; shells: DevShell[] };
  private warnedSlow = false;
  /** Whether `flake.nix` was there last time we looked; see `flakeChanged`. */
  private flakePresent: boolean;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly status: StatusBar,
    /** Called when this folder gained or lost its `flake.nix`, to refresh workspace-wide state. */
    private readonly onFlakeChanged: () => Promise<void>,
  ) {
    this.flakePresent = this.hasFlake();
    this.watchFlake();
  }

  get workspaceFolder(): vscode.WorkspaceFolder {
    return this.folder;
  }

  private cfg(): NixDevShellConfig {
    return readConfig(this.folder);
  }

  private dir(): string {
    return flakeDir(this.folder, this.cfg());
  }

  hasFlake(): boolean {
    return fs.existsSync(path.join(this.dir(), "flake.nix"));
  }

  /** The Nix system double, persisted across windows to spare a Nix call per picker. */
  private async system(
    cfg: NixDevShellConfig,
    token?: vscode.CancellationToken,
  ): Promise<string> {
    if (this.systemCache) return this.systemCache;
    primeCurrentSystem(this.context.globalState.get<string>(SYSTEM_KEY));
    this.systemCache = await currentSystem(cfg, this.dir(), token);
    void this.context.globalState.update(SYSTEM_KEY, this.systemCache);
    return this.systemCache;
  }

  // ---------------------------------------------------------------- selection

  /** The devShells this flake offers, cached against the flake files' mtime and size. */
  private async devShells(cfg: NixDevShellConfig): Promise<DevShell[]> {
    const stamp = await this.flakeStamp();
    if (this.shellCache && this.shellCache.stamp === stamp) {
      log.debug("devShell list served from cache");
      return this.shellCache.shells;
    }

    const started = Date.now();
    const shells = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Nix: evaluating flake…",
        cancellable: true,
      },
      async (_p, token) => {
        const system = await this.system(cfg, token);
        return listDevShells(cfg, this.dir(), system, token);
      },
    );

    const elapsed = Date.now() - started;
    log.info(
      `evaluated devShells in ${elapsed}ms: ${shells.map((s) => s.name).join(", ")}`,
    );
    if (elapsed > 5000) await this.warnSlowEvaluation(elapsed);

    this.shellCache = { stamp, shells };
    return shells;
  }

  /** Cheap identity for the flake inputs: mtime and size of flake.nix and flake.lock. */
  private async flakeStamp(): Promise<string> {
    const parts: string[] = [];
    for (const name of ["flake.nix", "flake.lock"]) {
      try {
        const s = await fsp.stat(path.join(this.dir(), name));
        parts.push(`${name}:${s.mtimeMs}:${s.size}`);
      } catch {
        parts.push(`${name}:absent`);
      }
    }
    return parts.join("|");
  }

  /** A slow evaluation usually means the flake is outside Git, so Nix copies everything. */
  private async warnSlowEvaluation(elapsed: number): Promise<void> {
    if (this.warnedSlow) return;
    this.warnedSlow = true;
    const dir = this.dir();
    const inGit = await exists(path.join(dir, ".git"));
    const hint = inGit
      ? "Make sure flake.nix and flake.lock are tracked by Git, so Nix can ignore untracked build directories."
      : `${dir} is not a Git repository, so Nix hashes every file in it on each evaluation. Running 'git init' and tracking flake.nix makes this dramatically faster.`;
    log.warn(
      `evaluating the flake took ${Math.round(elapsed / 1000)}s. ${hint}`,
    );
    const choice = await vscode.window.showWarningMessage(
      `Evaluating this flake took ${Math.round(elapsed / 1000)}s.`,
      "Why?",
      "Dismiss",
    );
    if (choice === "Why?") log.show();
  }

  /**
   * Ask which devShell to use. Nothing is stored; the window's authority records it. A
   * devShell named in `.envrc` is offered as the default.
   */
  async promptForDevShell(): Promise<Selection> {
    const cfg = this.cfg();
    if (!this.hasFlake()) {
      void vscode.window.showWarningMessage(
        `No flake.nix found in ${this.dir()}.`,
      );
      return undefined;
    }

    const shells = await this.devShells(cfg);
    const direnv = await detectDirenv(this.dir());
    return pickDevShell(shells, direnv.devShell);
  }

  // ----------------------------------------------------------------- activate

  /**
   * Update the status bar and offer the picker. A local window never has a devShell
   * selected; choosing one opens another window.
   */
  async activate(opts: { silent?: boolean } = {}): Promise<void> {
    if (!this.hasFlake()) return;
    this.status.set({ kind: "unset" });
    if (this.cfg().promptWhenUnset && !opts.silent) await this.offerSelection();
  }

  private async offerSelection(): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "This workspace has a flake.nix. Select a devShell to develop in?",
      "Select devShell",
      "Not now",
      "Never for this workspace",
    );
    if (choice === "Select devShell") {
      const picked = await this.promptForDevShell();
      if (picked) {
        const folder = this.workspaceFolder;
        await reopenInDevShell(
          folder,
          picked.value,
          flakeDir(folder, readConfig(folder)),
        );
      }
    } else if (choice === "Never for this workspace") {
      await vscode.workspace
        .getConfiguration("nixDevShell", this.folder.uri)
        .update("promptWhenUnset", false, vscode.ConfigurationTarget.Workspace);
    }
  }

  // -------------------------------------------------------------------- misc

  /** React to the flake or its lock changing, appearing or disappearing. */
  private watchFlake(): void {
    // Folder-wide, since `nixDevShell.flakeDirectory` can change without rebuilding the
    // watcher; events are filtered by `dir()` when they arrive.
    const pattern = new vscode.RelativePattern(
      this.folder,
      "**/flake.{nix,lock}",
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    let debounce: NodeJS.Timeout | undefined;
    const touched = new Set<string>();
    const onEvent = (uri: vscode.Uri) => {
      if (path.resolve(path.dirname(uri.fsPath)) !== path.resolve(this.dir()))
        return;
      touched.add(path.basename(uri.fsPath));
      // `nix flake update` rewrites the lock in several steps, and saving a flake can be
      // more than one event on its own, so settle before reacting to any of it.
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const names = [...touched].sort().join(" and ");
        touched.clear();
        void this.flakeChanged(names).catch((err) => log.error(err as Error));
      }, FLAKE_DEBOUNCE_MS);
    };

    this.disposables.push(
      // The watcher owns these, but disposing them explicitly keeps the handler from
      // running against a session the host has already dropped.
      watcher.onDidChange(onEvent),
      watcher.onDidCreate(onEvent),
      watcher.onDidDelete(onEvent),
      watcher,
      { dispose: () => clearTimeout(debounce) },
    );
  }

  /**
   * The flake was written: drop cached state. The picker is only offered when the flake
   * has just appeared, not on every edit.
   */
  private async flakeChanged(names: string): Promise<void> {
    this.shellCache = undefined;
    const present = this.hasFlake();
    const appeared = present && !this.flakePresent;
    const vanished = !present && this.flakePresent;
    this.flakePresent = present;

    const what = appeared ? "appeared" : vanished ? "is gone" : "changed";
    log.info(`${names} ${what} in ${this.dir()}; devShell list invalidated`);

    await this.onFlakeChanged();
    if (appeared) await this.activate();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
