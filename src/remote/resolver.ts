import * as path from "node:path";
import * as vscode from "vscode";
import { readConfig, type NixDevelopConfig } from "../config";
import { ensureProfile } from "../profile";
import { log } from "../utils/log";
import {
  captureEnv,
  currentSystem,
  toInstallable,
  type CaptureResult,
} from "../nix";
import { decodeAuthority, storageKeyFor, type RemoteTarget } from "./authority";
import {
  collectExtensions,
  collectNixExtensions,
  ensureInstalled,
  extensionsDirFor,
  mergedExtensions,
  syncNixExtensions,
} from "./extensions";
import {
  applyMachineSettings,
  collectSettings,
  mergedSettings,
} from "./settings";
import { ServerManager } from "./server";
import { patchServerNode as patchServerLd } from "./server-ld-patch";

/**
 * Resolves `vscode-remote://nix-develop+<id>/...` authorities.
 *
 * This is the mechanism Dev Containers and Remote-SSH use. VS Code calls `resolve()`
 * during startup of a remote window and again after every disconnection; the job is to
 * hand back a host and port where a VS Code *server* is listening. Starting that server
 * inside `nix develop` is what puts the remote extension host -- and with it terminals,
 * tasks, debuggers and language servers -- inside the devShell for real, rather than
 * approximating it by patching environment variables.
 *
 * Requires the `resolvers` proposed API, i.e. VS Code launched with
 * `--enable-proposed-api nix-develop.nix-develop`.
 */
