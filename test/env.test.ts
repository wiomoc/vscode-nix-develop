import { computeDelta, renderDelta } from "../src/environment";
import type { CaptureResult } from "../src/nix";
import { describe, expect, it } from "vitest";

const cfg = {};

function capture(inside: Record<string, string>, baseline: Record<string, string>): CaptureResult {
  return { inside, baseline };
}

describe("computeDelta", () => {
  it("extracts only the devShell's prefix for search-path variables", () => {
    const d = computeDelta(
      capture({ PATH: "/nix/store/a/bin:/nix/store/b/bin:/usr/bin:/bin" }, { PATH: "/usr/bin:/bin" }),
      cfg,
    );
    expect(d.prepend.get("PATH")).toEqual("/nix/store/a/bin:/nix/store/b/bin");
    expect(d.replace.has("PATH"), "PATH must be prepended, not replaced").toBe(false);
  });

  it("replaces a search-path variable that was rewritten rather than extended", () => {
    const d = computeDelta(capture({ PATH: "/only/nix/bin" }, { PATH: "/usr/bin:/bin" }), cfg);
    expect(d.replace.get("PATH")).toEqual("/only/nix/bin");
    expect(d.prepend.has("PATH"), "a rewritten PATH cannot be expressed as a prepend").toBe(false);
  });

  it("treats a search-path variable absent from the baseline as a plain value", () => {
    const d = computeDelta(capture({ XDG_DATA_DIRS: "/nix/store/x/share" }, {}), cfg);
    expect(d.replace.get("XDG_DATA_DIRS")).toEqual("/nix/store/x/share");
  });

  it("filters stdenv derivation internals", () => {
    const d = computeDelta(
      capture(
        { out: "/nix/store/out", builder: "/bin/sh", phases: "buildPhase", shellHook: "echo hi", name: "x-env", stdenv: "/nix/store/s" },
        {},
      ),
      cfg,
    );
    expect(d.replace.size, "no derivation internals may survive").toEqual(0);
    for (const v of ["out", "builder", "phases", "shellHook", "name", "stdenv"]) {
      expect(d.dropped, `${v} should be reported as dropped`).toContain(v);
    }
  });

  it("filters session-owned variables, including the scratch TMPDIR", () => {
    const d = computeDelta(
      capture({ TMPDIR: "/tmp/nix-shell.XXXX", HOME: "/homeless-shelter", SHELL: "/nix/store/b/bin/bash" }, { TMPDIR: "/tmp", HOME: "/home/u", SHELL: "/bin/bash" }),
      cfg,
    );
    expect(d.replace.size, "session-owned variables must never be exported").toEqual(0);
    expect(d.dropped, "a stale nix-shell TMPDIR would break later terminals").toContain("TMPDIR");
  });

  it("filters VSCODE_ and SSH_ prefixed variables", () => {
    const d = computeDelta(capture({ VSCODE_PID: "1", SSH_AUTH_SOCK: "/x", npm_config_x: "y" }, {}), cfg);
    expect(d.replace.size).toEqual(0);
  });

  it("honours user-supplied ignoredVariables", () => {
    const d = computeDelta(capture({ KEEP: "1", DROP_ME: "2" }, {}), { ignoredVariables: ["DROP_ME"] });
    expect([...d.replace.keys()]).toEqual(["KEEP"]);
  });

  it("ignores variables whose value is unchanged", () => {
    const d = computeDelta(capture({ SAME: "v", CHANGED: "new" }, { SAME: "v", CHANGED: "old" }), cfg);
    expect([...d.replace.keys()]).toEqual(["CHANGED"]);
  });

  it("reports variables removed by the devShell", () => {
    const d = computeDelta(capture({}, { GONE: "1" }), cfg);
    expect(d.removed).toEqual(["GONE"]);
  });

  it("preserves values containing newlines and equals signs", () => {
    const weird = "line1\nline2=with=equals";
    const d = computeDelta(capture({ WEIRD: weird }, {}), cfg);
    expect(d.replace.get("WEIRD")).toEqual(weird);
  });
});

describe("renderDelta", () => {
  it("renders a shell-readable summary", () => {
    const d = computeDelta(capture({ PATH: "/nix/a:/usr/bin", CC: "gcc", out: "/x" }, { PATH: "/usr/bin" }), cfg);
    const text = renderDelta(d, "default");
    expect(text, "exported variables should be quoted").toContain('CC="gcc"');
    expect(text, "prepends should be shown as an extension of the existing value").toContain("$PATH");
    expect(text, "filtered variables should be listed").toContain("out");
  });
});
