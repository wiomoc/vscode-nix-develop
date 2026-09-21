import { recorded } from "./activation-stub";
import { BuildTerminal, toCrlf } from "../src/utils/build-terminal";
import { describe, expect, it } from "vitest";

/**
 * The terminal that shows `nix develop` building.
 *
 * Two things about it are easy to get wrong and invisible until a user is watching a build
 * fail: output written before VS Code renders the terminal, and Unix line endings arriving
 * at something that moves the cursor down but not back.
 */
describe("build terminal", () => {
  it("bare newlines become CRLF, so lines start at column one", () => {
    expect(toCrlf("one\ntwo\n")).toEqual("one\r\ntwo\r\n");
  });

  it("CRLF is left as it is rather than doubled", () => {
    expect(toCrlf("one\r\ntwo")).toEqual("one\r\ntwo");
  });

  it("a lone carriage return survives: it is how the progress bar redraws", () => {
    expect(toCrlf("[1/5] building\r[2/5] building")).toEqual("[1/5] building\r[2/5] building");
  });

  it("output written before the terminal is rendered is replayed into it", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    build.write("copying path 'hello'\n");
    build.write("error: attribute 'foo' missing\n");

    const term = recorded.terminals[0];
    expect(term !== undefined, "a terminal should have been created").toBe(true);
    expect(term.output.length, "nothing is delivered before VS Code attaches a renderer").toEqual(0);

    term.attach();
    expect(term.text()).toEqual("copying path 'hello'\r\nerror: attribute 'foo' missing\r\n");
  });

  it("once rendered, output goes straight through", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    const term = recorded.terminals[0];
    term.attach();
    build.write("building\n");
    expect(term.text()).toEqual("building\r\n");
  });

  it("a terminal the user closed is not written to again", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    const term = recorded.terminals[0];
    term.attach();
    term.closedByUser();
    build.write("still building\n");
    // Not an error, and not a resurrected terminal: the build simply stops being shown.
    expect(term.text()).toEqual("");
    build.reveal();
    expect(term.shown, "revealing a closed terminal would fail").toEqual(0);
  });

  it("the terminal reports its size, so the child can lay out for it", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    // Nothing has rendered it yet, so there is no size to report and the caller must guess.
    expect(build.dimensions).toEqual(undefined);

    recorded.terminals[0].attach(140, 40);
    expect(build.dimensions).toEqual({ columns: 140, rows: 40 });
  });

  it("a resize is announced, so a running build can reflow to match", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    const seen: { columns: number; rows: number }[] = [];
    build.onDidChangeDimensions((d) => seen.push(d));

    const term = recorded.terminals[0];
    term.attach(100, 30);
    term.resize(200, 30);
    // VS Code re-announces the size on every layout pass; only real changes are passed on.
    term.resize(200, 30);

    expect(seen).toEqual([
      { columns: 100, rows: 30 },
      { columns: 200, rows: 30 },
    ]);
    expect(build.dimensions).toEqual({ columns: 200, rows: 30 });
  });

  it("reveal does not take focus from the editor", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    build.reveal();
    expect(recorded.terminals[0].shown).toEqual(1);
    expect(recorded.terminals[0].preserveFocus, "a build starting must not steal the cursor").toEqual(true);
  });
});
