import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NixDevShellConfig } from "../src/config";
import {
  BUILD_LOG_FORMAT,
  currentSystem,
  developCommand,
  listDevShells,
  plainText,
  toInstallable,
} from "../src/nix";
import { run, type TtyOptions } from "../src/utils/run-subprocess";
import * as stub from "./activation-stub";
import { forgetPty } from "../src/utils/pty";

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

const FLAKE = `{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      system = "@SYSTEM@";
      pkgs = nixpkgs.legacyPackages.\${system};
    in {
      devShells.\${system} = {
        default = pkgs.mkShell {
          name = "e2e-default";
          packages = [ pkgs.hello ];
          MY_VAR = "hello-world";
          shellHook = ''
            echo "a noisy banner on stdout"
            export FROM_HOOK=1
          '';
        };
        ci = pkgs.mkShell { name = "e2e-ci"; };
      };
    };
}
`;

/**
 * Exercises the real `nix` CLI (network, minutes on a cold store; tagged `e2e`):
 * `developCommand` plus `run`, with a `bash -c` in place of `dist/provision.js`.
 */
describe("nix (end-to-end)", { tags: ["e2e"] }, () => {
  let dir: string;
  let system: string;
  let installable: string;
  let profile: string;
  /** What the command saw from inside the shell, as `NAME=value` lines. */
  let inside: Record<string, string>;
  const streamed: string[] = [];
  const progressed: string[] = [];

  /** Run `script` inside the devShell, the way `ServerManager.start` runs its bundle. */
  async function develop(
    script: string,
    sink: { onOutput?: (chunk: string) => void; tty?: TtyOptions } = {},
  ): Promise<string> {
    const { exe, args } = await developCommand(cfg, {
      installable,
      profile,
      command: ["bash", "-c", script],
      logFormat: BUILD_LOG_FORMAT,
    });
    const result = await run(exe, args, {
      cwd: dir,
      timeoutMs: cfg.buildTimeoutSeconds * 1000,
      onStdout: sink.onOutput,
      onStderr: sink.onOutput,
      tty: sink.tty,
    });
    // A pty has one stream, so what the command printed lands in `stderr` there and in
    // `stdout` over a pipe. Both are searched rather than assuming which run this was.
    return `${result.stdout}\n${result.stderr}`;
  }

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nix-devshell-e2e-"));
    system = await currentSystem(cfg, dir);
    await fs.writeFile(
      path.join(dir, "flake.nix"),
      FLAKE.replace("@SYSTEM@", system),
    );

    installable = toInstallable("default", dir, system);
    profile = path.join(dir, ".profile", "devshell");

    // One build, then questions about it. `MARK:` is a prefix nothing in a Nix build log
    // uses, so the answers can be picked out of a stream that also carries the build.
    const output = await develop(
      'for v in MY_VAR FROM_HOOK PATH HOME; do printf "MARK:%s=%s\\n" "$v" "${!v}"; done',
      {
        onOutput: (chunk) => {
          streamed.push(chunk);
          for (const line of chunk.split("\n")) {
            const text = plainText(line);
            if (text) progressed.push(text);
          }
        },
      },
    );

    inside = {};
    for (const line of output.split("\n")) {
      const marked = line.indexOf("MARK:");
      if (marked < 0) continue;
      const entry = line.slice(marked + "MARK:".length).trimEnd();
      const eq = entry.indexOf("=");
      if (eq > 0) inside[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("resolves the current system", () => {
    expect(
      /^[a-z0-9_]+-[a-z]+$/.test(system),
      `unexpected system double: ${system}`,
    ).toBe(true);
  });

  it("discovers every devShell in the flake", async () => {
    const shells = await listDevShells(cfg, dir, system);
    expect(shells.map((s) => s.name).sort()).toEqual(["ci", "default"]);
  });

  it("--command runs inside the shell, with the mkShell attributes set", () => {
    expect(inside.MY_VAR).toEqual("hello-world");
  });

  it("the shellHook has run by the time the command starts", () => {
    expect(
      inside.FROM_HOOK,
      "the shellHook must have been executed before --command",
    ).toEqual("1");
  });

  it("packages land on PATH as a prepended prefix", () => {
    expect(inside.PATH, "hello should be on PATH").toContain("hello");
  });

  it("the build-time HOME never reaches the command", () => {
    expect(inside.HOME).toEqual(process.env.HOME);
  });

  it("the build is streamed as it happens, not collected at the end", () => {
    expect(streamed.length > 0, "nothing reached the terminal sink").toBe(true);
    // `--log-format bar-with-logs` is what puts the builders' own output here; without it
    // Nix says almost nothing over a pipe, and a failing shellHook would be invisible.
    expect(
      streamed.join(""),
      "the shellHook's own output should stream too",
    ).toContain("a noisy banner on stdout");
  });

  it("the notification sink sees plain text, never escape codes", () => {
    const escaped = progressed.filter((l) => l.includes("\u001b"));
    expect(escaped, "a progress notification would print these literally").toEqual([]);
  });

  it("the profile is created as a GC root", async () => {
    const link = await fs.readlink(profile);
    expect(link.length > 0, "profile symlink should exist").toBe(true);
  });

  // The same shell under a pty, where Nix draws colour and its progress bar. The pty
  // comes from `NIX_DEVSHELL_APP_ROOT`; without it these are skipped.
  const appRoot = process.env.NIX_DEVSHELL_APP_ROOT;

  describe.skipIf(appRoot === undefined)("given a terminal", () => {
    const coloured: string[] = [];

    beforeAll(async () => {
      forgetPty();
      const previousAppRoot = stub.env.appRoot;
      stub.env.appRoot = appRoot;
      await develop('printf "MARK:TTY=%s\\n" "$MY_VAR"', {
        onOutput: (chunk) => coloured.push(chunk),
        tty: { columns: 100, rows: 30 },
      });
      stub.env.appRoot = previousAppRoot;
      forgetPty();
    });

    it("Nix colours its output and draws its bar", () => {
      const text = coloured.join("");
      expect(
        text,
        "no escape codes: Nix still thinks it is writing to a pipe",
      ).toContain("\u001b[");
      expect(text, "the progress bar redraws with carriage returns").toContain("\r");
    });

    it("the pipe path really was the plain one", () => {
      expect(
        streamed.join("").includes("\u001b["),
        "the earlier run had no terminal, so it should have had no colour",
      ).toBe(false);
    });
  });
});