export class NixDevelopResolver implements vscode.RemoteAuthorityResolver {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolve(
    authority: string,
    context: vscode.RemoteAuthorityResolverContext,
  ): Promise<vscode.ResolverResult> {
    log.info(`resolving ${authority} (attempt ${context.resolveAttempt})`);

    const target = decodeAuthority(authority);
    if (!target) {
      throw vscode.RemoteAuthorityResolverError.NotAvailable(
        `'${authority}' does not describe a devShell. Entries created by an older version ` +
          `carry an opaque id; reopen the folder locally and pick a devShell again.`,
        true,
      );
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Nix devShell: ${target.devShell}`,
      },
      async (progress) => {
        try {
          return await this.startOrAttach(authority, target, (m) =>
            progress.report({ message: m }),
          );
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          log.error(`resolving ${authority} failed: ${message}`);
          // TemporarilyNotAvailable makes VS Code offer a retry rather than dropping the
          // window straight into an unrecoverable error state.
          throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(
            message,
          );
        }
      },
    );
  }

  /**
   * Remote and local URIs address the same files here -- a devShell shares the machine's
   * filesystem -- so the canonical form of a remote URI is simply the local path. Without
   * this, features that compare URIs across the boundary (recently opened, source control)
   * treat the same file as two different ones.
   */
  getCanonicalURI(uri: vscode.Uri): vscode.ProviderResult<vscode.Uri> {
    return uri.with({ scheme: "file", authority: "" });
  }

  private async startOrAttach(
    authority: string,
    target: RemoteTarget,
    progress: (m: string) => void,
  ): Promise<vscode.ResolverResult> {
    const folder = vscode.Uri.file(target.folder);
    const cfg = readConfig(
      vscode.workspace.getWorkspaceFolder(folder) ?? undefined,
    );
    const commit = vscode.env.appCommit;
    if (!commit) {
      throw new Error(
        "This build of VS Code reports no commit, so no matching server can be fetched.",
      );
    }

    const key = storageKeyFor(authority);
    const servers = new ServerManager(this.context.globalStorageUri, cfg);

    const running = await servers.findRunning(key, commit);
    if (running) {
      return new vscode.ResolvedAuthority(
        "127.0.0.1",
        running.port,
        running.connectionToken,
      );
    }

    progress("Preparing the VS Code server…");
    const launcher = await servers.ensureServer(commit, progress);
    // Before anything runs the launcher: installing extensions starts the same `node`.
    if (cfg.remote.patchServerLd) {
      await patchServerLd(cfg, launcher, target.flakeDir);
    } else {
      log.info(
        `nixDevelop.remote.patchServerLd is off; leaving node of ${launcher} as it is`,
      );
    }

    const system = await currentSystem(cfg, target.flakeDir);
    const installable = toInstallable(target.devShell, target.flakeDir, system);

    const root = path.join(this.context.globalStorageUri.fsPath, "remote");
    const extensionsDir = extensionsDirFor(root, key);
    const serverDataDir = path.join(root, "data", key);
    // One profile per devShell, shared by everything that enters it: reading the
    // environment and running the server are the same shell, so they are the same GC root.
    // It lives beside the project rather than in global storage, and it stays there --
    // see `ensureProfile`. `undefined` is `nixDevelop.profile: none`, or a folder that
    // could not be written to.
    const profile = await ensureProfile(cfg, target.folder, target.devShell);

    // One capture serves both: the extensions the devShell declares and the settings it
    // declares are two attributes of the same shell.
    const capture = await this.readDevShellEnv({
      cfg,
      target,
      installable,
      profile,
      progress,
    });

    await this.installDeclaredExtensions({
      cfg,
      launcher,
      extensionsDir,
      serverDataDir,
      capture,
      target,
      progress,
    });

    await this.applyDeclaredSettings({
      cfg,
      serverDataDir,
      devShellEnv: capture?.inside ?? {},
    });

    const handle = await servers.start({
      key,
      commit,
      launcher,
      installable,
      flakeDir: target.flakeDir,
      profile,
      extensionsDir,
      serverDataDir,
      progress,
    });

    return {
      ...new vscode.ResolvedAuthority(
        "127.0.0.1",
        handle.port,
        handle.connectionToken,
      ),
      // The server already inherits the devShell, since it was started inside `nix develop`.
      // These are markers so the remote window can tell what it is running in.
      extensionHostEnv: {
        NIX_DEVELOP_SHELL: target.devShell,
        NIX_DEVELOP_FLAKE: target.flakeDir,
      },
      isTrusted: true,
    };
  }

  /**
   * Read the devShell environment, once, for everything that is declared in it.
   *
   * Building the shell is what the server start would do anyway, and the result is cached
   * by Nix, so this costs one extra evaluation rather than one extra build. A failure is
   * not fatal: the window still opens, only without what the flake declared.
   */
  private async readDevShellEnv(opts: {
    cfg: NixDevelopConfig;
    target: RemoteTarget;
    installable: string;
    profile: string | undefined;
    progress: (m: string) => void;
  }): Promise<CaptureResult | undefined> {
    if (
      !opts.cfg.remote.extensionsFromFlake &&
      !opts.cfg.remote.settingsFromFlake
    )
      return undefined;
    try {
      opts.progress("Reading what the devShell declares for the editor…");
      return await captureEnv(
        opts.cfg,
        opts.installable,
        opts.target.flakeDir,
        opts.profile,
      );
    } catch (err) {
      log.warn(
        `could not read the devShell environment: ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Resolve the devShell's declared extensions and install the missing ones.
   */
  private async installDeclaredExtensions(opts: {
    cfg: NixDevelopConfig;
    launcher: string;
    extensionsDir: string;
    serverDataDir: string;
    capture: CaptureResult | undefined;
    target: RemoteTarget;
    progress: (m: string) => void;
  }): Promise<void> {
    const fromFlake = opts.cfg.remote.extensionsFromFlake
      ? opts.capture
      : undefined;

    // Extensions the devShell supplies as Nix packages are already built: they only need
    // linking into the extension directory, with no download and no version drift.
    if (fromFlake) {
      const nixExtensions = await collectNixExtensions(fromFlake);
      if (nixExtensions.length > 0) {
        opts.progress(
          `Linking ${nixExtensions.length} Nix-built extension(s)\u2026`,
        );
        log.info(
          `devShell supplies via Nix: ${nixExtensions.map((e) => e.id).join(", ")}`,
        );
      }
      await syncNixExtensions(opts.extensionsDir, nixExtensions).catch((err) =>
        log.warn(
          `could not link Nix-built extensions: ${(err as Error).message}`,
        ),
      );
    }

    const sources = collectExtensions(opts.cfg, fromFlake?.inside ?? {});
    const wanted = mergedExtensions(sources);
    if (wanted.length === 0) return;

    log.info(
      `devShell extensions -- from flake: [${sources.fromFlake.join(", ")}], ` +
        `from settings: [${sources.fromSettings.join(", ")}]`,
    );

    const { failed } = await ensureInstalled({
      cfg: opts.cfg,
      launcher: opts.launcher,
      extensionsDir: opts.extensionsDir,
      serverDataDir: opts.serverDataDir,
      flakeDir: opts.target.flakeDir,
      wanted,
      progress: opts.progress,
    });
    if (failed.length > 0) {
      void vscode.window.showWarningMessage(
        `Could not install into the devShell: ${failed.join(", ")}. See the Nix Develop log.`,
      );
    }
  }

  /**
   * Write the devShell's declared editor settings into the server's machine settings.
   *
   * This runs before the server starts, so the extension host reads them on its first pass
   * rather than reloading a moment later. As with extensions, a failure here is logged and
   * the window still opens: a bad `vscodeSettings` attribute should cost the settings, not
   * the devShell.
   */
  private async applyDeclaredSettings(opts: {
    cfg: NixDevelopConfig;
    serverDataDir: string;
    devShellEnv: Record<string, string>;
  }): Promise<void> {
    const sources = collectSettings(opts.cfg, opts.devShellEnv);
    const values = mergedSettings(sources);
    const fromFlake = Object.keys(sources.fromFlake);
    if (fromFlake.length > 0 || Object.keys(sources.fromSettings).length > 0) {
      log.info(
        `devShell settings -- from flake: [${fromFlake.join(", ")}], ` +
          `from settings: [${Object.keys(sources.fromSettings).join(", ")}]`,
      );
    }
    await applyMachineSettings(opts.serverDataDir, values).catch((err) =>
      log.warn(
        `could not apply the devShell's settings: ${(err as Error).message}`,
      ),
    );
  }
}
