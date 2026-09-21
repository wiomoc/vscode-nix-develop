import { eq, ok, test } from "./harness";
import { FakeTerminal, window as stubWindow } from "./activation-stub";
import {
  canWatchTerminalData,
  forgetTerminalData,
  watchTerminalData,
} from "../src/utils/terminal-data";

/**
 * Reading a terminal's output back.
 *
 * `onDidWriteTerminalData` is a proposed API, and the point of these is that the extension
 * host loading this module is the extension host that opens windows: every way of not
 * having the proposal has to end in `false` rather than a throw, because the answer
 * decides whether the build gets a terminal or a pipe -- not whether the window opens.
 */
export async function run(): Promise<void> {
  console.log("\nterminal output");

  const real = stubWindow.onDidWriteTerminalData;
  const setEvent = (value: unknown) => {
    (stubWindow as { onDidWriteTerminalData?: unknown }).onDidWriteTerminalData = value;
  };

  await test("an editor that dropped the proposal reports no data", () => {
    forgetTerminalData();
    setEvent(undefined);
    eq(canWatchTerminalData(), false, "a missing property is an answer, not an error");
  });

  await test("a proposal that is not enabled reports no data", () => {
    forgetTerminalData();
    setEvent(() => {
      throw new Error("Proposed API is only available when running out of dev");
    });
    eq(canWatchTerminalData(), false, "the throw happens inside the subscribe, and is caught");
  });

  await test("the answer is remembered, so the probe subscribes once", () => {
    forgetTerminalData();
    setEvent(undefined);
    eq(canWatchTerminalData(), false);
    setEvent(real);
    eq(canWatchTerminalData(), false, "a second call must not re-probe");
  });

  await test("with the proposal, only the watched terminal's output arrives", () => {
    forgetTerminalData();
    setEvent(real);
    const mine = new FakeTerminal({ name: "nix develop: default" });
    const other = new FakeTerminal({ name: "someone else's" });

    const seen: string[] = [];
    const sub = watchTerminalData(mine as never, (chunk) => seen.push(chunk));
    ok(sub !== undefined, "the editor reports data, so there should be a subscription");

    other.write("ls -la\r\n");
    mine.write("copying path 'hello'\r\n");
    sub!.dispose();
    mine.write("after the subscription went");

    eq(seen, ["copying path 'hello'\r\n"]);
  });

  setEvent(real);
  forgetTerminalData();
}
