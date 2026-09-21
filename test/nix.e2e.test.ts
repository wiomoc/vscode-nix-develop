import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeDelta } from "../src/environment";
import type { NixDevelopConfig } from "../src/config";
import { captureEnv, currentSystem, listDevShells, toInstallable } from "../src/nix";
import { eq, ok, test } from "./harness";
import * as stub from "./activation-stub";
import { forgetPty } from "../src/utils/pty";

const cfg: NixDevelopConfig = {
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
 * Exercises the real `nix` CLI. Skipped unless NIX_DEVELOP_E2E=1, because it needs a
 * network-capable Nix and takes minutes on a cold store.
 */
export async function run(): Promise<void> {
  if (process.env.NIX_DEVELOP_E2E !== "1") {
    console.log("\nnix (end-to-end)  [skipped: set NIX_DEVELOP_E2E=1 to run]");
    return;
  }
  console.log("\nnix (end-to-end)");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nix-develop-e2e-"));
  const system = await currentSystem(cfg, dir);
  await fs.writeFile(path.join(dir, "flake.nix"), FLAKE.replace("@SYSTEM@", system));

  await test(`resolves the current system (${system})`, () => {
    ok(/^[a-z0-9_]+-[a-z]+$/.test(system), `unexpected system double: ${system}`);
  });

  await test("discovers every devShell in the flake", async () => {
    const shells = await listDevShells(cfg, dir, system);
    eq(
      shells.map((s) => s.name).sort(),
      ["ci", "default"],
    );
  });

  const installable = toInstallable("default", dir, system);
  const streamed: string[] = [];
  const progressed: string[] = [];
  const capture = await captureEnv(cfg, installable, dir, path.join(dir, ".profile", "devshell"), {
    onOutput: (chunk) => streamed.push(chunk),
    onProgress: (line) => progressed.push(line),
  });
  const delta = computeDelta(capture);

  await test("the build is streamed as it happens, not collected at the end", () => {
    ok(streamed.length > 0, "nothing reached the terminal sink");
    // `--log-format bar-with-logs` is what puts the builders' own output here; without it
    // Nix says almost nothing over a pipe, and a failing shellHook would be invisible.
    ok(
      streamed.join("").includes("a noisy banner on stdout"),
      `the shellHook's own output should stream too, got: ${streamed.join("").slice(0, 400)}`,
    );
  });

  // The same build again, this time with a terminal to write to. Everything Nix withholds
  // over a pipe -- colour, and the progress bar it redraws in place -- depends on this and
  // on nothing else, so it is worth proving against the real CLI rather than assuming.
  const appRoot = process.env.NIX_DEVELOP_APP_ROOT;
  if (!appRoot) {
    console.log("  [tty path skipped: set NIX_DEVELOP_APP_ROOT to an editor's resources/app]");
  } else {
    forgetPty();
    const previousAppRoot = stub.env.appRoot;
    stub.env.appRoot = appRoot;
    const coloured: string[] = [];
    await captureEnv(cfg, installable, dir, path.join(dir, ".profile", "devshell"), {
      onOutput: (chunk) => coloured.push(chunk),
      tty: { columns: 100, rows: 30 },
    });
    stub.env.appRoot = previousAppRoot;
    forgetPty();

    await test("given a terminal, Nix colours its output and draws its bar", () => {
      const text = coloured.join("");
      ok(text.includes("\u001b["), "no escape codes: Nix still thinks it is writing to a pipe");
      ok(text.includes("\r"), "the progress bar redraws with carriage returns");
    });

    await test("the pipe path really was the plain one", () => {
      eq(
        streamed.join("").includes("\u001b["),
        false,
        "the earlier capture had no terminal, so it should have had no colour",
      );
    });
  }

  await test("the notification sink sees plain text, never escape codes", () => {
    const escaped = progressed.filter((l) => l.includes("\u001b"));
    eq(escaped, [], "a progress notification would print these literally");
  });

  await test("shellHook side effects are captured", () => {
    eq(delta.replace.get("FROM_HOOK"), "1", "the shellHook must have been executed");
  });

  await test("mkShell attributes become environment variables", () => {
    eq(delta.replace.get("MY_VAR"), "hello-world");
  });

  await test("shellHook stdout does not leak into the captured environment", () => {
    const polluted = [...delta.replace.keys()].filter((k) => k.includes("noisy") || k.includes("banner"));
    eq(polluted, [], "banner text must not be parsed as variables");
  });

  await test("packages land on PATH as a prepended prefix", () => {
    const prefix = delta.prepend.get("PATH");
    ok(!!prefix, "PATH should be a prepend, not a replace");
    ok(prefix!.includes("hello"), `hello should be on PATH, got: ${prefix}`);
    ok(!prefix!.includes(capture.baseline.PATH!), "the host PATH must not be duplicated into the prefix");
  });

  await test("build-time HOME and TMPDIR never reach the result", () => {
    ok(!delta.replace.has("HOME"), "HOME must not be overridden");
    ok(!delta.replace.has("TMPDIR"), "the scratch TMPDIR must not be exported");
    ok(!delta.replace.has("out"), "derivation outputs must not be exported");
  });

  await test("the profile is created as a GC root", async () => {
    const link = await fs.readlink(path.join(dir, ".profile", "devshell"));
    ok(link.length > 0, "profile symlink should exist");
  });

  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
