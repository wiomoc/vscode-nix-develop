import * as path from "node:path";
import * as vscode from "vscode";
import type { NixErrorLocation } from "../nix";
import { exists } from "../utils/fs-stat";
import { log } from "../utils/log";
import type { RemoteTarget } from "./authority";

/**
 * A file to open after reopening locally. In `globalState`, because the local window that
 * acts on it is a different window from the one that asked.
 */
const PENDING_KEY = "nixDevShell.openAfterReopen";

/** A pending request expires, so a reopen that never happened cannot surface later. */
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
 * When the flake does not evaluate, offer to reopen locally at the position Nix
 * reported. Not awaited by the resolve, which must reject immediately.
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
 * Open the file a previous window asked for, if this is the window it was meant for.
 * Returns whether one was opened, so the caller can skip the picker offer.
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
 * The innermost error position that lies in the user's checkout, else `flake.nix`.
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
 * Nix usually reports the store copy (`/nix/store/<hash>-source/...`), rooted at the
 * repository rather than the flake, so leading components are dropped until the rest
 * names an existing file in the checkout.
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
