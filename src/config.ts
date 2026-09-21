import * as vscode from "vscode";
import * as path from "node:path";

export interface NixDevelopConfig {
  flakeDirectory: string;
  promptWhenUnset: boolean;
  impure: boolean;
  extraArgs: string[];
  nixPath: string;
  buildTimeoutSeconds: number;
  /** See `nixDevelop.profile`, and `ProfileMode` in `profile.ts`. */
  profile: "persistent" | "none";
  /** See `nixDevelop.showBuildOutput`, and `BuildTerminal` in `utils/build-terminal.ts`. */
  showBuildOutput: BuildOutputMode;
  remote: RemoteConfig;
}

/**
 * When the terminal showing `nix develop` is brought into view.
 *
 * `never` is the only value that stops the output being collected at all; the other two
 * differ in whether the terminal is revealed up front or only once there is a failure to
 * read. The default is `onFailure`, because opening a window should not steal the panel,
 * but a devShell that does not evaluate should not fail silently either.
 */
export type BuildOutputMode = "never" | "onFailure" | "always";

export interface RemoteConfig {
  serverDownloadUrl: string;
  connectTimeoutSeconds: number;
  /**
   * Whether to point the server's bundled `node` at a glibc from nixpkgs with `patchelf`.
   *
   * Off is for a host that resolves `/lib64/ld-linux-*` on its own (`programs.nix-ld`, or
   * simply not NixOS), where the binary is left alone and no nixpkgs build is evaluated.
   * See `ServerManager.patchServerNode`.
   */
  patchServerLd: boolean;
}

/** Editor settings, as they appear in a `settings.json`. */
export type SettingsMap = Record<string, unknown>;

export const SECTION = "nixDevelop";

export function readConfig(scope: vscode.WorkspaceFolder | undefined): NixDevelopConfig {
  const c = vscode.workspace.getConfiguration(SECTION, scope?.uri);
  return {
    flakeDirectory: c.get<string>("flakeDirectory", ".") || ".",
    promptWhenUnset: c.get<boolean>("promptWhenUnset", true),
    impure: c.get<boolean>("impure", false),
    extraArgs: c.get<string[]>("extraArgs", []),
    nixPath: c.get<string>("nixPath", "nix") || "nix",
    buildTimeoutSeconds: c.get<number>("buildTimeoutSeconds", 1800),
    profile: c.get<"persistent" | "none">("profile", "persistent"),
    showBuildOutput: c.get<BuildOutputMode>("showBuildOutput", "always"),
    remote: {
      // Empty means "ask the running product"; see `ServerManager.downloadUrl`.
      serverDownloadUrl: c.get<string>("remote.serverDownloadUrl", ""),
      connectTimeoutSeconds: c.get<number>("remote.connectTimeoutSeconds", 180),
      patchServerLd: c.get<boolean>("remote.patchServerLd", true),
    },
  };
}

/** Absolute path of the directory holding flake.nix for this workspace folder. */
export function flakeDir(folder: vscode.WorkspaceFolder, cfg: NixDevelopConfig): string {
  return path.resolve(folder.uri.fsPath, cfg.flakeDirectory);
}

/**
 * Whether the `resolvers` proposed API was granted this session.
 *
 * Opening a devShell window is the only thing a selected devShell does, so without the
 * resolver there is nothing to fall back to and the user has to relaunch with
 * `--enable-proposed-api`. This flag is what lets the extension say so up front rather
 * than failing when they try to reopen.
 */
let resolverAvailable = false;

export function setResolverAvailable(value: boolean): void {
  resolverAvailable = value;
}

export function isResolverAvailable(): boolean {
  return resolverAvailable;
}
