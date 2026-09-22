import * as fs from "node:fs";

/**
 * Logging for `dist/provision.js`, which has no `vscode`: lines go to stderr, which the
 * build terminal shows. `writeSync`, because the process exits right after the server is
 * up and a buffered write could be lost.
 */
function emit(line: string): void {
  try {
    fs.writeSync(2, `nix-devshell: ${line}\n`);
  } catch {
    /* the stream is gone; nothing useful is left to say about that */
  }
}

export const log = {
  info: (message: string) => emit(message),
  warn: (message: string) => emit(`warning: ${message}`),
};
