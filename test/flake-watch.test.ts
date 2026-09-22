import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as stub from "./activation-stub";
import { authorityFor } from "../src/remote/authority";
import { watchDevShellFlake, restartDevShellWindow } from "../src/remote/flake-watch";
import { StatusBar } from "../src/ui";
import { afterAll, describe, expect, it } from "vitest";

/** The devShell window's flake watcher, against real files and real `fs.watch` events. */

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

describe("devShell flake watcher", () => {
  it("a devShell window watches the flake it was built from", async () => {
    expect(typeof watch.dispose === "function", "no watcher was returned").toBe(true);
    expect(stub.recorded.infoMessages, "nothing should be reported before anything changes").toEqual([]);
  });

  it("editing the flake offers a restart", async () => {
    stub.recorded.infoMessages.length = 0;
    stub.recorded.statusText.length = 0;
    await fs.writeFile(flake, original.replace("= 1", "= 2"));
    await settle();
    expect(
      stub.recorded.infoMessages.some((m) => m.includes("still running the devShell")),
      `no restart offer was made; saw ${JSON.stringify(stub.recorded.infoMessages)}`,
    ).toBe(true);
    expect(
      stub.recorded.statusText.some((t) => t.includes("$(warning)")),
      "the status bar should show the window is running an out-of-date devShell",
    ).toBe(true);
  });

  it("a second edit does not prompt again", async () => {
    stub.recorded.infoMessages.length = 0;
    await fs.writeFile(flake, original.replace("= 1", "= 3"));
    await settle();
    expect(stub.recorded.infoMessages, "the status bar carries this, not a prompt per save").toEqual([]);
  });

  it("putting the flake back clears the warning", async () => {
    stub.recorded.statusText.length = 0;
    await fs.writeFile(flake, original);
    await settle();
    expect(
      stub.recorded.statusText.some((t) => t === "$(package) default"),
      `the status bar should go back to normal; saw ${JSON.stringify(stub.recorded.statusText)}`,
    ).toBe(true);
  });

  it("rewriting identical content is not a change", async () => {
    stub.recorded.infoMessages.length = 0;
    await fs.writeFile(flake, original);
    await settle();
    expect(stub.recorded.infoMessages, "saving a file the editor did not change is not a change").toEqual([]);
  });

  it("a restart stops the server and reloads the window", async () => {
    stub.recorded.executed.length = 0;
    await restartDevShellWindow(context as never);
    expect(
      stub.recorded.executed.includes("workbench.action.reloadWindow"),
      "the window was never reloaded, so the resolver never re-ran",
    ).toBe(true);
  });

  it("a restart outside a devShell window says so", async () => {
    stub.env.remoteAuthority = undefined;
    stub.recorded.executed.length = 0;
    stub.recorded.infoMessages.length = 0;
    await restartDevShellWindow(context as never);
    expect(stub.recorded.executed, "a local window has no devShell server to restart").toEqual([]);
    expect(stub.recorded.infoMessages.length === 1, "the user should be told why nothing happened").toBe(true);
  });

  it("disposing stops watching", async () => {
    watch.dispose();
    stub.recorded.infoMessages.length = 0;
    await fs.writeFile(flake, original.replace("= 1", "= 4"));
    await settle();
    expect(stub.recorded.infoMessages, "a disposed watcher must not keep reacting").toEqual([]);
  });

  afterAll(async () => {
    stub.env.remoteAuthority = undefined;
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
});
