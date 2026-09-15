/**
 * A `vscode` stand-in complete enough to run `activate()` end to end.
 *
 * An activation crash takes the whole extension out, and a typecheck cannot catch one --
 * a reference to a variable that a mid-edit build left undeclared type-checks fine in the
 * source it was never built from. Actually executing the bundle does catch it.
 */
export class CancellationError extends Error {}

export const recorded = {
  commands: [] as string[],
  contexts: {} as Record<string, unknown>,
  statusText: [] as string[],
  resolverPrefix: undefined as string | undefined,
  labelFormatter: false,
  infoMessages: [] as string[],
};

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

class FileSystemWatcher {
  onDidChange(): { dispose(): void } {
    return { dispose() {} };
  }
  onDidCreate(): { dispose(): void } {
    return { dispose() {} };
  }
  onDidDelete(): { dispose(): void } {
    return { dispose() {} };
  }
  dispose(): void {}
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
  createFileSystemWatcher: () => new FileSystemWatcher(),
  getWorkspaceFolder: () => undefined,
  openTextDocument: async () => ({}),
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
  createTerminal: () => ({ show() {}, sendText() {} }),
  showInformationMessage: async (m: string) => {
    recorded.infoMessages.push(m);
    return undefined;
  },
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showTextDocument: async () => ({}),
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
