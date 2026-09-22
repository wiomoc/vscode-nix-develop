import * as vscode from "vscode";
import * as path from "node:path";

export interface NixDevShellConfig {
  flakeDirectory: string;
  promptWhenUnset: boolean;
  impure: boolean;
  extraArgs: string[];
  nixPath: string;
  buildTimeoutSeconds: number;
  /** See `nixDevShell.profile`, and `ProfileMode` in `profile.ts`. */
  profile: "persistent" | "none";
  /** See `nixDevShell.showBuildOutput`, and `BuildTerminal` in `utils/build-terminal.ts`. */
  showBuildOutput: BuildOutputMode;
  remote: RemoteConfig;
}

/** When the terminal showing `nix develop` is revealed; `never` also stops collecting output. */
export type BuildOutputMode = "never" | "onFailure" | "always";

export interface RemoteConfig {
  serverDownloadUrl: string;
  connectTimeoutSeconds: number;
  /**
   * Whether to `patchelf` the server's bundled `node` onto a nixpkgs glibc. Off for hosts
   * that resolve `/lib64/ld-linux-*` themselves (nix-ld, non-NixOS). See `patchServerNode`.
   */
  patchServerLd: boolean;
}

export const SECTION = "nixDevShell";

export function readConfig(scope: vscode.WorkspaceFolder | undefined): NixDevShellConfig {
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
export function flakeDir(folder: vscode.WorkspaceFolder, cfg: NixDevShellConfig): string {
  return path.resolve(folder.uri.fsPath, cfg.flakeDirectory);
}

/** `publisher.name` from package.json, as `enable-proposed-api` must name it. */
export const EXTENSION_ID = "wiomoc.nix-devshell";

/** Whether the `resolvers` proposed API was granted, so a reopen can explain its absence. */
let resolverAvailable = false;

export function setResolverAvailable(value: boolean): void {
  resolverAvailable = value;
}

export function isResolverAvailable(): boolean {
  return resolverAvailable;
}
