import { computeDelta, renderDelta } from "../src/environment";
import type { CaptureResult } from "../src/nix";
import { eq, ok, test } from "./harness";

const cfg = {};

function capture(inside: Record<string, string>, baseline: Record<string, string>): CaptureResult {
  return { inside, baseline };
}

export async function run(): Promise<void> {
  console.log("\ncomputeDelta");

  await test("extracts only the devShell's prefix for search-path variables", () => {
    const d = computeDelta(
      capture({ PATH: "/nix/store/a/bin:/nix/store/b/bin:/usr/bin:/bin" }, { PATH: "/usr/bin:/bin" }),
      cfg,
    );
    eq(d.prepend.get("PATH"), "/nix/store/a/bin:/nix/store/b/bin");
    ok(!d.replace.has("PATH"), "PATH must be prepended, not replaced");
  });

  await test("replaces a search-path variable that was rewritten rather than extended", () => {
    const d = computeDelta(capture({ PATH: "/only/nix/bin" }, { PATH: "/usr/bin:/bin" }), cfg);
    eq(d.replace.get("PATH"), "/only/nix/bin");
    ok(!d.prepend.has("PATH"), "a rewritten PATH cannot be expressed as a prepend");
  });

  await test("treats a search-path variable absent from the baseline as a plain value", () => {
    const d = computeDelta(capture({ XDG_DATA_DIRS: "/nix/store/x/share" }, {}), cfg);
    eq(d.replace.get("XDG_DATA_DIRS"), "/nix/store/x/share");
  });

  await test("filters stdenv derivation internals", () => {
    const d = computeDelta(
      capture(
        { out: "/nix/store/out", builder: "/bin/sh", phases: "buildPhase", shellHook: "echo hi", name: "x-env", stdenv: "/nix/store/s" },
        {},
      ),
      cfg,
    );
    eq(d.replace.size, 0, "no derivation internals may survive");
    for (const v of ["out", "builder", "phases", "shellHook", "name", "stdenv"]) {
      ok(d.dropped.includes(v), `${v} should be reported as dropped`);
    }
  });

  await test("filters session-owned variables, including the scratch TMPDIR", () => {
    const d = computeDelta(
      capture({ TMPDIR: "/tmp/nix-shell.XXXX", HOME: "/homeless-shelter", SHELL: "/nix/store/b/bin/bash" }, { TMPDIR: "/tmp", HOME: "/home/u", SHELL: "/bin/bash" }),
      cfg,
    );
    eq(d.replace.size, 0, "session-owned variables must never be exported");
    ok(d.dropped.includes("TMPDIR"), "a stale nix-shell TMPDIR would break later terminals");
  });

  await test("filters VSCODE_ and SSH_ prefixed variables", () => {
    const d = computeDelta(capture({ VSCODE_PID: "1", SSH_AUTH_SOCK: "/x", npm_config_x: "y" }, {}), cfg);
    eq(d.replace.size, 0);
  });

  await test("honours user-supplied ignoredVariables", () => {
    const d = computeDelta(capture({ KEEP: "1", DROP_ME: "2" }, {}), { ignoredVariables: ["DROP_ME"] });
    eq([...d.replace.keys()], ["KEEP"]);
  });

  await test("ignores variables whose value is unchanged", () => {
    const d = computeDelta(capture({ SAME: "v", CHANGED: "new" }, { SAME: "v", CHANGED: "old" }), cfg);
    eq([...d.replace.keys()], ["CHANGED"]);
  });

  await test("reports variables removed by the devShell", () => {
    const d = computeDelta(capture({}, { GONE: "1" }), cfg);
    eq(d.removed, ["GONE"]);
  });

  await test("preserves values containing newlines and equals signs", () => {
    const weird = "line1\nline2=with=equals";
    const d = computeDelta(capture({ WEIRD: weird }, {}), cfg);
    eq(d.replace.get("WEIRD"), weird);
  });

  console.log("\nrenderDelta");

  await test("renders a shell-readable summary", () => {
    const d = computeDelta(capture({ PATH: "/nix/a:/usr/bin", CC: "gcc", out: "/x" }, { PATH: "/usr/bin" }), cfg);
    const text = renderDelta(d, "default");
    ok(text.includes('CC="gcc"'), "exported variables should be quoted");
    ok(text.includes("$PATH"), "prepends should be shown as an extension of the existing value");
    ok(text.includes("out"), "filtered variables should be listed");
  });
}
