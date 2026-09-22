import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as stub from "./activation-stub";
import { DevShellSession, FLAKE_DEBOUNCE_MS } from "../src/session";
import { StatusBar } from "../src/ui";
import { afterAll, describe, expect, it } from "vitest";

/** The flake watcher, with events fired by hand through the fake editor. */

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

describe("flake watcher", () => {
  it("the session subscribes to create, change and delete", () => {
    expect(watcher !== undefined, "no file system watcher was created").toBe(true);
    expect(
      [watcher.changed.count(), watcher.created.count(), watcher.deleted.count()],
      "a deleted flake.nix is a change too, so all three have to be handled",
    ).toEqual([1, 1, 1]);
  });

  it("a write to flake.nix reaches the host", async () => {
    notified = 0;
    watcher.changed.fire({ fsPath: flake });
    await settle();
    expect(notified, "the host was never told the flake changed").toEqual(1);
  });

  it("a burst of events is one notification", async () => {
    notified = 0;
    watcher.changed.fire({ fsPath: flake });
    watcher.changed.fire({ fsPath: path.join(root, "flake.lock") });
    watcher.changed.fire({ fsPath: flake });
    await settle();
    expect(notified, "`nix flake update` should not notify once per write").toEqual(1);
  });

  it("a flake in another directory is ignored", async () => {
    notified = 0;
    const nested = path.join(root, "vendor", "flake.nix");
    await fs.mkdir(path.dirname(nested), { recursive: true });
    watcher.changed.fire({ fsPath: nested });
    await settle();
    expect(notified, "only the configured flake directory belongs to this session").toEqual(0);
  });

  it("deleting flake.nix is noticed", async () => {
    notified = 0;
    await fs.rm(flake);
    watcher.deleted.fire({ fsPath: flake });
    await settle();
    expect(notified, "the host was never told the flake went away").toEqual(1);
    expect(session.hasFlake()).toEqual(false);
  });

  it("a flake appearing offers the picker", async () => {
    notified = 0;
    stub.recorded.infoMessages.length = 0;
    await fs.writeFile(flake, "{ outputs = _: {}; }\n");
    watcher.created.fire({ fsPath: flake });
    await settle();
    expect(notified, "the host was never told the flake appeared").toEqual(1);
    expect(
      stub.recorded.infoMessages.some((m) => m.includes("flake.nix")),
      "a flake appearing in a watched folder should offer the devShell picker",
    ).toBe(true);
  });

  it("editing an existing flake does not nag", async () => {
    stub.recorded.infoMessages.length = 0;
    watcher.changed.fire({ fsPath: flake });
    await settle();
    expect(stub.recorded.infoMessages, "editing a flake should not pop a notification").toEqual([]);
  });

  it("disposing stops the handlers", async () => {
    notified = 0;
    session.dispose();
    watcher.changed.fire({ fsPath: flake });
    await settle();
    expect(notified, "a disposed session must not keep reacting").toEqual(0);
    expect(watcher.disposed, "the watcher itself should be disposed with the session").toBe(true);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
});
