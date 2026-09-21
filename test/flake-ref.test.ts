import { describe, expect, it } from "vitest";
import { flakeRefFor, markPathRefRequired, isUntrackedFlakeError, toInstallable } from "../src/nix";

describe("flake refs", () => {
  it("addresses a local directory bare, so Nix can use the Git source", () => {
    expect(flakeRefFor("/w/proj")).toEqual("/w/proj");
    expect(flakeRefFor("/w/proj").startsWith("path:"), "a path: ref hashes the whole directory").toBe(false);
  });

  it("installables use the bare ref too, so nix develop does not copy the tree", () => {
    expect(toInstallable("default", "/w/proj", "x86_64-linux")).toEqual("/w/proj#devShells.x86_64-linux.default");
  });

  it("switches a directory to path: once Git refuses its flake", () => {
    markPathRefRequired("/w/untracked");
    expect(flakeRefFor("/w/untracked")).toEqual("path:/w/untracked");
    expect(flakeRefFor("/w/proj"), "other directories are unaffected").toEqual("/w/proj");
  });

  it("recognises the untracked-flake failure", () => {
    expect(
      isUntrackedFlakeError({ stderr: 'error: path ... is not tracked by Git\nTo make it visible to Nix, run:\n  git add "flake.nix"' }),
      "the git-add hint must trigger the path: fallback",
    ).toBe(true);
    expect(isUntrackedFlakeError({ stderr: "error: attribute 'devShells' missing" }), "unrelated errors must not").toBe(false);
  });

  it("a full installable is passed through untouched", () => {
    expect(toInstallable("github:owner/repo#dev", "/w/proj", "x86_64-linux")).toEqual("github:owner/repo#dev");
  });
});
