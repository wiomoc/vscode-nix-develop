/**
 * What the extension host and the provisioning script agree on.
 *
 * The two run in different processes -- different *bundles*, even: the host is
 * `dist/extension.js` inside the editor, the script is `dist/provision.js` run by the
 * server's `node` inside `nix develop`. Nothing is shared between them at runtime, so
 * everything that crosses is declared here and nowhere else.
 *
 * Deliberately free of imports. This module is linked into both bundles, and the one that
 * runs inside the devShell must not pull `vscode` in behind it.
 */

/**
 * Everything the script needs, as its single argument.
 *
 * Serialised into argv rather than handed over in a file, because there is nothing here
 * worth a second file: the connection token already travels in this same `nix develop`
 * command line as the server's own `--connection-token`, so nothing is exposed that was
 * not exposed before. The environment would have been the other candidate and is the one
 * thing a devShell is entitled to rewrite from under us.
 */
export interface ProvisionOptions {
  /** The server launcher -- `bin/code-server` and its kin. */
  launcher: string;
  /** This devShell's extension directory, already created. */
  extensionsDir: string;
  /** This devShell's server data directory, already created. */
  serverDataDir: string;
  /** Where the flake is; the cwd for everything the script spawns. */
  flakeDir: string;
  /** Where to write the `LockFile` once the server is up. */
  lockFile: string;
  /** The token the host will hand VS Code to connect with. */
  connectionToken: string;
  /** Recorded in the lock: a client refuses a server built from a different commit. */
  commit: string;
  /** Recorded in the lock: which devShell this server is in. */
  installable: string;
  /** How long the server has to start accepting connections. */
  connectTimeoutSeconds: number;
  /** How long a single `--install-extension` may take. */
  installTimeoutSeconds: number;
}

/**
 * The record of a running server -- and the script's only answer to the host.
 *
 * The script writes it; `ServerManager` reads it, here and in every later window that
 * comes looking for a server to attach to. There is no second channel and no result file:
 * the script exits zero exactly when this file describes a server that is up, so the exit
 * code says whether to read it and the file says everything else.
 */
export interface LockFile {
  port: number;
  connectionToken: string;
  /**
   * The server's own pid -- not the script's.
   *
   * The script starts the server detached, so the server leads a session and a process
   * group of its own, and that group is what `ServerManager.stop` signals.
   */
  pid: number;
  installable: string;
  commit: string;
  startedAt: number;
}
