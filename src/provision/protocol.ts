/**
 * The contract between the extension host (`dist/extension.js`) and the provisioning
 * script (`dist/provision.js`). Import-free: it is linked into both bundles.
 */

/**
 * Everything the script needs, as JSON in its single argument. Not the environment,
 * which the devShell may rewrite; the token is on the server's command line anyway.
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
 * The record of a running server, written by the script and read by `ServerManager` in
 * this and later windows. Valid exactly when the script exits zero.
 */
export interface LockFile {
  port: number;
  connectionToken: string;
  /** The server's own pid, which leads the process group `ServerManager.stop` signals. */
  pid: number;
  installable: string;
  commit: string;
  startedAt: number;
}
