import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { eq, ok, test } from "./harness";

/**
 * Runs the real `activate()` against a fake editor.
 *
 * This is the cheapest guard against the worst failure mode: an exception during
 * activation disables every feature at once, and neither typechecking nor the unit tests
 * execute that path.
 */
export async function run(): Promise<void> {
  console.log("\nactivation");

  const stub = await import("./activation-stub");
  const ext = await import("../src/extension");

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

  await test("activates in a plain window without throwing", async () => {
    stub.env.remoteAuthority = undefined;
    stub.workspace.workspaceFolders = undefined;
    await ext.activate(context as never);
    ok(context.subscriptions.length > 0, "activation registered nothing");
  });

  await test("registers every contributed command", () => {
    for (const id of [
      "nixDevelop.selectDevShell",
      "nixDevelop.showEnvironment",
      "nixDevelop.showLog",
      "nixDevelop.reopenInDevShell",
      "nixDevelop.reopenLocally",
      "nixDevelop.remoteExtensions",
      "nixDevelop.killServer",
    ]) {
      ok(stub.recorded.commands.includes(id), `command ${id} was never registered`);
    }
  });

  await test("registers the remote authority resolver when the API is present", () => {
    eq(stub.recorded.resolverPrefix, "nix-develop");
    ok(stub.recorded.labelFormatter, "the resource label formatter should be registered");
  });

  await test("publishes the context keys the menus depend on", () => {
    ok("nixDevelop.hasFlake" in stub.recorded.contexts, "hasFlake context was never set");
    ok("nixDevelop.inDevShell" in stub.recorded.contexts, "inDevShell context was never set");
  });

  await test("activates inside a devShell window without throwing", async () => {
    ext.deactivate();
    stub.recorded.commands.length = 0;
    stub.env.remoteAuthority = "nix-develop+deadbeefdeadbeef";
    const ctx2 = { ...context, subscriptions: [] as { dispose(): void }[] };
    await ext.activate(ctx2 as never);
    eq(stub.recorded.contexts["nixDevelop.inDevShell"], true);
    ok(
      stub.recorded.commands.includes("nixDevelop.selectDevShell"),
      "switching devShells must stay available inside a devShell window",
    );
    ext.deactivate();
  });

  stub.env.remoteAuthority = undefined;
  await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
}
