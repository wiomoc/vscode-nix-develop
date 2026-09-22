import path from "path";
import * as fs from "node:fs/promises";
import { exists } from "../utils/fs-stat";
import { log } from "../utils/log";
import { nixCommand } from "../nix";
import { NixDevShellConfig } from "../config";
import { run } from "../utils/run-subprocess";

/** What `patchServerNode` did about the server's `node`. */
export interface PatchedNode {
  /** The glibc dynamic linker it was pointed at; absent when it was left alone. */
  linker: string;
  /** glibc plus the libstdc++ the bundled node also needs; absent when left alone. */
  rpath: string;
}

/**
 * The name of glibc's dynamic linker for this architecture, as nixpkgs'
 * `stdenv.cc.bintools.dynamicLinker` spells it. `armv7l` is left out: nixpkgs gives only
 * a glob for it.
 */
export function glibcLinkerName(arch: string = process.arch): string {
  const byArch: Record<string, string> = {
    x64: "ld-linux-x86-64.so.2",
    arm64: "ld-linux-aarch64.so.1",
  };
  const name = byArch[arch];
  if (!name) {
    throw new Error(
      `no known glibc dynamic linker for ${arch}; the VS Code server cannot be patched here`,
    );
  }
  return name;
}

/**
 * The `node` a server distribution ships, resolved the way the launcher does it:
 * `dirname(dirname(readlink -f "$0"))/node`.
 */
export async function serverNodePath(launcher: string): Promise<string> {
  return path.join(
    path.dirname(path.dirname(await fs.realpath(launcher))),
    "node",
  );
}

/**
 * Point the server's bundled `node` at a glibc from nixpkgs, since `/lib64/ld-linux` does
 * not exist on NixOS without nix-ld.
 *
 * The launcher's own `VSCODE_SERVER_CUSTOM_GLIBC_*` hooks are not used: setting them makes
 * the server report an "unsupported OS" in every window, and the launcher patches in
 * place, which fails with `Text file busy` while another server runs the same binary.
 */
export async function patchServerNode(
  cfg: NixDevShellConfig,
  launcher: string,
  dir: string,
): Promise<PatchedNode> {
  const node = await serverNodePath(launcher);

  // `.out`: a bare `nixpkgs#glibc` is the *bin* output, which has no `lib/ld-linux-*`.
  const [glibc, gccLib, patchelf] = await Promise.all([
    storePathOf(cfg, "nixpkgs#glibc.out", dir),
    storePathOf(cfg, "nixpkgs#gcc-unwrapped.lib", dir),
    storePathOf(cfg, "nixpkgs#patchelf.out", dir),
  ]);

  const linker = path.join(glibc, "lib", glibcLinkerName());
  if (!(await exists(linker))) {
    // Caught here the architecture mapping above is wrong for this glibc, rather than
    // leaving `patchelf --set-interpreter` to write a path nothing can load.
    throw new Error(
      `${linker} does not exist, so the server's node cannot be patched`,
    );
  }

  // `--set-rpath` replaces the RPATH, and node also needs libstdc++.
  const rpath = [path.join(glibc, "lib"), path.join(gccLib, "lib")].join(":");
  const exe = path.join(patchelf, "bin", "patchelf");

  // Reading what is already there is only ever an optimisation, so a patchelf that
  // cannot answer means "patch it", not "fail".
  const print = async (flag: string): Promise<string | undefined> => {
    try {
      const { stdout } = await run(exe, [flag, node], {
        cwd: dir,
        timeoutMs: 60_000,
      });
      return stdout.trim();
    } catch (err) {
      log.debug(`patchelf ${flag} ${node}: ${(err as Error).message}`);
      return undefined;
    }
  };

  // Almost every resolve finds the work already done: a distribution is patched when it
  // is acquired, and the store paths only move when nixpkgs does.
  if (
    (await print("--print-interpreter")) === linker &&
    (await print("--print-rpath")) === rpath
  ) {
    log.debug(`${node} is already patched against ${glibc}`);
    return { linker, rpath };
  }

  log.info(`patching ${node} against ${glibc}`);
  // Patch a copy and rename it into place: another server may be running this binary,
  // and Linux refuses writes to a running executable (`Text file busy`).
  const tmp = `${node}.nix-devshell-${process.pid}`;
  try {
    await fs.copyFile(node, tmp);
    // Whether copyFile carries the mode over is platform-dependent, and a `node` that is
    // not executable fails much later and much less clearly.
    await fs.chmod(tmp, 0o755);
    // RPATH before interpreter, or growing the binary can undo the interpreter.
    // Refs https://github.com/NixOS/patchelf/issues/524
    await run(exe, ["--set-rpath", rpath, tmp], {
      cwd: dir,
      timeoutMs: 120_000,
    });
    await run(exe, ["--set-interpreter", linker, tmp], {
      cwd: dir,
      timeoutMs: 120_000,
    });
    await fs.rename(tmp, node);
  } finally {
    // Only reached with the file still there if something above threw; rename consumed it
    // otherwise.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  return { linker, rpath };
}

async function storePathOf(
  cfg: NixDevShellConfig,
  installable: string,
  cwd: string,
): Promise<string> {
  // `nixDevShell.impure` is the user's answer for *their* devShell; these are fixed
  // nixpkgs references that have no business being evaluated impurely.
  const { exe, args } = nixCommand(
    cfg,
    ["build"],
    ["--no-link", "--print-out-paths", installable],
    { impure: false },
  );
  const { stdout } = await run(exe, args, { cwd, timeoutMs: 600_000 });
  // One line per output; anything but exactly one path is an error, not a guess.
  const paths = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (paths.length !== 1) {
    throw new Error(
      `expected ${installable} to build exactly one output, got ${paths.length}` +
        (paths.length > 1 ? `: ${paths.join(", ")}` : ""),
    );
  }
  return paths[0];
}
