import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as stub from "./activation-stub";
import * as ext from "../src/extension";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Runs the real `activate()` against a fake editor.
 *
 * This is the cheapest guard against the worst failure mode: an exception during
 * activation disables every feature at once, and neither typechecking nor the unit tests
 * execute that path.
 */

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
    for (const id of [
      "nixDevelop.selectDevShell",
      "nixDevelop.showEnvironment",
      "nixDevelop.showLog",
      "nixDevelop.reopenInDevShell",
      "nixDevelop.reopenLocally",
      "nixDevelop.remoteExtensions",
      "nixDevelop.killServer",
    ]) {
      expect(stub.recorded.commands, `command ${id} was never registered`).toContain(id);
    }
  });

  it("registers the remote authority resolver when the API is present", () => {
    expect(stub.recorded.resolverPrefix).toEqual("nix-develop");
    expect(stub.recorded.labelFormatter, "the resource label formatter should be registered").toBe(true);
  });

  it("publishes the context keys the menus depend on", () => {
    expect("nixDevelop.hasFlake" in stub.recorded.contexts, "hasFlake context was never set").toBe(true);
    expect("nixDevelop.inDevShell" in stub.recorded.contexts, "inDevShell context was never set").toBe(true);
  });

  it("activates inside a devShell window without throwing", async () => {
    ext.deactivate();
    stub.recorded.commands.length = 0;
    stub.env.remoteAuthority = "nix-develop+deadbeefdeadbeef";
    const ctx2 = { ...context, subscriptions: [] as { dispose(): void }[] };
    await ext.activate(ctx2 as never);
    expect(stub.recorded.contexts["nixDevelop.inDevShell"]).toEqual(true);
    expect(
      stub.recorded.commands.includes("nixDevelop.selectDevShell"),
      "switching devShells must stay available inside a devShell window",
    ).toBe(true);
    ext.deactivate();
  });

  afterAll(async () => {
    stub.env.remoteAuthority = undefined;
    await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
  });
});
