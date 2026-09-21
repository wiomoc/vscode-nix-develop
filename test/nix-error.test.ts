import { describe, expect, it } from "vitest";
import { isEvaluationError, nixErrorSummary } from "../src/nix";

/**
 * Whether a failed resolve is worth another attempt. VS Code retries a
 * `TemporarilyNotAvailable` on its own, so misreading a broken flake as transient is a
 * loop, and misreading a flaky download as final costs a window that would have recovered.
 */

describe("failure classification", () => {
  it("a missing devShell is final", () => {
    expect(
      isEvaluationError({
        stderr:
          "error: flake 'git+file:///w/proj' does not provide attribute " +
          "'devShells.x86_64-linux.nope'",
      }),
      "no retry can conjure the attribute",
    ).toBe(true);
  });

  it("a flake that does not parse is final", () => {
    expect(
      isEvaluationError({
        stderr:
          "error: syntax error, unexpected end of file, expecting '}'\n" +
          "       at /w/proj/flake.nix:12:1:",
      }),
    ).toBe(true);
  });

  it("it reads Nix's drawn output too, bar and colours and all", () => {
    expect(
      isEvaluationError({
        stderr:
          "\u001b[32m\u2713\u001b[0m evaluating flake\r\u001b[K" +
          "\u001b[31;1merror:\u001b[0m undefined variable 'mkShel'\r\n",
      }),
      "the pty path escapes and redraws the same message",
    ).toBe(true);
  });

  it("an untracked flake.nix is final, since Nix never saw the file", () => {
    expect(
      isEvaluationError({
        stderr:
          "error: path '/w/proj/flake.nix' does not exist; " +
          "does not contain a 'flake.nix'",
      }),
    ).toBe(true);
  });

  it("no flake.nix to evaluate at all is final", () => {
    // Nix stops before it has a flake to fail in, so this one says nothing about
    // attributes or syntax -- it is the plainest form of the same verdict.
    expect(isEvaluationError({ stderr: "error: could not find a flake.nix file" })).toBe(true);
  });

  it("a builder failure is retryable, whatever its log says", () => {
    expect(
      !isEvaluationError({
        stderr:
          "error: builder for '/nix/store/abc.drv' failed with exit code 1;\n" +
          "       last 10 log lines:\n" +
          "       > main.c:3:1: error: syntax error before '}' token",
      }),
      "a compiler saying 'syntax error' is not the flake failing to evaluate",
    ).toBe(true);
  });

  it("a download that did not arrive is retryable", () => {
    expect(
      isEvaluationError({
        stderr: "error: unable to download 'https://cache.nixos.org/x.narinfo': Couldn't connect to server (7)",
      }),
    ).toBe(false);
  });

  it("a timed-out build is retryable", () => {
    expect(isEvaluationError(new Error("Timed out after 300s"))).toBe(false);
  });

  it("the server's own exit message carries the evaluation failure with it", () => {
    // What the resolver actually catches when the capture is switched off: the failure
    // reaches it wrapped in the message `awaitListening` rejects with.
    expect(
      isEvaluationError(
        new Error(
          "the server exited with code 1 before listening.\n" +
            "error: attribute 'devShells' missing\n       at /w/proj/flake.nix:4:5",
        ),
      ),
    ).toBe(true);
  });

  it("the summary is one line, starting at what Nix complained about", () => {
    const summary = nixErrorSummary({
      stderr:
        "warming up\nerror:\n       \u2026 while evaluating the attribute 'devShells'\n" +
        "       error: attribute 'mkShel' missing",
    });
    expect(summary?.startsWith("error:"), `expected it to start at the error, got: ${summary}`).toBe(true);
    expect(summary?.includes("\n"), "a dialog shows one line, not a log").toBe(false);
    expect(summary, "the cause beneath the trace is the point").toContain("attribute 'mkShel' missing");
  });

  it("nothing to summarise is nothing, not an empty string", () => {
    expect(nixErrorSummary(new Error("the server did not report a listening port"))).toEqual(undefined);
  });
});
