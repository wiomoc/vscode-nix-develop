import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { eq, ok, test } from "./harness";
import * as stub from "./activation-stub";
import { forgetPty, loadPty } from "../src/utils/pty";

/**
 * Borrowing the editor's `node-pty`.
 *
 * The point of these is the *absence* of a hard dependency: every way of not finding a pty
 * has to end in `undefined` rather than a throw, because the extension host loading this
 * module is the extension host that opens windows.
 */
export async function run(): Promise<void> {
  console.log("\nborrowed pty");

  const appRoot = stub.env.appRoot;

  await test("an editor that reports no appRoot lends nothing", () => {
    forgetPty();
    stub.env.appRoot = undefined;
    eq(loadPty(), undefined, "there is nowhere to look, and that is not an error");
  });

  await test("an appRoot without a node-pty lends nothing", async () => {
    forgetPty();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "nd-approot-"));
    stub.env.appRoot = empty;
    eq(loadPty(), undefined, "a require that throws must not reach the caller");
    await fs.rm(empty, { recursive: true, force: true });
  });

  await test("something at that path that is not a pty lends nothing", async () => {
    forgetPty();
    const fake = await fs.mkdtemp(path.join(os.tmpdir(), "nd-approot-"));
    const mod = path.join(fake, "node_modules", "node-pty");
    await fs.mkdir(mod, { recursive: true });
    await fs.writeFile(path.join(mod, "package.json"), JSON.stringify({ main: "index.js" }));
    await fs.writeFile(path.join(mod, "index.js"), "module.exports = { notSpawn: 1 };\n");
    stub.env.appRoot = fake;
    eq(loadPty(), undefined, "a module without spawn() is not one we can use");
    await fs.rm(fake, { recursive: true, force: true });
  });

  await test("the answer is remembered, so a missing module is looked for once", async () => {
    forgetPty();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "nd-approot-"));
    stub.env.appRoot = empty;
    eq(loadPty(), undefined);
    // A second call must not reach the filesystem again; point appRoot at a real editor
    // and the memo should still say no.
    stub.env.appRoot = "/nowhere/else";
    eq(loadPty(), undefined);
    await fs.rm(empty, { recursive: true, force: true });
  });

  // The real thing, when there is a real editor to borrow from. `NIX_DEVELOP_APP_ROOT` is
  // an installed VS Code's `resources/app`.
  const real = process.env.NIX_DEVELOP_APP_ROOT;
  if (!real) {
    console.log("  [skipped: set NIX_DEVELOP_APP_ROOT to an editor's resources/app]");
  } else {
    await test("a real editor's node-pty loads and spawns", async () => {
      forgetPty();
      stub.env.appRoot = real;
      const pty = loadPty();
      ok(pty !== undefined, `nothing loadable under ${real}/node_modules/node-pty`);

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
      ok(output.includes("IS_A_TTY"), `the child should see a tty, got: ${output.trim()}`);
    });
  }

  stub.env.appRoot = appRoot;
  forgetPty();
}
