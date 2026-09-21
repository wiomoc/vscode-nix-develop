import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { eq, ok, test } from "./harness";

/**
 * The watcher a devShell window runs against the flake it was built from.
 *
 * This one watches a real directory with `fs.watch`, so the test writes real files and
 * waits for real events: the whole point of it is behaviour the editor cannot be asked
 * about, and a hand-fired event would prove nothing about whether the watch is on the
 * right path.
 */
export async function run(): Promise<void> {
  console.log("\ndevShell flake watcher");

  const stub = await import("./activation-stub");
  const { authorityFor } = await import("../src/remote/authority");
  const { watchDevShellFlake, restartDevShellWindow } = await import("../src/remote/flake-watch");
  const { StatusBar } = await import("../src/ui");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nd-devshell-"));
  const flake = path.join(root, "flake.nix");
  const original = "{ outputs = _: { devShells.x86_64-linux.default = 1; }; }\n";
  await fs.writeFile(flake, original);

  const context = {
    subscriptions: [],
    globalStorageUri: { fsPath: path.join(root, "storage") },
    globalState: { get: () => undefined, update: async () => undefined },
  };

  const active = {
    kind: "active" as const,
    label: "default",
    summary: "the extension host is running inside this devShell",
  };

  stub.env.remoteAuthority = authorityFor({
    folder: root,
    flakeDir: root,
    devShell: "default",
  });

  const status = new StatusBar();
  const watch = watchDevShellFlake(context as never, status, active);

  /** Long enough for inotify to deliver, plus the watcher's own settle window. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 1400));
  };

  await test("a devShell window watches the flake it was built from", async () => {
    ok(typeof watch.dispose === "function", "no watcher was returned");
    eq(stub.recorded.infoMessages, [], "nothing should be reported before anything changes");
  });

  await test("editing the flake offers a restart", async () => {
    stub.recorded.infoMessages.length = 0;
    stub.recorded.statusText.length = 0;
    await fs.writeFile(flake, original.replace("= 1", "= 2"));
    await settle();
    ok(
      stub.recorded.infoMessages.some((m) => m.includes("still running the devShell")),
      `no restart offer was made; saw ${JSON.stringify(stub.recorded.infoMessages)}`,
    );
    ok(
      stub.recorded.statusText.some((t) => t.includes("$(warning)")),
      "the status bar should show the window is running an out-of-date devShell",
    );
  });

  await test("a second edit does not prompt again", async () => {
    stub.recorded.infoMessages.length = 0;
    await fs.writeFile(flake, original.replace("= 1", "= 3"));
    await settle();
    eq(stub.recorded.infoMessages, [], "the status bar carries this, not a prompt per save");
  });

  await test("putting the flake back clears the warning", async () => {
    stub.recorded.statusText.length = 0;
    await fs.writeFile(flake, original);
    await settle();
    ok(
      stub.recorded.statusText.some((t) => t === "$(package) default"),
      `the status bar should go back to normal; saw ${JSON.stringify(stub.recorded.statusText)}`,
    );
  });

  await test("rewriting identical content is not a change", async () => {
    stub.recorded.infoMessages.length = 0;
    await fs.writeFile(flake, original);
    await settle();
    eq(stub.recorded.infoMessages, [], "saving a file the editor did not change is not a change");
  });

  await test("a restart stops the server and reloads the window", async () => {
    stub.recorded.executed.length = 0;
    await restartDevShellWindow(context as never);
    ok(
      stub.recorded.executed.includes("workbench.action.reloadWindow"),
      "the window was never reloaded, so the resolver never re-ran",
    );
  });

  await test("a restart outside a devShell window says so", async () => {
    stub.env.remoteAuthority = undefined;
    stub.recorded.executed.length = 0;
    stub.recorded.infoMessages.length = 0;
    await restartDevShellWindow(context as never);
    eq(stub.recorded.executed, [], "a local window has no devShell server to restart");
    ok(stub.recorded.infoMessages.length === 1, "the user should be told why nothing happened");
  });

  await test("disposing stops watching", async () => {
    watch.dispose();
    stub.recorded.infoMessages.length = 0;
    await fs.writeFile(flake, original.replace("= 1", "= 4"));
    await settle();
    eq(stub.recorded.infoMessages, [], "a disposed watcher must not keep reacting");
  });

  stub.env.remoteAuthority = undefined;
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
