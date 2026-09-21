import * as path from "node:path";
import * as vscode from "vscode";
import type { NixErrorLocation } from "../nix";
import { exists } from "../utils/fs-stat";
import { log } from "../utils/log";
import type { RemoteTarget } from "./authority";

/**
 * Where the request to open a file survives the window it was made in.
 *
 * Reopening locally replaces the window, so the extension host making the offer is not the
 * one that can act on it. `globalState` is the only thing both see: the devShell window has
 * no local workspace, so there is no workspace state to write to, and the window that comes
 * back is a different one either way.
 */
const PENDING_KEY = "nixDevelop.openAfterReopen";

/**
 * How long a pending request stays worth acting on.
 *
 * It is consumed by the next local activation, which normally follows within seconds. If
 * the reopen never happened -- the command failed, the user closed the window -- the
 * request must not surface weeks later in an unrelated window, so it expires.
 */
const PENDING_TTL_MS = 5 * 60_000;

interface PendingOpen {
  /** The workspace folder the request was made for; the guard against opening it elsewhere. */
  folder: string;
  file: string;
  line: number;
  column: number;
  at: number;
}

/**
 * Offer the way out of a devShell window whose flake does not evaluate.
 *
 * The window cannot open: there is no server, because there is no shell to start one in.
 * What the user needs is the file that does not evaluate, and the only editor that can show
 * it is a local one -- a devShell window's files are served by the server that failed to
 * start. So the offer is a single action that does both, and the file it opens is the one
 * Nix pointed at rather than `flake.nix` by default.
 *
 * Fire-and-forget by design: the resolve this belongs to must reject now, so VS Code shows
 * its own failure UI, while this waits on the user.
 */
export async function offerLocalRecovery(
  context: vscode.ExtensionContext,
  target: RemoteTarget,
  locations: NixErrorLocation[],
  summary: string,
): Promise<void> {
  const site = await errorSite(locations, target.flakeDir);

  const where = site ? path.basename(site.file) : undefined;
  const choice = await vscode.window.showErrorMessage(
    `The flake for devShell '${target.devShell}' does not evaluate, so this window has no ` +
      `devShell to open in. ${trimForNotification(summary)}`,
    { modal: true },
    where ? `Reopen Locally and Edit ${where}` : "Reopen Locally",
    "Show Log",
  );
  if (choice === "Show Log") {
    log.show();
    return;
  }
  if (!choice) return;

  if (site) {
    await context.globalState.update(PENDING_KEY, {
      folder: target.folder,
      file: site.file,
      line: site.line,
      column: site.column,
      at: Date.now(),
    } satisfies PendingOpen);
    log.info(
      `reopening ${target.folder} locally, at ${site.file}:${site.line}`,
    );
  } else {
    log.info(`reopening ${target.folder} locally`);
  }
  await reopenFolderLocally(vscode.Uri.file(target.folder));
}

/** Put a folder back in an ordinary local window, replacing this one. */
export async function reopenFolderLocally(folder: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.openFolder",
    folder.with({ scheme: "file", authority: "" }),
    { forceReuseWindow: true, forceLocalWindow: true },
  );
}

/**
 * Show the file a previous window asked for, if this is the window it asked for it in.
 *
 * Returns whether anything was opened, which is also the answer to whether this activation
 * is the tail of a failed devShell open -- the caller uses it to stay quiet about picking a
 * devShell, since the user is here to fix the flake, not to choose a shell again.
 */
export async function openPendingFile(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  const pending = context.globalState.get<PendingOpen>(PENDING_KEY);
  if (!pending) return false;
  // Consumed whether or not it is acted on: a request that does not apply to this window
  // will not apply to a later one either, and leaving it would make it fire eventually.
  await context.globalState.update(PENDING_KEY, undefined);

  if (Date.now() - pending.at > PENDING_TTL_MS) {
    log.info(`ignoring a stale request to open ${pending.file}`);
    return false;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (
    !folders.some(
      (f) => f.uri.scheme === "file" && samePath(f.uri.fsPath, pending.folder),
    )
  ) {
    log.info(`${pending.folder} is not open here; not opening ${pending.file}`);
    return false;
  }

  try {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(pending.file),
    );
    // Nix counts from one, VS Code from zero.
    const at = new vscode.Position(
      Math.max(0, pending.line - 1),
      Math.max(0, pending.column - 1),
    );
    await vscode.window.showTextDocument(doc, {
      selection: new vscode.Range(at, at),
    });
    log.info(
      `opened ${pending.file}:${pending.line}, where the evaluation failed`,
    );
    return true;
  } catch (err) {
    log.warn(`could not open ${pending.file}: ${(err as Error).message}`);
    return false;
  }
}

/**
 * The file in the user's checkout to put the cursor in.
 *
 * Walked innermost-first, because that is the frame that actually failed, and the outer
 * frames are usually only `while evaluating the attribute 'devShells'`. Positions that do
 * not land in the checkout are skipped rather than opened: an error inside nixpkgs is real,
 * but its file is a read-only store path that the user cannot fix and did not write.
 *
 * `flake.nix` itself is the fallback, so the offer still has somewhere to go when Nix named
 * no position at all -- a missing attribute, or a flake it never managed to read.
 */
export async function errorSite(
  locations: NixErrorLocation[],
  flakeDir: string,
): Promise<NixErrorLocation | undefined> {
  for (const loc of [...locations].reverse()) {
    const file = await inCheckout(loc.file, flakeDir);
    if (file) return { ...loc, file };
  }
  const fallback = path.join(flakeDir, "flake.nix");
  return (await exists(fallback))
    ? { file: fallback, line: 1, column: 1 }
    : undefined;
}

/**
 * Map a path Nix printed onto the checkout, or `undefined` if it is not part of it.
 *
 * Nix evaluates the *store copy* of a flake in a Git work tree, so the path it reports is
 * usually `/nix/store/<hash>-source/flake.nix` rather than the file the user has open. The
 * copy keeps the layout, so the part after the store path's own directory is the path
 * within the flake -- which is what makes it recoverable at all.
 *
 * What the store copy is rooted at is the *repository*, though, not necessarily the flake:
 * `nixDevelop.flakeDirectory` pointing at a subdirectory makes Nix copy the work tree and
 * address the flake within it, so the reported path carries that subdirectory twice over.
 * Hence the leading components are dropped one at a time until something matches -- and
 * nothing is returned unless the file it names really is in the checkout.
 */
async function inCheckout(
  file: string,
  flakeDir: string,
): Promise<string | undefined> {
  const dir = path.resolve(flakeDir);
  const abs = path.resolve(file);
  if (abs === dir || abs.startsWith(dir + path.sep)) {
    return (await exists(abs)) ? abs : undefined;
  }
  const store = /^\/nix\/store\/[^/]+\/(.+)$/.exec(abs);
  if (!store) return undefined;
  const parts = store[1].split("/");
  for (let i = 0; i < parts.length; i++) {
    const mapped = path.join(dir, ...parts.slice(i));
    if (await exists(mapped)) return mapped;
  }
  return undefined;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** A notification is one paragraph; Nix's trace is not. */
function trimForNotification(summary: string): string {
  const s = summary.trim();
  return s.length > 240 ? `${s.slice(0, 239)}…` : s;
}
