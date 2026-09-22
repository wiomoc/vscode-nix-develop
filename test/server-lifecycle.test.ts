import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type { NixDevShellConfig } from "../src/config";
import { ServerManager } from "../src/remote/server";

const cfg: NixDevShellConfig = {
  flakeDirectory: ".",
  promptWhenUnset: true,
  impure: false,
  extraArgs: [],
  nixPath: "nix",
  buildTimeoutSeconds: 1800,
  profile: "persistent",
  showBuildOutput: "onFailure",
  remote: {
    serverDownloadUrl: "https://example.invalid/${commit}/${platform}",
    connectTimeoutSeconds: 180,
    patchServerLd: true,
  },
};

/**
 * What happens to a lock and the devShell's GC root once their server is gone, using a
 * hand-written lock and profile. The profile must survive.
 */

const storage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-lifecycle-"));
const manager = new ServerManager({ fsPath: storage } as never, cfg);
const commit = "1e3c50d64110be466c0b4a45222e81d2c9352888";

const lockPath = (key: string) =>
  path.join(storage, "server", "instances", `${key}.json`);

/** The symlinks `nix develop --profile` leaves behind, where the project keeps them. */
const buildProfile = async (key: string): Promise<string> => {
  const dir = path.join(storage, "project", ".vscode", "nix-devshell", key);
  await fs.mkdir(dir, { recursive: true });
  const profile = path.join(dir, "devshell");
  await fs.symlink("/nix/store/aaaa-devshell", `${profile}-1-link`);
  await fs.symlink("/nix/store/bbbb-devshell", `${profile}-2-link`);
  await fs.symlink("devshell-2-link", profile);
  return profile;
};

const writeLock = async (key: string, port: number, profile: string, at = commit) => {
  await fs.mkdir(path.dirname(lockPath(key)), { recursive: true });
  await fs.writeFile(
    lockPath(key),
    JSON.stringify({
      port,
      connectionToken: "token",
      pid: 999_999,
      installable: "/w#devShells.x86_64-linux.default",
      commit: at,
      startedAt: Date.now(),
      profile,
    }),
  );
};

const listen = (): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as { port: number }).port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      }),
    );
  });

/** A port nothing is on: take one, then give it straight back. */
const deadPort = async (): Promise<number> => {
  const { port, close } = await listen();
  await close();
  return port;
};

const exists = (p: string) =>
  fs.lstat(p).then(() => true).catch(() => false);

describe("server lock release", () => {
  it("a lock whose server has gone releases the lock", async () => {
    const key = "gone";
    const profile = await buildProfile(key);
    await writeLock(key, await deadPort(), profile);

    expect(await manager.findRunning(key, commit), "a dead port is not attachable").toEqual(undefined);
    expect(await exists(lockPath(key)), "the lock should be gone").toEqual(false);
  });

  it("a released lock leaves the devShell's GC root alone", async () => {
    // The profile outlives every server that enters it: that is what makes reopening the
    // folder after a `nix store gc` -- or offline -- cost nothing.
    const profile = path.join(storage, "project", ".vscode", "nix-devshell", "gone", "devshell");
    expect(await exists(profile), "the profile symlink should still be there").toBe(true);
    expect(await exists(`${profile}-1-link`), "generation 1 should still be there").toBe(true);
    expect(await exists(`${profile}-2-link`), "generation 2 should still be there").toBe(true);
  });

  it("a live server from another commit keeps its lock and its profile", async () => {
    const key = "othercommit";
    const profile = await buildProfile(key);
    const { port, close } = await listen();
    await writeLock(key, port, profile, "0000000000000000000000000000000000000000");

    expect(await manager.findRunning(key, commit), "a mismatched commit is unusable").toEqual(undefined);
    expect(await exists(lockPath(key)), "something is still serving, so the lock stays").toBe(true);
    expect(await exists(profile), "and it still needs the shell the profile pins").toBe(true);
    await close();
  });

  it("a live server at the right commit is handed back", async () => {
    const key = "live";
    const profile = await buildProfile(key);
    const { port, close } = await listen();
    await writeLock(key, port, profile);

    expect(await manager.findRunning(key, commit)).toEqual({ port, connectionToken: "token", pid: 999_999 });
    expect(await exists(lockPath(key)), "attaching must not disturb the lock").toBe(true);
    await close();
  });

  it("a sweep drops every lock whose server is gone, and keeps the rest", async () => {
    // Own storage, since a sweep reads every lock.
    const swept = await fs.mkdtemp(path.join(os.tmpdir(), "nd-sweep-"));
    const sweeper = new ServerManager({ fsPath: swept } as never, cfg);
    const lockIn = (key: string) => path.join(swept, "server", "instances", `${key}.json`);
    const write = async (key: string, port: number) => {
      await fs.mkdir(path.dirname(lockIn(key)), { recursive: true });
      await fs.writeFile(
        lockIn(key),
        JSON.stringify({ port, connectionToken: "t", pid: 999_999, commit }),
      );
    };

    await write("dead-1", await deadPort());
    await write("dead-2", await deadPort());
    const { port, close } = await listen();
    await write("alive", port);
    // Not a lock, and not the sweep's to touch.
    await fs.writeFile(path.join(swept, "server", "instances", "notes.txt"), "keep me");

    expect(await sweeper.sweep(), "both dead servers' locks should go").toEqual(2);
    expect(await exists(lockIn("dead-1")), "a stale lock should be gone").toEqual(false);
    expect(await exists(lockIn("alive")), "a lock whose port still answers must survive").toBe(true);
    expect(
      await exists(path.join(swept, "server", "instances", "notes.txt")),
      "only locks are the sweep's to remove",
    ).toBe(true);
    expect(await sweeper.sweep(), "sweeping twice is not an error").toEqual(0);

    await close();
    await fs.rm(swept, { recursive: true, force: true });
  });

  it("a sweep leaves the devShell GC roots alone", async () => {
    // The profile belongs to the project, and no server's departure releases it.
    const profile = path.join(storage, "project", ".vscode", "nix-devshell", "gone", "devshell");
    await manager.sweep();
    expect(await exists(profile), "the project's profile is not the sweep's to remove").toBe(true);
  });

  it("no lock at all is not an error", async () => {
    expect(await manager.findRunning("never-started", commit)).toEqual(undefined);
  });

  afterAll(async () => {
    await fs.rm(storage, { recursive: true, force: true });
  });
});
