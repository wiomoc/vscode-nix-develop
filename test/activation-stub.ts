/** A `vscode` stand-in complete enough to run `activate()` end to end. */
export class CancellationError extends Error {}

export const recorded = {
  commands: [] as string[],
  contexts: {} as Record<string, unknown>,
  statusText: [] as string[],
  resolverPrefix: undefined as string | undefined,
  labelFormatter: false,
  infoMessages: [] as string[],
  terminals: [] as FakeTerminal[],
  watchers: [] as FileSystemWatcher[],
  executed: [] as string[],
  openedDocuments: [] as unknown[],
  shownDocuments: [] as { doc: unknown; options?: unknown }[],
  errorMessages: [] as { message: string; modal: boolean; items: string[] }[],
  warningMessages: [] as { message: string; items: string[] }[],
};

/** What the user "clicks"; `undefined` (dismissed) unless a test says otherwise. */
export const answers = {
  errorMessage: undefined as
    | ((message: string, items: string[]) => string | undefined)
    | undefined,
  warningMessage: undefined as
    | ((message: string, items: string[]) => string | undefined)
    | undefined,
};

export class EventEmitter<T> {
  private listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(value: T): void {
    for (const l of [...this.listeners]) l(value);
  }
  /** How many handlers are attached; lets a test see that a subscription was made. */
  count(): number {
    return this.listeners.length;
  }
  dispose(): void {
    this.listeners = [];
  }
}

interface FakePty {
  onDidWrite: (listener: (s: string) => void) => { dispose(): void };
  open?: (dims?: { columns: number; rows: number }) => void;
  setDimensions?: (dims: { columns: number; rows: number }) => void;
  close?: () => void;
}

/**
 * A terminal that renders only when a test calls `attach()`, which subscribes to
 * `onDidWrite` and then calls `open()`, in the real editor's order.
 */
export class FakeTerminal {
  output: string[] = [];
  shown = 0;
  preserveFocus: boolean | undefined;
  disposed = false;

  constructor(public options: { name: string; pty: FakePty }) {
    recorded.terminals.push(this);
  }

  attach(columns = 80, rows = 24): void {
    this.options.pty.onDidWrite((s) => this.output.push(s));
    this.options.pty.open?.({ columns, rows });
  }

  /** What VS Code does when the user drags the panel wider. */
  resize(columns: number, rows: number): void {
    this.options.pty.setDimensions?.({ columns, rows });
  }

  /** What the user sees, with the escape codes the terminal would have consumed removed. */
  text(): string {
    return this.output.join("").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }

  closedByUser(): void {
    this.options.pty.close?.();
  }

  show(preserveFocus?: boolean): void {
    this.shown++;
    this.preserveFocus = preserveFocus;
  }
  sendText(): void {}
  dispose(): void {
    this.disposed = true;
    this.options.pty.close?.();
  }
}

class Channel {
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  show(): void {}
  dispose(): void {}
}

class StatusBarItem {
  name = "";
  text = "";
  tooltip: unknown;
  command: unknown;
  backgroundColor: unknown;
  show(): void {
    recorded.statusText.push(this.text);
  }
  hide(): void {}
  dispose(): void {}
}

/** A watcher a test can fire events at. */
export class FileSystemWatcher {
  readonly changed = new EventEmitter<{ fsPath: string }>();
  readonly created = new EventEmitter<{ fsPath: string }>();
  readonly deleted = new EventEmitter<{ fsPath: string }>();
  disposed = false;

  constructor(public pattern?: unknown) {
    recorded.watchers.push(this);
  }

  onDidChange(listener: (uri: { fsPath: string }) => void): { dispose(): void } {
    return this.changed.event(listener);
  }
  onDidCreate(listener: (uri: { fsPath: string }) => void): { dispose(): void } {
    return this.created.event(listener);
  }
  onDidDelete(listener: (uri: { fsPath: string }) => void): { dispose(): void } {
    return this.deleted.event(listener);
  }
  dispose(): void {
    this.disposed = true;
    this.changed.dispose();
    this.created.dispose();
    this.deleted.dispose();
  }
}

export class ThemeIcon {
  constructor(public id: string) {}
}
export class ThemeColor {
  constructor(public id: string) {}
}
export class MarkdownString {
  constructor(public value?: string) {}
}
export class Position {
  constructor(
    public line: number,
    public character: number,
  ) {}
}
export class Range {
  constructor(
    public start: Position,
    public end: Position,
  ) {}
}
export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}

