import * as path from "node:path";
import * as vscode from "vscode";
import { readConfig, type NixDevShellConfig } from "../config";
import { ensureProfile } from "../profile";
import { BuildTerminal } from "../utils/build-terminal";
import { log } from "../utils/log";
import {
  currentSystem,
  isEvaluationError,
  nixErrorLocations,
  nixErrorSummary,
  toInstallable,
} from "../nix";
import { offerLocalRecovery } from "./recover";
import { decodeAuthority, storageKeyFor, type RemoteTarget } from "./authority";
import { extensionsDirFor } from "../provision/extensions";
import { ServerManager } from "./server";
import { patchServerNode as patchServerLd } from "./server-ld-patch";

/**
 * Resolves `vscode-remote://nix-devshell+<id>/...` authorities, like Dev Containers and
 * Remote-SSH do: VS Code calls `resolve()` on window startup and after every
 * disconnection, and gets back the port of a server running inside `nix develop`.
 *
 * Requires the `resolvers` proposed API (`--enable-proposed-api wiomoc.nix-devshell`).
 */
export class NixDevShellResolver implements vscode.RemoteAuthorityResolver {
  /** The terminal of the most recent build, kept only to retire it when the next starts. */
  private build?: BuildTerminal;

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
          // An evaluation failure is final, with Nix's own message: retrying via
          // `TemporarilyNotAvailable` would rebuild in a loop. Anything else is retried.
          if (isEvaluationError(err)) {
            const summary = nixErrorSummary(err) ?? message;
            // Not awaited: this resolve has to reject now, so VS Code stops waiting on a
            // window that is not coming, while the offer waits on the user instead.
            void offerLocalRecovery(
              this.context,
              target,
              nixErrorLocations(err),
              summary,
            ).catch((e) => log.warn(`offering to reopen locally failed: ${(e as Error).message}`));
            throw vscode.RemoteAuthorityResolverError.NotAvailable(summary, false);
          }
          throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(
            message,
          );
        }
      },
    );
  }

  /**
   * A devShell shares the local filesystem, so a remote URI's canonical form is the local
   * path. Otherwise features like recently opened see the same file twice.
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

    // Created only when there is no server to reuse. A failed attempt leaves its terminal
    // open; drop it so retries do not stack terminals.
    this.build?.dispose();
    const build =
      cfg.showBuildOutput === "never"
        ? undefined
        : new BuildTerminal(`nix develop: ${target.devShell}`);
    this.build = build;
    if (cfg.showBuildOutput === "always") build?.reveal();

    try {
      const resolved = await this.startFresh({
        cfg,
        target,
        commit,
        key,
        servers,
        progress,
        build,
      });
      build?.dispose();
      this.build = undefined;
      return resolved;
    } catch (err) {
      // The message itself goes to the notification and the log; what the terminal has
      // that neither does is the output that led up to it, so it is left standing.
      build?.reveal();
      throw err;
    }
  }

  /**
   * Prepare everything needed before entering the devShell (server on disk, a `node`
   * that can start, the installable, the directories), then `servers.start` it.
   */
  private async startFresh(opts: {
    cfg: NixDevShellConfig;
    target: RemoteTarget;
    commit: string;
    key: string;
    servers: ServerManager;
    progress: (m: string) => void;
    build: BuildTerminal | undefined;
  }): Promise<vscode.ResolverResult> {
    const { cfg, target, commit, key, servers, progress, build } = opts;

    progress("Preparing the VS Code server\u2026");
    const launcher = await servers.ensureServer(commit, progress);
    // Before anything runs the launcher: the provisioning script runs on the same `node`,
    // and it is the first thing the devShell will start.
    if (cfg.remote.patchServerLd) {
      await patchServerLd(cfg, launcher, target.flakeDir);
    } else {
      log.info(
        `nixDevShell.remote.patchServerLd is off; leaving node of ${launcher} as it is`,
      );
    }

    const system = await currentSystem(cfg, target.flakeDir);
    const installable = toInstallable(target.devShell, target.flakeDir, system);

    const root = path.join(this.context.globalStorageUri.fsPath, "remote");
    const extensionsDir = extensionsDirFor(root, key);
    const serverDataDir = path.join(root, "data", key);
    // One profile per devShell, beside the project; `undefined` means none.
    const profile = await ensureProfile(cfg, target.folder, target.devShell);

    const handle = await servers.start({
      key,
      commit,
      launcher,
      installable,
      flakeDir: target.flakeDir,
      profile,
      extensionsDir,
      serverDataDir,
      provisionScript: this.provisionScript(),
      progress,
      output: build
        ? {
            onOutput: (chunk) => build.write(chunk),
            // Nix draws for the terminal it is told about, so it is given this one: its
            // width now, and its width again whenever the user resizes the panel.
            tty: {
              columns: build.dimensions?.columns,
              rows: build.dimensions?.rows,
              onResize: build.onDidChangeDimensions,
            },
          }
        : {},
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
        NIX_DEVSHELL_SHELL: target.devShell,
        NIX_DEVSHELL_FLAKE: target.flakeDir,
      },
      isTrusted: true,
    };
  }

  /** `dist/provision.js`, shipped beside this bundle and run inside `nix develop`. */
  private provisionScript(): string {
    return path.join(this.context.extensionUri.fsPath, "dist", "provision.js");
  }
}
