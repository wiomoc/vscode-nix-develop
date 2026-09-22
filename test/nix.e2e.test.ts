import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeDelta } from "../src/environment";
import type { EnvDelta } from "../src/environment";
import type { NixDevShellConfig } from "../src/config";
import type { CaptureResult } from "../src/nix";
import { captureEnv, currentSystem, listDevShells, toInstallable } from "../src/nix";
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
 * Exercises the real `nix` CLI, which needs a network-capable Nix and takes minutes on a
 * cold store -- hence the `e2e` tag, which is what keeps it out of a plain `npm test`.
 *
 * The build itself happens once, in `beforeAll`: it is minutes of work, and everything
 * below is a question about the same captured environment.
 */
describe("nix (end-to-end)", { tags: ["e2e"] }, () => {
  let dir: string;
  let system: string;
  let installable: string;
  let capture: CaptureResult;
  let delta: EnvDelta;
  const streamed: string[] = [];
  const progressed: string[] = [];

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nix-devshell-e2e-"));
    system = await currentSystem(cfg, dir);
    await fs.writeFile(path.join(dir, "flake.nix"), FLAKE.replace("@SYSTEM@", system));

    installable = toInstallable("default", dir, system);
    capture = await captureEnv(cfg, installable, dir, path.join(dir, ".profile", "devshell"), {
      onOutput: (chunk) => streamed.push(chunk),
      onProgress: (line) => progressed.push(line),
    });
    delta = computeDelta(capture);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("resolves the current system", () => {
    expect(/^[a-z0-9_]+-[a-z]+$/.test(system), `unexpected system double: ${system}`).toBe(true);
  });

  it("discovers every devShell in the flake", async () => {
    const shells = await listDevShells(cfg, dir, system);
    expect(shells.map((s) => s.name).sort()).toEqual(["ci", "default"]);
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

  // The same build again, this time with a terminal to write to. Everything Nix withholds
  // over a pipe -- colour, and the progress bar it redraws in place -- depends on this and
  // on nothing else, so it is worth proving against the real CLI rather than assuming.
  // `NIX_DEVSHELL_APP_ROOT` is an installed VS Code's `resources/app`, which is where the
  // pty comes from; without one these report themselves as skipped.
  const appRoot = process.env.NIX_DEVSHELL_APP_ROOT;

  describe.skipIf(appRoot === undefined)("given a terminal", () => {
    const coloured: string[] = [];

    beforeAll(async () => {
      forgetPty();
      const previousAppRoot = stub.env.appRoot;
      stub.env.appRoot = appRoot;
      await captureEnv(cfg, installable, dir, path.join(dir, ".profile", "devshell"), {
        onOutput: (chunk) => coloured.push(chunk),
        tty: { columns: 100, rows: 30 },
      });
      stub.env.appRoot = previousAppRoot;
      forgetPty();
    });

    it("Nix colours its output and draws its bar", () => {
      const text = coloured.join("");
      expect(text, "no escape codes: Nix still thinks it is writing to a pipe").toContain("\u001b[");
      expect(text, "the progress bar redraws with carriage returns").toContain("\r");
    });

    it("the pipe path really was the plain one", () => {
      expect(
        streamed.join("").includes("\u001b["),
        "the earlier capture had no terminal, so it should have had no colour",
      ).toBe(false);
    });
  });

  it("the notification sink sees plain text, never escape codes", () => {
    const escaped = progressed.filter((l) => l.includes("\u001b"));
    expect(escaped, "a progress notification would print these literally").toEqual([]);
  });

  it("shellHook side effects are captured", () => {
    expect(delta.replace.get("FROM_HOOK"), "the shellHook must have been executed").toEqual("1");
  });

  it("mkShell attributes become environment variables", () => {
    expect(delta.replace.get("MY_VAR")).toEqual("hello-world");
  });

  it("shellHook stdout does not leak into the captured environment", () => {
    const polluted = [...delta.replace.keys()].filter((k) => k.includes("noisy") || k.includes("banner"));
    expect(polluted, "banner text must not be parsed as variables").toEqual([]);
  });

  it("packages land on PATH as a prepended prefix", () => {
    const prefix = delta.prepend.get("PATH");
    expect(prefix, "PATH should be a prepend, not a replace").toBeTruthy();
    expect(prefix, "hello should be on PATH").toContain("hello");
    expect(
      prefix!.includes(capture.baseline.PATH!),
      "the host PATH must not be duplicated into the prefix",
    ).toBe(false);
  });

  it("build-time HOME and TMPDIR never reach the result", () => {
    expect(delta.replace.has("HOME"), "HOME must not be overridden").toBe(false);
    expect(delta.replace.has("TMPDIR"), "the scratch TMPDIR must not be exported").toBe(false);
    expect(delta.replace.has("out"), "derivation outputs must not be exported").toBe(false);
  });

  it("the profile is created as a GC root", async () => {
    const link = await fs.readlink(path.join(dir, ".profile", "devshell"));
    expect(link.length > 0, "profile symlink should exist").toBe(true);
  });
});
