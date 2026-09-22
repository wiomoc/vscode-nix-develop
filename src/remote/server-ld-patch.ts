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
 * The name of glibc's dynamic linker for this machine.
 *
 * The ELF interpreter is named per architecture, and the server's `node` has to be pointed
 * at the matching one. These are nixpkgs' own answers, read out of
 * `stdenv.cc.bintools.dynamicLinker` for each system rather than guessed.
 *
 * Only the two architectures VS Code ships a Linux server for are listed. `armv7l` is
 * deliberately absent: nixpkgs itself spells it `ld-linux*.so.3`, an unresolved glob, so
 * there is no single right answer to hardcode. Failing with the architecture named beats
 * handing `patchelf` a path that does not exist, which surfaces much later as the launcher
 * reporting "Patching complete." and then `cannot execute: required file not found`.
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
 * Give the server's bundled `node` a glibc it can actually start against.
 *
 * The server ships a `node` linked against the host's glibc via `/lib64/ld-linux`, which
 * on NixOS does not exist, so it cannot start unless nix-ld happens to be configured. The
 * fix is `patchelf` and a glibc from nixpkgs, and it runs from here -- before anything
 * runs the launcher.
 *
 * `bin/code-server` has hooks for doing this itself, read out of the environment
 * (`VSCODE_SERVER_CUSTOM_GLIBC_LINKER`, `VSCODE_SERVER_CUSTOM_GLIBC_PATH`,
 * `VSCODE_SERVER_PATCHELF_PATH`), and they are deliberately not used. They stay set in
 * the environment the launcher hands to `node`, and the server calls itself unsupported
 * whenever the first one is set:
 *
 * ```js
 * isUnsupportedGlibc = (glibcVersion ? minorOf(glibcVersion) : 28) <= 27
 *   || !!process.env.VSCODE_SERVER_CUSTOM_GLIBC_LINKER;
 * ```
 *
 * The client turns that into "You are connected to an OS version that is unsupported by
 * Visual Studio Code" in every devShell window -- which is backwards here, since the
 * glibc being patched in is *newer* than the one the check is worried about. The launcher
 * also rewrites `node` in place, so a distribution that some other devShell's server is
 * still running fails with `open: Text file busy` and is exec'd unpatched anyway. Doing
 * the same two `patchelf` calls from here avoids both: no variable reaches the server,
 * and the rewrite goes through a copy that is renamed into place.
 *
 * `nixDevShell.remote.patchServerLd` turned off touches neither the binary nor the
 * environment, for a host that resolves `/lib64/ld-linux-*` on its own --
 * `programs.nix-ld`, or simply not NixOS. No nixpkgs build is evaluated at all, which is
 * the only way this costs nothing on a cold store.
 */
export async function patchServerNode(
  cfg: NixDevShellConfig,
  launcher: string,
  dir: string,
): Promise<PatchedNode> {
  // The launcher resolves its own root as `dirname(dirname(readlink -f "$0"))` and
  // patches `$ROOT/node`; the binary is the same one either way, so resolve it the same
  // way rather than assuming where the launcher was found.
  const node = path.join(
    path.dirname(path.dirname(await fs.realpath(launcher))),
    "node",
  );

  // `.out` is load-bearing: a bare `nixpkgs#glibc` resolves to glibc's *bin* output,
  // which has no `lib/ld-linux-*` at all. Patching against it leaves a `node` that
  // reports success here and then fails to exec with "required file not found".
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

  // `--set-rpath` *replaces* the existing RPATH rather than adding to it. glibc alone is
  // therefore not enough: the bundled node also links libstdc++, and dropping it leaves
  // the freshly patched node failing with "libstdc++.so.6: cannot open shared object
  // file". patchelf takes a colon-separated list, so both go in.
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
  // Patch a copy and rename it into place rather than rewriting the binary where it lies.
  // Servers outlive the window that started them and several devShells share one
  // distribution, so there is usually a `node` from this very file already running --
  // and Linux refuses to write to a running executable at all: patchelf fails with
  // `open: Text file busy`, which is how this node came to be unpatched in the first
  // place. A rename only swaps the directory entry, so the running servers keep the
  // inode they started on and the next one gets the patched binary.
  const tmp = `${node}.nix-devshell-${process.pid}`;
  try {
    await fs.copyFile(node, tmp);
    // Whether copyFile carries the mode over is platform-dependent, and a `node` that is
    // not executable fails much later and much less clearly.
    await fs.chmod(tmp, 0o755);
    // RPATH before interpreter: patchelf can grow the binary while setting the rpath, and
    // doing that second has been observed to undo the interpreter it just wrote.
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
  // One line per output. Anything but a single path means the installable did not name
  // one output, and picking from the list would be a guess -- which is how the wrong
  // glibc output got used here once already.
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
