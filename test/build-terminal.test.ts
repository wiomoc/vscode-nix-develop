import { eq, ok, test } from "./harness";
import { recorded } from "./activation-stub";
import { BuildTerminal, toCrlf } from "../src/utils/build-terminal";

/**
 * The terminal that shows `nix develop` building.
 *
 * Two things about it are easy to get wrong and invisible until a user is watching a build
 * fail: output written before VS Code renders the terminal, and Unix line endings arriving
 * at something that moves the cursor down but not back.
 */
export async function run(): Promise<void> {
  console.log("\nbuild terminal");

  await test("bare newlines become CRLF, so lines start at column one", () => {
    eq(toCrlf("one\ntwo\n"), "one\r\ntwo\r\n");
  });

  await test("CRLF is left as it is rather than doubled", () => {
    eq(toCrlf("one\r\ntwo"), "one\r\ntwo");
  });

  await test("a lone carriage return survives: it is how the progress bar redraws", () => {
    eq(toCrlf("[1/5] building\r[2/5] building"), "[1/5] building\r[2/5] building");
  });

  await test("output written before the terminal is rendered is replayed into it", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    build.write("copying path 'hello'\n");
    build.write("error: attribute 'foo' missing\n");

    const term = recorded.terminals[0];
    ok(term !== undefined, "a terminal should have been created");
    eq(term.output.length, 0, "nothing is delivered before VS Code attaches a renderer");

    term.attach();
    eq(term.text(), "copying path 'hello'\r\nerror: attribute 'foo' missing\r\n");
  });

  await test("once rendered, output goes straight through", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    const term = recorded.terminals[0];
    term.attach();
    build.write("building\n");
    eq(term.text(), "building\r\n");
  });

  await test("a terminal the user closed is not written to again", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    const term = recorded.terminals[0];
    term.attach();
    term.closedByUser();
    build.write("still building\n");
    // Not an error, and not a resurrected terminal: the build simply stops being shown.
    eq(term.text(), "");
    build.reveal();
    eq(term.shown, 0, "revealing a closed terminal would fail");
  });

  await test("the terminal reports its size, so the child can lay out for it", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    // Nothing has rendered it yet, so there is no size to report and the caller must guess.
    eq(build.dimensions, undefined);

    recorded.terminals[0].attach(140, 40);
    eq(build.dimensions, { columns: 140, rows: 40 });
  });

  await test("a resize is announced, so a running build can reflow to match", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    const seen: { columns: number; rows: number }[] = [];
    build.onDidChangeDimensions((d) => seen.push(d));

    const term = recorded.terminals[0];
    term.attach(100, 30);
    term.resize(200, 30);
    // VS Code re-announces the size on every layout pass; only real changes are passed on.
    term.resize(200, 30);

    eq(seen, [
      { columns: 100, rows: 30 },
      { columns: 200, rows: 30 },
    ]);
    eq(build.dimensions, { columns: 200, rows: 30 });
  });

  await test("reveal does not take focus from the editor", () => {
    recorded.terminals.length = 0;
    const build = new BuildTerminal("nix develop: default");
    build.reveal();
    eq(recorded.terminals[0].shown, 1);
    eq(recorded.terminals[0].preserveFocus, true, "a build starting must not steal the cursor");
  });
}