export const Uri = {
  file: (p: string) => makeUri("file", "", p),
  parse: (s: string) => makeUri("file", "", s),
  from: (parts: { scheme: string; authority?: string; path?: string }) =>
    makeUri(parts.scheme, parts.authority ?? "", parts.path ?? ""),
};

function makeUri(scheme: string, authority: string, p: string) {
  return {
    scheme,
    authority,
    path: p,
    fsPath: p,
    toString: () => `${scheme}://${authority}${p}`,
    with(change: Record<string, string>) {
      return makeUri(change.scheme ?? scheme, change.authority ?? authority, change.path ?? p);
    },
  };
}

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export const ExtensionKind = { UI: 1, Workspace: 2 };
export const QuickPickItemKind = { Separator: -1, Default: 0 };

/** Settings the fake workspace reports; tests set this before activating. */
export const settings: Record<string, unknown> = {};

export const workspace = {
  workspaceFolders: undefined as unknown,
  getConfiguration: (section: string) => ({
    get: <T>(key: string, fallback: T): T => (settings[`${section}.${key}`] as T) ?? fallback,
    update: async (key: string, value: unknown) => {
      settings[`${section}.${key}`] = value;
    },
  }),
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
  createFileSystemWatcher: (pattern?: unknown) => new FileSystemWatcher(pattern),
  getWorkspaceFolder: () => undefined,
  openTextDocument: async (arg: unknown) => {
    recorded.openedDocuments.push(arg);
    return { uri: arg };
  },
  registerRemoteAuthorityResolver: (prefix: string) => {
    recorded.resolverPrefix = prefix;
    return { dispose() {} };
  },
  registerResourceLabelFormatter: () => {
    recorded.labelFormatter = true;
    return { dispose() {} };
  },
};

export const window = {
  createOutputChannel: () => new Channel(),
  createStatusBarItem: () => new StatusBarItem(),
  createTerminal: (options: { name: string; pty: FakePty }) => new FakeTerminal(options),
  showInformationMessage: async (m: string) => {
    recorded.infoMessages.push(m);
    return undefined;
  },
  showWarningMessage: async (message: string, ...items: string[]) => {
    recorded.warningMessages.push({ message, items });
    return answers.warningMessage?.(message, items);
  },
  // `(message, options?, ...items)`: split off a `MessageOptions` so `items` are the buttons.
  showErrorMessage: async (
    message: string,
    ...rest: (string | { modal?: boolean })[]
  ) => {
    const options = typeof rest[0] === "object" ? rest[0] : undefined;
    const items = (options ? rest.slice(1) : rest) as string[];
    recorded.errorMessages.push({ message, modal: options?.modal === true, items });
    return answers.errorMessage?.(message, items);
  },
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showTextDocument: async (doc: unknown, options?: unknown) => {
    recorded.shownDocuments.push({ doc, options });
    return {};
  },
  withProgress: async <T>(_o: unknown, task: (p: unknown, t: unknown) => Promise<T>) =>
    task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
  activeTextEditor: undefined,
};

export const commands = {
  registerCommand: (id: string) => {
    recorded.commands.push(id);
    return { dispose() {} };
  },
  executeCommand: async (id: string, ...args: unknown[]) => {
    recorded.executed.push(id);
    if (id === "setContext") recorded.contexts[String(args[0])] = args[1];
    return undefined;
  },
};

export const version = "1.106.2";

export const env = {
  remoteAuthority: undefined as string | undefined,
  // Settable: product detection reads product.json from here.
  appRoot: undefined as string | undefined,
  appCommit: "1e3c50d64110be466c0b4a45222e81d2c9352888",
  appQuality: "stable",
  openExternal: async () => true,
  clipboard: { writeText: async () => undefined },
};

export const extensions = { all: [] as unknown[] };

export class RemoteAuthorityResolverError extends Error {
  static NotAvailable(message?: string) {
    return new RemoteAuthorityResolverError(message);
  }
  static TemporarilyNotAvailable(message?: string) {
    return new RemoteAuthorityResolverError(message);
  }
}

export class ResolvedAuthority {
  constructor(
    public host: string,
    public port: number,
    public connectionToken?: string,
  ) {}
}
