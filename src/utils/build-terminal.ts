import * as vscode from "vscode";

/**
 * Output kept for replay until VS Code first renders the terminal (which it only does
 * once shown). A tail, since the end is where the error is.
 */
const BACKLOG_LIMIT = 512 * 1024;

/**
 * Convert bare `\n` to `\r\n`, so pipe output does not stair-step. A lone `\r` is kept for
 * progress bar redraws.
 */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/**
 * The terminal that shows what `nix develop` is doing: Nix's output only, unmodified.
 *
 * A `Pseudoterminal` rather than an `OutputChannel`, because it renders ANSI escapes and
 * carriage returns. It has no pty itself; `dimensions` tells the process on the other
 * end how wide it is. Closing it does not cancel the build.
 */
export class BuildTerminal implements vscode.Disposable {
  private readonly writer = new vscode.EventEmitter<string>();
  private readonly resizer = new vscode.EventEmitter<{ columns: number; rows: number }>();
  private readonly terminal: vscode.Terminal;
  private backlog = "";
  private live = false;
  private closed = false;

  /** The rendered size, for laying out Nix's progress bar; `undefined` until first shown. */
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
