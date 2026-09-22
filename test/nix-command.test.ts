import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { NixDevShellConfig } from "../src/config";
import { developCommand, nixCommand } from "../src/nix";

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
 * `nix develop` is invoked from two places that run it very differently. These pin the one
 * builder both go through, so a flag can only ever be added or dropped in one place.
 */

const features = ["--extra-experimental-features", "nix-command flakes"];

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-profile-"));
const profile = path.join(dir, "profiles", "abc", "devshell");

describe("nix invocation", () => {
  it("every invocation carries the experimental-features flag", () => {
    expect(nixCommand(cfg, ["eval"], ["--raw"]).args).toEqual([...features, "eval", "--raw"]);
    expect(nixCommand(cfg, ["eval"], []).exe).toEqual("nix");
  });

  it("nixPath chooses the executable", () => {
    expect(nixCommand({ ...cfg, nixPath: "/run/current-system/sw/bin/nix" }, ["eval"], []).exe).toEqual("/run/current-system/sw/bin/nix");
  });

  it("--log-format goes before the subcommand, where Nix will accept it", () => {
    // Top-level, like the feature flags: `nix develop --log-format bar` is a different
    // parser and rejects it. Absent unless asked for, so nothing else changes format.
    expect(nixCommand(cfg, ["develop"], ["/w#dev"], { logFormat: "bar-with-logs" }).args).toEqual([...features, "--log-format", "bar-with-logs", "develop", "/w#dev"]);
    expect(nixCommand(cfg, ["develop"], ["/w#dev"]).args).toEqual([...features, "develop", "/w#dev"]);
  });

  it("--impure goes after the subcommand, where Nix will accept it", () => {
    // `nix --impure eval` is rejected outright with `unrecognised flag '--impure'`.
    expect(nixCommand({ ...cfg, impure: true }, ["flake", "show"], ["--json"]).args).toEqual([...features, "flake", "show", "--impure", "--json"]);
  });

  it("--impure follows the setting, and an explicit choice overrides it", () => {
    expect(nixCommand(cfg, ["eval"], []).args, "off by default").toEqual([...features, "eval"]);
    expect(
      nixCommand({ ...cfg, impure: true }, ["build"], [], { impure: false }).args,
      "a caller that knows better wins",
    ).toEqual([...features, "build"]);
    expect(nixCommand(cfg, ["eval"], [], { impure: true }).args).toEqual([...features, "eval", "--impure"]);
  });

  it("a profile makes the devShell a GC root", async () => {
    const { args } = await developCommand(cfg, {
      installable: "/w/proj#devShells.x86_64-linux.default",
      profile,
      command: ["bash", "-c", "true"],
    });
    expect(args).toEqual([
      ...features,
      "develop",
      "/w/proj#devShells.x86_64-linux.default",
      "--profile",
      profile,
      "--command",
      "bash",
      "-c",
      "true",
    ]);
  });

  it("the directory holding the profile is created, since Nix will not", async () => {
    expect(
      await fs.stat(path.dirname(profile)).then((st) => st.isDirectory()).catch(() => false),
      "nix develop --profile fails if the parent directory is missing",
    ).toBe(true);
  });

  it("no profile means no --profile, and nothing written", async () => {
    // `nixDevShell.profile: none`. The flag has to disappear entirely: `--profile` with an
    // empty path is not the same request, it is an error.
    const unrooted = path.join(dir, "never", "devshell");
    const { args } = await developCommand(cfg, {
      installable: "/w#dev",
      profile: undefined,
      command: ["bash", "-c", "true"],
    });
    expect(args).toEqual([...features, "develop", "/w#dev", "--command", "bash", "-c", "true"]);
    expect(
      await fs.stat(path.dirname(unrooted)).then(() => true).catch(() => false),
      "a mode that roots nothing must not create directories either",
    ).toBe(false);
  });

  it("a streamed build asks Nix for its progress bar and full logs", async () => {
    const { args } = await developCommand(cfg, {
      installable: "/w#dev",
      profile: undefined,
      command: ["bash", "-c", "true"],
      logFormat: "bar-with-logs",
    });
    expect(args).toEqual([
      ...features,
      "--log-format",
      "bar-with-logs",
      "develop",
      "/w#dev",
      "--command",
      "bash",
      "-c",
      "true",
    ]);
  });

  it("extraArgs and impure reach nix develop, ahead of the inner command", async () => {
    const { args } = await developCommand(
      { ...cfg, impure: true, extraArgs: ["--offline", "-L"] },
      { installable: "/w#dev", profile, command: ["bash", "-c", "true"] },
    );
    expect(args).toEqual([
      ...features,
      "develop",
      "--impure",
      "/w#dev",
      "--profile",
      profile,
      "--offline",
      "-L",
      "--command",
      "bash",
      "-c",
      "true",
    ]);
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
});
