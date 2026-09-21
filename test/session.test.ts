import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { eq, ok, test } from "./harness";

/**
 * The flake watcher, driven through the fake editor.
 *
 * A file watcher is invisible when it is wrong: it fires into a handler that quietly
 * decides the event was not for it, and nothing anywhere says so. Firing the events by
 * hand is the only way to see whether the handler actually runs.
 */
export async function run(): Promise<void> {
  console.log("\nflake watcher");

  const stub = await import("./activation-stub");
  const { DevShellSession, FLAKE_DEBOUNCE_MS } = await import("../src/session");
  const { StatusBar } = await import("../src/ui");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nd-watch-"));
  const flake = path.join(root, "flake.nix");
  await fs.writeFile(flake, "{ outputs = _: {}; }\n");

  const context = {
    subscriptions: [],
    globalState: { get: () => undefined, update: async () => undefined },
  };
  const folder = { uri: stub.Uri.file(root), name: "watched", index: 0 };

  let notified = 0;
  const onFlakeChanged = async () => {
    notified++;
  };

  stub.recorded.watchers.length = 0;
  const session = new DevShellSession(
    context as never,
    folder as never,
    new StatusBar(),
    onFlakeChanged,
  );
  const watcher = stub.recorded.watchers.at(-1)!;

  /** Give the debounce room to fire, then let its async handler settle. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, FLAKE_DEBOUNCE_MS + 150));
  };

  await test("the session subscribes to create, change and delete", () => {
    ok(watcher !== undefined, "no file system watcher was created");
    eq(
      [watcher.changed.count(), watcher.created.count(), watcher.deleted.count()],
      [1, 1, 1],
      "a deleted flake.nix is a change too, so all three have to be handled",
    );
  });

  await test("a write to flake.nix reaches the host", async () => {
    notified = 0;
    watcher.changed.fire({ fsPath: flake });
    await settle();
    eq(notified, 1, "the host was never told the flake changed");
  });

  await test("a burst of events is one notification", async () => {
    notified = 0;
    watcher.changed.fire({ fsPath: flake });
    watcher.changed.fire({ fsPath: path.join(root, "flake.lock") });
    watcher.changed.fire({ fsPath: flake });
    await settle();
    eq(notified, 1, "`nix flake update` should not notify once per write");
  });

  await test("a flake in another directory is ignored", async () => {
    notified = 0;
    const nested = path.join(root, "vendor", "flake.nix");
    await fs.mkdir(path.dirname(nested), { recursive: true });
    watcher.changed.fire({ fsPath: nested });
    await settle();
    eq(notified, 0, "only the configured flake directory belongs to this session");
  });

  await test("deleting flake.nix is noticed", async () => {
    notified = 0;
    await fs.rm(flake);
    watcher.deleted.fire({ fsPath: flake });
    await settle();
    eq(notified, 1, "the host was never told the flake went away");
    eq(session.hasFlake(), false);
  });

  await test("a flake appearing offers the picker", async () => {
    notified = 0;
    stub.recorded.infoMessages.length = 0;
    await fs.writeFile(flake, "{ outputs = _: {}; }\n");
    watcher.created.fire({ fsPath: flake });
    await settle();
    eq(notified, 1, "the host was never told the flake appeared");
    ok(
      stub.recorded.infoMessages.some((m) => m.includes("flake.nix")),
      "a flake appearing in a watched folder should offer the devShell picker",
    );
  });

  await test("editing an existing flake does not nag", async () => {
    stub.recorded.infoMessages.length = 0;
    watcher.changed.fire({ fsPath: flake });
    await settle();
    eq(stub.recorded.infoMessages, [], "editing a flake should not pop a notification");
  });

  await test("disposing stops the handlers", async () => {
    notified = 0;
    session.dispose();
    watcher.changed.fire({ fsPath: flake });
    await settle();
    eq(notified, 0, "a disposed session must not keep reacting");
    ok(watcher.disposed, "the watcher itself should be disposed with the session");
  });

  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}
