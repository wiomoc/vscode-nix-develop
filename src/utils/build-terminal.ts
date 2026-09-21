import * as vscode from "vscode";

/**
 * How much output a terminal that has not been rendered yet keeps.
 *
 * VS Code does not attach a renderer -- and so does not start delivering `onDidWrite` --
 * until the terminal is first shown, and `showBuildOutput: onFailure` means that may never
 * happen until the build has already failed. Everything written before then is held so it
 * can be replayed into an empty terminal. A cold `nix develop` on a large flake writes tens
 * of megabytes, which is not worth holding in the extension host for output nobody may ever
 * look at, so the backlog is a tail: the beginning is dropped, because the end is where the
 * error is.
 */
const BACKLOG_LIMIT = 512 * 1024;

/**
 * A terminal is a hardware teletype as far as the process on the other end is concerned:
 * a bare newline moves down a row and leaves the cursor where it was. A pty converts for
 * its child, so output that came through one already ends its lines correctly and this
 * changes nothing; output from a plain pipe carries Unix line endings and would otherwise
 * stair-step across the terminal. A lone `\r` is left alone either way -- that is how the
 * progress bar redraws its line.
 */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/**
 * The terminal that shows what `nix develop` is doing.
 *
 * Building a devShell is the slow, opaque part of opening a window: it downloads, it
 * compiles, and when a flake does not evaluate it fails with a message that says where.
 * None of that reached the user before -- the resolver ran Nix with its output piped into a
 * one-line progress notification, and a failure arrived as a single collapsed sentence.
 *
 * This is a `Pseudoterminal`, not an `OutputChannel`, because it interprets ANSI and an
 * output channel does not: escape codes would be printed literally there, and a carriage
 * return would not return anything. Nix writes both -- its progress bar is nothing but --
 * once it is given a terminal to write to, which `loadPty` is what arranges. This end of
 * the arrangement only renders; it is an event emitter VS Code draws, with no pty of its
 * own, which is why `dimensions` exists to tell the other end how wide it is.
 *
 * Nothing else is written into it. The extension has a log channel and a progress
 * notification for what it has to say; this terminal is Nix's output and nothing but, so
 * what is on screen is what the same command would have printed in a shell.
 *
 * Nothing here is interactive either. Closing the terminal does not cancel the build -- the
 * server start does its own `nix develop`, so a cancelled capture would be rebuilt seconds
 * later -- it only stops the output going anywhere.
 */
export class BuildTerminal implements vscode.Disposable {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly resizer = new vscode.EventEmitter<{ columns: number; rows: number }>();
  private readonly terminal: vscode.Terminal;
  private backlog = "";
  private live = false;
  private closed = false;

  /**
   * How wide the terminal is, once anything has rendered it.
   *
   * Nix lays its progress bar out for the width it is told about when it starts, so the
   * process writing here wants the real one rather than a guess. `undefined` until VS Code
   * renders the terminal, which with `showBuildOutput: onFailure` may be never.
   */
  private size: { columns: number; rows: number } | undefined;

  constructor(name: string) {
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writer.event,
      // VS Code subscribes to `onDidWrite` before calling this, so the replay lands.
      open: (dimensions) => {
        this.live = true;
        if (dimensions) this.setSize(dimensions);
        if (this.backlog) {
          this.writer.fire(this.backlog);
          this.backlog = "";
        }
      },
      setDimensions: (dimensions) => this.setSize(dimensions),
      // Fired both when the user closes the terminal and when `dispose` does.
      close: () => {
        this.closed = true;
        this.backlog = "";
      },
    };
    this.terminal = vscode.window.createTerminal({
      name,
      pty,
      iconPath: new vscode.ThemeIcon("tools"),
      // A terminal whose process was a build that finished long ago has nothing to restore.
      isTransient: true,
    });
  }

  /** The terminal's current size, or nothing if it has not been rendered. */
  get dimensions(): { columns: number; rows: number } | undefined {
    return this.size;
  }

  /** Size changes, for a child that lays its output out to the width it was given. */
  get onDidChangeDimensions(): vscode.Event<{ columns: number; rows: number }> {
    return this.resizer.event;
  }

  private setSize(dimensions: vscode.TerminalDimensions): void {
    const next = { columns: dimensions.columns, rows: dimensions.rows };
    if (this.size?.columns === next.columns && this.size?.rows === next.rows) return;
    this.size = next;
    this.resizer.fire(next);
  }

  /** Raw bytes as Nix wrote them, escape codes and all. */
  write(chunk: string): void {
    if (this.closed || !chunk) return;
    const text = toCrlf(chunk);
    if (this.live) {
      this.writer.fire(text);
      return;
    }
    this.backlog += text;
    if (this.backlog.length > BACKLOG_LIMIT) {
      this.backlog = this.backlog.slice(-BACKLOG_LIMIT);
    }
  }

  /** Bring the terminal into view without taking the keyboard away from the editor. */
  reveal(): void {
    if (this.closed) return;
    this.terminal.show(true);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.terminal.dispose();
    this.writer.dispose();
    this.resizer.dispose();
  }
}
