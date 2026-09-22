import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as stub from "./activation-stub";
import * as ext from "../src/extension";
import { authorityFor } from "../src/remote/authority";
import pkg from "../package.json" with { type: "json" };

/** The commands package.json contributes, each of which must be registered. */
const CONTRIBUTED_COMMANDS = pkg.contributes.commands.map((c) => c.command);
import { afterAll, describe, expect, it } from "vitest";

/** Runs the real `activate()` against a fake editor; an activation crash disables everything. */

const storage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-act-"));
const context = {
  subscriptions: [] as { dispose(): void }[],
  globalStorageUri: { fsPath: storage },
  globalState: {
    get: () => undefined,
    update: async () => undefined,
  },
  environmentVariableCollection: {
    persistent: true,
    description: "",
    clear() {},
    replace() {},
    prepend() {},
    append() {},
    getScoped() {
      return this;
    },
  },
};

describe("activation", () => {
  it("activates in a plain window without throwing", async () => {
    stub.env.remoteAuthority = undefined;
    stub.workspace.workspaceFolders = undefined;
    await ext.activate(context as never);
    expect(context.subscriptions.length > 0, "activation registered nothing").toBe(true);
  });

  it("registers every contributed command", () => {
    for (const id of CONTRIBUTED_COMMANDS) {
      expect(stub.recorded.commands, `command ${id} was never registered`).toContain(id);
    }
  });

  it("registers the remote authority resolver when the API is present", () => {
    expect(stub.recorded.resolverPrefix).toEqual("nix-devshell");
    expect(stub.recorded.labelFormatter, "the resource label formatter should be registered").toBe(true);
  });

  it("publishes the context keys the menus depend on", () => {
    expect("nixDevShell.hasFlake" in stub.recorded.contexts, "hasFlake context was never set").toBe(true);
    expect("nixDevShell.inDevShell" in stub.recorded.contexts, "inDevShell context was never set").toBe(true);
  });

  it("activates inside a devShell window without throwing", async () => {
    ext.deactivate();
    stub.recorded.commands.length = 0;
    stub.env.remoteAuthority = "nix-devshell+deadbeefdeadbeef";
    const ctx2 = { ...context, subscriptions: [] as { dispose(): void }[] };
    await ext.activate(ctx2 as never);
    expect(stub.recorded.contexts["nixDevShell.inDevShell"]).toEqual(true);
    // All of them, in both scopes: registration must stay above the scope branch.
    for (const id of CONTRIBUTED_COMMANDS) {
      expect(
        stub.recorded.commands,
        `command ${id} is not registered inside a devShell window`,
      ).toContain(id);
    }
    ext.deactivate();
  });

  /**
   * A devShell window creates no sessions, even with a local flake present. Asserted on
   * the watchers, since a session is essentially a file watcher.
   */
  it("indexes no flakes inside a devShell window", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "nd-inshell-"));
    await fs.writeFile(path.join(work, "flake.nix"), "{ outputs = _: {}; }\n");
    ext.deactivate();
    stub.recorded.watchers.length = 0;

    // A window on a *local* devShell: the folder is a vscode-remote URI on our own
    // authority, and the flake it points at is a real directory on this disk.
    const authority = authorityFor({
      folder: work,
      flakeDir: work,
      devShell: "default",
    });
    stub.env.remoteAuthority = authority;
    stub.workspace.workspaceFolders = [
      {
        uri: stub.Uri.from({ scheme: "vscode-remote", authority, path: work }),
        name: "in-shell",
        index: 0,
      },
    ];

    const ctx = { ...context, subscriptions: [] as { dispose(): void }[] };
    try {
      await ext.activate(ctx as never);
      expect(stub.recorded.contexts["nixDevShell.inDevShell"]).toEqual(true);
      expect(
        stub.recorded.watchers.length,
        "a session was created inside a devShell window; it would index the flake again",
      ).toEqual(0);
      expect(
        stub.recorded.contexts["nixDevShell.hasFlake"],
        "no session means no flake to report, which is what gates the local-only commands",
      ).toEqual(false);
    } finally {
      ext.deactivate();
      stub.env.remoteAuthority = undefined;
      stub.workspace.workspaceFolders = undefined;
      await fs.rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  afterAll(async () => {
    stub.env.remoteAuthority = undefined;
    await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
  });
});
