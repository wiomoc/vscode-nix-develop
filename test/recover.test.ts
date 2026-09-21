import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nixErrorLocations } from "../src/nix";
import { errorSite, offerLocalRecovery, openPendingFile } from "../src/remote/recover";
import { answers, recorded, workspace, Uri } from "./activation-stub";
import { afterAll, describe, expect, it } from "vitest";

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

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-recover-"));
await fs.writeFile(path.join(dir, "flake.nix"), "{ }\n");
await fs.mkdir(path.join(dir, "nix"), { recursive: true });
await fs.writeFile(path.join(dir, "nix", "shell.nix"), "{ }\n");

describe("recovering from a flake that does not evaluate", () => {
  it("reads the position out of what Nix printed", () => {
    expect(
      nixErrorLocations({
        stderr:
          "error: syntax error, unexpected end of file, expecting '}'\n" +
          "       at /w/proj/flake.nix:12:1:",
      }),
    ).toEqual([{ file: "/w/proj/flake.nix", line: 12, column: 1 }]);
  });

  it("reads it through the escape codes of the pty path too", () => {
    expect(
      nixErrorLocations({
        stderr:
          "\u001b[31;1merror:\u001b[0m undefined variable 'mkShel'\r\n" +
          "       \u001b[34;1mat \u001b[0m/w/proj/flake.nix:7:5:\r\n",
      }),
    ).toEqual([{ file: "/w/proj/flake.nix", line: 7, column: 5 }]);
  });

  it("a failure that names no position yields none", () => {
    expect(nixErrorLocations({ stderr: "error: could not find a flake.nix file" })).toEqual([]);
  });

  it("opens the innermost frame that is actually in the checkout", async () => {
    const site = await errorSite(
      [
        { file: path.join(dir, "flake.nix"), line: 3, column: 5 },
        { file: path.join(dir, "nix", "shell.nix"), line: 9, column: 2 },
      ],
      dir,
    );
    expect(site).toEqual({ file: path.join(dir, "nix", "shell.nix"), line: 9, column: 2 });
  });

  it("skips frames inside nixpkgs, which the user cannot fix", async () => {
    const site = await errorSite(
      [
        { file: path.join(dir, "flake.nix"), line: 3, column: 5 },
        { file: "/nix/store/aaaa-nixpkgs-src/lib/attrsets.nix", line: 100, column: 1 },
      ],
      dir,
    );
    expect(
      site,
      "a store path with no counterpart in the checkout is not somewhere to send anyone",
    ).toEqual({ file: path.join(dir, "flake.nix"), line: 3, column: 5 });
  });

  it("maps the store copy of the flake back onto the checkout", async () => {
    const site = await errorSite(
      [{ file: "/nix/store/bbbb-source/nix/shell.nix", line: 4, column: 7 }],
      dir,
    );
    expect(site).toEqual({ file: path.join(dir, "nix", "shell.nix"), line: 4, column: 7 });
  });

  it("falls back to flake.nix when Nix named no position", async () => {
    expect(await errorSite([], dir)).toEqual({ file: path.join(dir, "flake.nix"), line: 1, column: 1 });
  });

  it("offers nothing to open when there is no flake.nix at all", async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "nd-recover-empty-"));
    expect(await errorSite([], empty)).toEqual(undefined);
    await fs.rm(empty, { recursive: true, force: true });
  });

  it("the offer reopens locally and leaves the file for the next window", async () => {
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

    expect(recorded.errorMessages[0]?.items[0]).toEqual("Reopen Locally and Edit flake.nix");
    expect(
      recorded.errorMessages[0]?.modal === true,
      "the window cannot open at all, so the offer is not something to miss in a corner",
    ).toBe(true);
    expect(
      recorded.executed.includes("vscode.openFolder"),
      "the offer's whole point is getting back to a window that can show the file",
    ).toBe(true);
    const pending = context.globalState.get() as { file: string; line: number };
    expect(pending.file).toEqual(path.join(dir, "flake.nix"));
    expect(pending.line).toEqual(12);
  });

  it("dismissing the offer leaves the window where it is", async () => {
    const context = fakeContext();
    recorded.executed.length = 0;
    answers.errorMessage = () => undefined;

    await offerLocalRecovery(
      context as never,
      { folder: dir, flakeDir: dir, devShell: "default" },
      [],
      "error: undefined variable 'mkShel'",
    );

    expect(
      !recorded.executed.includes("vscode.openFolder"),
      "nothing was chosen, so nothing happens",
    ).toBe(true);
    expect(context.globalState.get()).toEqual(undefined);
  });

  it("the local window opens the file, at the line that failed", async () => {
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
    expect(await openPendingFile(context as never), "the pending open is this window's to act on").toBe(true);

    const shown = recorded.shownDocuments[0]?.options as {
      selection: { start: { line: number; character: number } };
    };
    expect(shown.selection.start, "Nix counts from one, VS Code from zero").toEqual({
      line: 11,
      character: 2,
    });
    expect(await openPendingFile(context as never), "and it is consumed, not repeated").toEqual(false);
  });

  it("a request for another folder is dropped rather than opened here", async () => {
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
    expect(await openPendingFile(context as never)).toEqual(false);
    expect(recorded.shownDocuments.length).toEqual(0);
  });

  afterAll(async () => {
    answers.errorMessage = undefined;
    workspace.workspaceFolders = undefined;
    await fs.rm(dir, { recursive: true, force: true });
  });
});
