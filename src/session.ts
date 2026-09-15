import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { flakeDir, readConfig, type NixDevelopConfig } from "./config";
import { detectDirenv } from "./direnv";
import { log } from "./utils/log";
import { currentSystem, type DevShell, listDevShells, primeCurrentSystem } from "./nix";
import { pickDevShell, type Selection, StatusBar } from "./ui";
import { exists } from "./utils/fs-stat";

const SYSTEM_KEY = "nixDevelop.currentSystem";

/**
 * How a session reports decisions that only the extension host can act on. A session knows
 * which devShell was chosen; only the host can open a window against it.
 */
export interface SessionHost {
  chosen(session: DevShellSession, picked: Selection): Promise<void>;
}

/**
 * Tracks the devShell selection for one workspace folder.
 *
 * A selected devShell is used by opening a window whose server runs inside `nix develop`,
 * so this class never builds or applies an environment itself: it discovers the available
 * shells, asks which one to use, and hands the answer off.
 */
export class DevShellSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private systemCache?: string;
  /** devShell names, keyed on the flake files they were derived from. */
  private shellCache?: { stamp: string; shells: DevShell[] };
  private warnedSlow = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder,
    private readonly status: StatusBar,
    private readonly host: SessionHost,
  ) {
    this.watchFlake();
  }

  get workspaceFolder(): vscode.WorkspaceFolder {
    return this.folder;
  }

  private cfg(): NixDevelopConfig {
    return readConfig(this.folder);
  }

  dir(): string {
    return flakeDir(this.folder, this.cfg());
  }

  hasFlake(): boolean {
    return fs.existsSync(path.join(this.dir(), "flake.nix"));
  }

  /**
   * The Nix system double, persisted across windows. It cannot change for a given machine,
   * and resolving it costs a Nix process on the path to showing the picker.
   */
  private async system(cfg: NixDevelopConfig, token?: vscode.CancellationToken): Promise<string> {
    if (this.systemCache) return this.systemCache;
    primeCurrentSystem(this.context.globalState.get<string>(SYSTEM_KEY));
    this.systemCache = await currentSystem(cfg, this.dir(), token);
    void this.context.globalState.update(SYSTEM_KEY, this.systemCache);
    return this.systemCache;
  }

  // ---------------------------------------------------------------- selection

  /**
   * The devShells this flake offers, cached against the flake files' mtime and size.
   *
   * Re-evaluating on every picker open is wasted work: the answer can only change when
   * flake.nix or flake.lock does.
   */
  private async devShells(cfg: NixDevelopConfig): Promise<DevShell[]> {
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
    log.info(`evaluated devShells in ${elapsed}ms: ${shells.map((s) => s.name).join(", ")}`);
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

  /**
   * A slow evaluation almost always means Nix is hashing the whole directory because the
   * flake is not in a Git work tree -- there is no source filtering, so build outputs and
   * dependency directories are copied every time.
   */
  private async warnSlowEvaluation(elapsed: number): Promise<void> {
    if (this.warnedSlow) return;
    this.warnedSlow = true;
    const dir = this.dir();
    const inGit = await exists(path.join(dir, ".git"));
    const hint = inGit
      ? "Make sure flake.nix and flake.lock are tracked by Git, so Nix can ignore untracked build directories."
      : `${dir} is not a Git repository, so Nix hashes every file in it on each evaluation. Running 'git init' and tracking flake.nix makes this dramatically faster.`;
    log.warn(`evaluating the flake took ${Math.round(elapsed / 1000)}s. ${hint}`);
    const choice = await vscode.window.showWarningMessage(
      `Evaluating this flake took ${Math.round(elapsed / 1000)}s.`,
      "Why?",
      "Dismiss",
    );
    if (choice === "Why?") log.show();
  }

  /**
   * Ask which devShell to use.
   *
   * The answer is not written anywhere: it takes effect by opening a window against it,
   * which is the host's job, and the window's authority is what remembers it afterwards.
   *
   * `.envrc` is the only place left where a project can state which shell it means, so a
   * devShell it names is offered as the marked entry. It is a default, not a decision --
   * the picker still lists everything.
   */
  async promptForDevShell(): Promise<Selection> {
    const cfg = this.cfg();
    if (!this.hasFlake()) {
      void vscode.window.showWarningMessage(`No flake.nix found in ${this.dir()}.`);
      return undefined;
    }

    const shells = await this.devShells(cfg);
    const direnv = await detectDirenv(this.dir());
    return pickDevShell(shells, direnv.devShell);
  }

  // ----------------------------------------------------------------- activate

  /**
   * Bring the status bar in line with the workspace and offer the next step.
   *
   * There is nothing to build here, and nothing to reconcile: a devShell is chosen by
   * opening a window against it, and the window's authority is the only record of that
   * choice. A local window is therefore always "no devShell selected".
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
      if (picked) await this.host.chosen(this, picked);
    } else if (choice === "Never for this workspace") {
      await vscode.workspace
        .getConfiguration("nixDevelop", this.folder.uri)
        .update("promptWhenUnset", false, vscode.ConfigurationTarget.Workspace);
    }
  }

  // -------------------------------------------------------------------- misc

  /** Re-offer when the flake or its lock changes underneath us. */
  private watchFlake(): void {
    const pattern = new vscode.RelativePattern(this.folder, "**/flake.{nix,lock}");
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    let debounce: NodeJS.Timeout | undefined;
    const onChange = (uri: vscode.Uri) => {
      if (path.dirname(uri.fsPath) !== this.dir()) return;
      // The set of devShells may have changed.
      this.shellCache = undefined;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        log.info(`${path.basename(uri.fsPath)} changed; devShell list invalidated`);
      }, 750);
    };
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    this.disposables.push(watcher, { dispose: () => clearTimeout(debounce) });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
