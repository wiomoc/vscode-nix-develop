import * as fs from "node:fs";

/**
 * Logging for the half of this extension that runs outside the extension host.
 *
 * Everything under `src/provision` is bundled a second time, as `dist/provision.js`, and
 * run by the server's `node` *inside* `nix develop`. There is no `vscode` module there and
 * no output channel to write to -- only the stream the extension host is already reading
 * to paint the build terminal. So these lines go to stderr and end up on screen beside
 * Nix's own output, which is where someone watching a devShell being built is looking.
 *
 * Nothing reads them back. The prefix is there to tell them from Nix's output at a glance,
 * not to be parsed: the script's actual answer is the lock file it writes and the exit
 * code it leaves.
 *
 * Written with `writeSync` rather than `console.error`, because the process exits as soon
 * as the server is up: a buffered write to a pipe can still be in flight at `exit`, and a
 * line that never arrives is a line the user cannot act on.
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
