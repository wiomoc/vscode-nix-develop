import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as stub from "./activation-stub";
import { forgetPty, loadPty } from "../src/utils/pty";
import { afterAll, describe, expect, it } from "vitest";

/** Borrowing the editor's `node-pty`: every way of not finding one yields `undefined`. */
const appRoot = stub.env.appRoot;

afterAll(() => {
  stub.env.appRoot = appRoot;
  forgetPty();
});

describe("borrowed pty", () => {
  it("an editor that reports no appRoot lends nothing", () => {
    forgetPty();
    stub.env.appRoot = undefined;
    expect(loadPty(), "there is nowhere to look, and that is not an error").toBeUndefined();
  });

  it("an appRoot without a node-pty lends nothing", async () => {
    forgetPty();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "nd-approot-"));
    stub.env.appRoot = empty;
    expect(loadPty(), "a require that throws must not reach the caller").toBeUndefined();
    await fs.rm(empty, { recursive: true, force: true });
  });

  it("something at that path that is not a pty lends nothing", async () => {
    forgetPty();
    const fake = await fs.mkdtemp(path.join(os.tmpdir(), "nd-approot-"));
    const mod = path.join(fake, "node_modules", "node-pty");
    await fs.mkdir(mod, { recursive: true });
    await fs.writeFile(path.join(mod, "package.json"), JSON.stringify({ main: "index.js" }));
    await fs.writeFile(path.join(mod, "index.js"), "module.exports = { notSpawn: 1 };\n");
    stub.env.appRoot = fake;
    expect(loadPty(), "a module without spawn() is not one we can use").toBeUndefined();
    await fs.rm(fake, { recursive: true, force: true });
  });

  it("the answer is remembered, so a missing module is looked for once", async () => {
    forgetPty();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "nd-approot-"));
    stub.env.appRoot = empty;
    expect(loadPty()).toBeUndefined();
    // A second call must not reach the filesystem again; point appRoot at a real editor
    // and the memo should still say no.
    stub.env.appRoot = "/nowhere/else";
    expect(loadPty()).toBeUndefined();
    await fs.rm(empty, { recursive: true, force: true });
  });

  // The real thing, when there is a real editor to borrow from. `NIX_DEVSHELL_APP_ROOT` is
  // an installed VS Code's `resources/app`; without it this one reports itself as skipped.
  const real = process.env.NIX_DEVSHELL_APP_ROOT;
  it.runIf(real !== undefined)("a real editor's node-pty loads and spawns", async () => {
    forgetPty();
    stub.env.appRoot = real;
    const pty = loadPty();
    expect(pty, `nothing loadable under ${real}/node_modules/node-pty`).toBeDefined();

    const child = pty!.spawn("/bin/sh", ["-c", "tty -s && echo IS_A_TTY"], {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: os.tmpdir(),
      env: process.env,
    });
    const output = await new Promise<string>((resolve) => {
      let seen = "";
      child.onData((d) => (seen += d));
      child.onExit(() => resolve(seen));
    });
    expect(output, `the child should see a tty, got: ${output.trim()}`).toContain("IS_A_TTY");
  });
});
