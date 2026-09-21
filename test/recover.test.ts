import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nixErrorLocations } from "../src/nix";
import { errorSite, offerLocalRecovery, openPendingFile } from "../src/remote/recover";
import { eq, ok, test } from "./harness";
import { answers, recorded, workspace, Uri } from "./activation-stub";

/**
 * A context whose `globalState` actually stores things, because the handover between the
 * failed devShell window and the local one that replaces it *is* that store.
 */
function fakeContext(): {
  globalState: { get: () => unknown; update: (k: string, v: unknown) => Promise<void> };
} {
  let value: unknown;
  return {
    globalState: {
      get: () => value,
      update: async (_key: string, next: unknown) => {
        value = next;
      },
    },
  };
}

export async function run(): Promise<void> {
  console.log("\nrecovering from a flake that does not evaluate");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-recover-"));
  await fs.writeFile(path.join(dir, "flake.nix"), "{ }\n");
  await fs.mkdir(path.join(dir, "nix"), { recursive: true });
  await fs.writeFile(path.join(dir, "nix", "shell.nix"), "{ }\n");

  await test("reads the position out of what Nix printed", () => {
    eq(
      nixErrorLocations({
        stderr:
          "error: syntax error, unexpected end of file, expecting '}'\n" +
          "       at /w/proj/flake.nix:12:1:",
      }),
      [{ file: "/w/proj/flake.nix", line: 12, column: 1 }],
    );
  });

  await test("reads it through the escape codes of the pty path too", () => {
    eq(
      nixErrorLocations({
        stderr:
          "\u001b[31;1merror:\u001b[0m undefined variable 'mkShel'\r\n" +
          "       \u001b[34;1mat \u001b[0m/w/proj/flake.nix:7:5:\r\n",
      }),
      [{ file: "/w/proj/flake.nix", line: 7, column: 5 }],
    );
  });

  await test("a failure that names no position yields none", () => {
    eq(nixErrorLocations({ stderr: "error: could not find a flake.nix file" }), []);
  });

  await test("opens the innermost frame that is actually in the checkout", async () => {
    const site = await errorSite(
      [
        { file: path.join(dir, "flake.nix"), line: 3, column: 5 },
        { file: path.join(dir, "nix", "shell.nix"), line: 9, column: 2 },
      ],
      dir,
    );
    eq(site, { file: path.join(dir, "nix", "shell.nix"), line: 9, column: 2 });
  });

  await test("skips frames inside nixpkgs, which the user cannot fix", async () => {
    const site = await errorSite(
      [
        { file: path.join(dir, "flake.nix"), line: 3, column: 5 },
        { file: "/nix/store/aaaa-nixpkgs-src/lib/attrsets.nix", line: 100, column: 1 },
      ],
      dir,
    );
    eq(
      site,
      { file: path.join(dir, "flake.nix"), line: 3, column: 5 },
      "a store path with no counterpart in the checkout is not somewhere to send anyone",
    );
  });

  await test("maps the store copy of the flake back onto the checkout", async () => {
    const site = await errorSite(
      [{ file: "/nix/store/bbbb-source/nix/shell.nix", line: 4, column: 7 }],
      dir,
    );
    eq(site, { file: path.join(dir, "nix", "shell.nix"), line: 4, column: 7 });
  });

  await test("falls back to flake.nix when Nix named no position", async () => {
    eq(await errorSite([], dir), { file: path.join(dir, "flake.nix"), line: 1, column: 1 });
  });

  await test("offers nothing to open when there is no flake.nix at all", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "nd-recover-empty-"));
    eq(await errorSite([], empty), undefined);
    await fs.rm(empty, { recursive: true, force: true });
  });

  await test("the offer reopens locally and leaves the file for the next window", async () => {
    const context = fakeContext();
    recorded.errorMessages.length = 0;
    recorded.executed.length = 0;
    answers.errorMessage = (_m, items) => items[0];

    await offerLocalRecovery(
      context as never,
      { folder: dir, flakeDir: dir, devShell: "default" },
      [{ file: path.join(dir, "flake.nix"), line: 12, column: 1 }],
      "error: syntax error, unexpected end of file",
    );

    eq(recorded.errorMessages[0]?.items[0], "Reopen Locally and Edit flake.nix");
    ok(
      recorded.errorMessages[0]?.modal === true,
      "the window cannot open at all, so the offer is not something to miss in a corner",
    );
    ok(
      recorded.executed.includes("vscode.openFolder"),
      "the offer's whole point is getting back to a window that can show the file",
    );
    const pending = context.globalState.get() as { file: string; line: number };
    eq(pending.file, path.join(dir, "flake.nix"));
    eq(pending.line, 12);
  });

  await test("dismissing the offer leaves the window where it is", async () => {
    const context = fakeContext();
    recorded.executed.length = 0;
    answers.errorMessage = () => undefined;

    await offerLocalRecovery(
      context as never,
      { folder: dir, flakeDir: dir, devShell: "default" },
      [],
      "error: undefined variable 'mkShel'",
    );

    ok(
      !recorded.executed.includes("vscode.openFolder"),
      "nothing was chosen, so nothing happens",
    );
    eq(context.globalState.get(), undefined);
  });

  await test("the local window opens the file, at the line that failed", async () => {
    const context = fakeContext();
    answers.errorMessage = (_m, items) => items[0];
    await offerLocalRecovery(
      context as never,
      { folder: dir, flakeDir: dir, devShell: "default" },
      [{ file: path.join(dir, "flake.nix"), line: 12, column: 3 }],
      "error: syntax error",
    );

    recorded.shownDocuments.length = 0;
    workspace.workspaceFolders = [{ uri: Uri.file(dir) }];
    ok(await openPendingFile(context as never), "the pending open is this window's to act on");

    const shown = recorded.shownDocuments[0]?.options as {
      selection: { start: { line: number; character: number } };
    };
    eq(
      shown.selection.start,
      { line: 11, character: 2 },
      "Nix counts from one, VS Code from zero",
    );
    eq(await openPendingFile(context as never), false, "and it is consumed, not repeated");
  });

  await test("a request for another folder is dropped rather than opened here", async () => {
    const context = fakeContext();
    answers.errorMessage = (_m, items) => items[0];
    await offerLocalRecovery(
      context as never,
      { folder: dir, flakeDir: dir, devShell: "default" },
      [],
      "error: syntax error",
    );

    recorded.shownDocuments.length = 0;
    workspace.workspaceFolders = [{ uri: Uri.file(path.join(os.tmpdir(), "nd-elsewhere")) }];
    eq(await openPendingFile(context as never), false);
    eq(recorded.shownDocuments.length, 0);
  });

  answers.errorMessage = undefined;
  workspace.workspaceFolders = undefined;
  await fs.rm(dir, { recursive: true, force: true });
}
