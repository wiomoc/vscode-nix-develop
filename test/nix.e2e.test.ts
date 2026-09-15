import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeDelta } from "../src/environment";
import type { NixDevelopConfig } from "../src/config";
import { captureEnv, currentSystem, listDevShells, toInstallable } from "../src/nix";
import { eq, ok, test } from "./harness";

const cfg: NixDevelopConfig = {
  flakeDirectory: ".",
  promptWhenUnset: true,
  impure: false,
  extraArgs: [],
  nixPath: "nix",
  buildTimeoutSeconds: 1800,
  remote: {
    extensions: [],
    extensionsFromFlake: true,
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
  const capture = await captureEnv(cfg, installable, dir, path.join(dir, ".profile", "devshell"));
  const delta = computeDelta(capture);

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
